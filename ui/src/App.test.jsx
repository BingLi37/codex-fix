// Interaction tests for the dashboard. These cover the wiring that a rendering
// check cannot: buttons calling the right endpoint, filters narrowing the feed,
// and the modal showing command output.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

const HISTORY = [
  { at: '2026-08-23T03:00:00.000Z', kind: 'listening', level: 'info', port: 7801, upstream: 'https://agentrouter.org', pid: 111 },
  { at: '2026-08-23T03:00:01.000Z', kind: 'request', level: 'info', reqId: 1, method: 'POST', url: '/v1/responses', bytes: 1200 },
  {
    at: '2026-08-23T03:00:02.000Z', kind: 'repair', level: 'fix', reqId: 1, phase: 'request', ids: 1, refs: 0,
    pairs: [{ from: 'fc_abc123', to: 'ctc_abc123', name: 'exec' }],
  },
  { at: '2026-08-23T03:00:03.000Z', kind: 'response', level: 'info', reqId: 1, status: 200, stream: true, viaProxy: true },
  { at: '2026-08-23T03:00:04.000Z', kind: 'error', level: 'error', reqId: 2, where: 'upstream', status: 404, body: '{"error":"Invalid URL"}' },
  {
    at: '2026-08-23T03:00:05.000Z', kind: 'history', level: 'warn', reqId: 3,
    message: '这次请求里没有它要的那个 reasoning 项（rs_xyz）。',
    callId: 'fc_abc', reasoningId: 'rs_xyz',
    callPresent: true, reasoningPresent: false,
    callPosition: 1, reasoningPosition: null, reasoningHasEncryptedContent: null,
    itemCounts: { message: 1, function_call: 1 },
  },
];

const STATUS = {
  running: true, listening: true, pid: 111, proxyPort: 7801, panelPort: 7800,
  systemProxy: 'http://127.0.0.1:7897',
  health: {
    ok: true, upstream: 'https://agentrouter.org/v1', relay: 'agentrouter',
    started: '2026-08-23T03:00:00.000Z', requests: 7, idsFixed: 3, refsFixed: 1, lastFix: '2026-08-23T03:00:02.000Z',
  },
  codex: { baseUrl: 'http://127.0.0.1:7801/v1', expected: 'http://127.0.0.1:7801/v1', wired: true },
  active: 'agentrouter',
  relays: [
    { id: 'agentrouter', name: 'agentrouter', baseUrl: 'https://agentrouter.org/v1', hasApiKey: false },
    { id: 'backup', name: '备用站', baseUrl: 'https://backup.example.com/api/v3', hasApiKey: true },
  ],
};

let posted;

beforeEach(() => {
  posted = [];
  // EventSource is not needed for these assertions; history drives the feed.
  class StubEventSource { constructor() { this.onopen = null; } close() {} }
  vi.stubGlobal('EventSource', StubEventSource);
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (init?.method === 'POST') {
      posted.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url.startsWith('/api/selftest')) return { json: async () => ({ ok: true, output: 'all tests passed' }) };
      if (url.startsWith('/api/scan')) return { json: async () => ({ ok: true, output: 'DRY RUN  files=0  ids=0' }) };
      if (url.startsWith('/api/relays/test')) return { json: async () => ({ ok: true, output: '结果: HTTP 401' }) };
      if (url.startsWith('/api/relays/save')) return { json: async () => ({ ok: false, error: 'Base URL 格式不对，需要以 http:// 或 https:// 开头' }) };
      return { json: async () => ({ ok: true }) };
    }
    if (url.startsWith('/api/status')) return { json: async () => STATUS };
    if (url.startsWith('/api/history')) return { json: async () => ({ events: HISTORY }) };
    return { json: async () => ({}) };
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const feed = () => document.querySelector('ol');
const urls = () => posted.map((p) => p.url);
const rows = () => feed()?.querySelectorAll('li') ?? [];

describe('dashboard', () => {
  it('shows live status and repaired id pairs', async () => {
    render(<App />);
    expect(await screen.findByText('正在运行')).toBeTruthy();
    await waitFor(() => expect(rows().length).toBe(HISTORY.length));
    // The before/after pair is the whole point of the feed.
    expect(screen.getByText('fc_abc123')).toBeTruthy();
    expect(screen.getByText('ctc_abc123')).toBeTruthy();
    expect(screen.getByText('已接入')).toBeTruthy();
  });

  it('explains a tool call missing its reasoning item', async () => {
    render(<App />);
    await waitFor(() => expect(rows().length).toBe(HISTORY.length));
    expect(screen.getByText(/没有它要的那个 reasoning 项/)).toBeTruthy();
    // The diagnosis must state whether the item the relay wanted was present.
    expect(screen.getByText((t) => t.includes('rs_xyz') && t.includes('不在请求里'))).toBeTruthy();
  });

  it('surfaces the upstream error body in the error panel', async () => {
    render(<App />);
    await waitFor(() => expect(rows().length).toBe(HISTORY.length));
    // The same error also appears in the feed, so scope to the error panel.
    const panel = screen.getByTestId('error-panel');
    expect(within(panel).getByText('upstream · HTTP 404')).toBeTruthy();
    expect(within(panel).getByText(/"error":"Invalid URL"/)).toBeTruthy();
  });

  it('filters the feed down to repairs', async () => {
    render(<App />);
    await waitFor(() => expect(rows().length).toBe(HISTORY.length));
    await userEvent.click(screen.getByRole('tab', { name: /修正/ }));
    await waitFor(() => expect(rows().length).toBe(1));
    expect(within(feed()).getByText(/在发出前修正 1 个 id/)).toBeTruthy();
  });

  it('clears the feed view', async () => {
    render(<App />);
    await waitFor(() => expect(rows().length).toBe(HISTORY.length));
    await userEvent.click(screen.getByRole('button', { name: '清空视图' }));
    await waitFor(() => expect(rows().length).toBe(0));
  });

  it('runs the self test and shows its output in a dialog', async () => {
    render(<App />);
    await waitFor(() => expect(rows().length).toBe(HISTORY.length));
    await userEvent.click(screen.getByRole('button', { name: '运行自检' }));
    await waitFor(() => expect(urls()).toContain('/api/selftest'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/all tests passed/)).toBeTruthy();
  });

  // Overlay hygiene. A backdrop that does not contain the dialog is the empty
  // second overlay react-aria creates when Container and Backdrop are siblings;
  // it stays on screen after closing and blocks every click on the page.
  const backdrops = () => [...document.querySelectorAll('[data-slot="modal-backdrop"]')];
  const containers = () => document.querySelectorAll('[data-slot="modal-container"]');

  it('renders one backdrop that actually contains the dialog', async () => {
    render(<App />);
    await waitFor(() => expect(rows().length).toBe(HISTORY.length));
    await userEvent.click(screen.getByRole('button', { name: '运行自检' }));
    const dialog = await screen.findByRole('dialog');
    expect(backdrops().length).toBe(1);
    expect(backdrops()[0].contains(dialog)).toBe(true);
  });

  it('leaves no overlay behind after closing', async () => {
    render(<App />);
    await waitFor(() => expect(rows().length).toBe(HISTORY.length));
    await userEvent.click(screen.getByRole('button', { name: '运行自检' }));
    const opened = await screen.findByRole('dialog');
    await userEvent.click(within(opened).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(backdrops().length).toBe(0);
    expect(containers().length).toBe(0);
  });

  it('leaves no overlay behind after closing the relay dialog', async () => {
    render(<App />);
    await screen.findByText('正在运行');
    await userEvent.click(screen.getByRole('button', { name: /中转站/ }));
    const relay = await screen.findByTestId('relay-dialog');
    expect(backdrops().length).toBe(1);
    expect(backdrops()[0].contains(relay)).toBe(true);
    await userEvent.click(within(relay).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByTestId('relay-dialog')).toBeNull());
    expect(backdrops().length).toBe(0);
  });

  // A modal that cannot be dismissed leaves the backdrop blocking the whole UI.
  it('closes the dialog from the footer button', async () => {
    render(<App />);
    await waitFor(() => expect(rows().length).toBe(HISTORY.length));
    await userEvent.click(screen.getByRole('button', { name: '运行自检' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The page must be interactive again afterwards.
    await userEvent.click(screen.getByRole('button', { name: '清空视图' }));
    await waitFor(() => expect(rows().length).toBe(0));
  });

  it('closes the dialog with Escape', async () => {
    render(<App />);
    await waitFor(() => expect(rows().length).toBe(HISTORY.length));
    await userEvent.click(screen.getByRole('button', { name: '运行自检' }));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('start is disabled while running, stop is not', async () => {
    render(<App />);
    await screen.findByText('正在运行');
    expect(screen.getByRole('button', { name: '启动' }).getAttribute('disabled')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '停止' }));
    await waitFor(() => expect(urls()).toContain('/api/stop'));
  });

  it('asks for confirmation before repairing session files', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<App />);
    await screen.findByText('正在运行');
    await userEvent.click(screen.getByRole('button', { name: '修复历史会话' }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(urls()).not.toContain('/api/scan?apply=1');

    confirmSpy.mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: '修复历史会话' }));
    await waitFor(() => expect(urls()).toContain('/api/scan?apply=1'));
  });

  it('warns when Codex is not pointed at the proxy', async () => {
    STATUS.codex = { baseUrl: 'https://agentrouter.org/v1', expected: 'http://127.0.0.1:7801/v1', wired: false };
    render(<App />);
    expect(await screen.findByText('Codex 没有走这个代理')).toBeTruthy();
    STATUS.codex = { baseUrl: 'http://127.0.0.1:7801/v1', expected: 'http://127.0.0.1:7801/v1', wired: true };
  });

  it('warns when relays.json could not be read', async () => {
    STATUS.relayFallback = 'corrupt';
    render(<App />);
    expect(await screen.findByText('正在使用内置的默认中转站')).toBeTruthy();
    expect(screen.getByText(/relays.json 内容不是合法 JSON/)).toBeTruthy();
    delete STATUS.relayFallback;
  });


  // The spinner must appear while the action runs and clear afterwards, and the
  // button must not change width (that shift previously moved other controls).
  it('shows a spinner beside a long action while it runs', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init?.method === 'POST' && url.startsWith('/api/selftest')) {
        await gate;
        return { json: async () => ({ ok: true, output: 'all tests passed' }) };
      }
      return realFetch(url, init);
    }));

    render(<App />);
    await waitFor(() => expect(rows().length).toBe(HISTORY.length));
    const button = screen.getByRole('button', { name: /运行自检/ });
    expect(button.querySelector('[data-slot=spinner-icon]')).toBeNull();

    await userEvent.click(button);
    await waitFor(() => expect(button.querySelector('[data-slot=spinner-icon]')).not.toBeNull());
    // Other actions are locked out while one is running.
    expect(screen.getByRole('button', { name: /扫描历史会话/ }).getAttribute('disabled')).not.toBeNull();

    release();
    await waitFor(() => expect(button.querySelector('[data-slot=spinner-icon]')).toBeNull());
  });


  it('labels a pre-emptive fix from the known-bad list', async () => {
    HISTORY.push({
      at: '2026-08-23T03:00:06.000Z', kind: 'repair', level: 'fix', reqId: 4,
      phase: 'known-bad', ids: 2, refs: 0,
      pairs: [{ from: 'ctc_bad', to: 'ctc_new', name: 'exec' }],
      message: '2 个此前被中转站拒绝过的 id 已提前换掉，省去重试',
    });
    render(<App />);
    await waitFor(() => expect(rows().length).toBe(HISTORY.length));
    expect(screen.getByText(/用记住的黑名单/)).toBeTruthy();
    HISTORY.pop();
  });

  it('shows a rename retry with both ids', async () => {
    HISTORY.push({
      at: '2026-08-23T03:00:07.000Z', kind: 'retry', level: 'warn', reqId: 5,
      reason: 'rejected function_call id', mode: 'rename',
      from: 'ctc_old', to: 'ctc_fresh',
      message: '中转站拒绝了这个 function_call id，已换成新 id 重试（第 1 次）',
    });
    render(<App />);
    await waitFor(() => expect(rows().length).toBe(HISTORY.length));
    expect(screen.getByText(/已换成新 id 重试/)).toBeTruthy();
    HISTORY.pop();
  });

  describe('relays', () => {
    const openRelays = async () => {
      await screen.findByText('正在运行');
      await userEvent.click(screen.getByRole('button', { name: /中转站/ }));
      return screen.findByTestId('relay-dialog');
    };

    it('lists relays and marks the active one', async () => {
      render(<App />);
      const panel = await openRelays();
      expect(within(panel).getByText('agentrouter')).toBeTruthy();
      expect(within(panel).getByText('备用站')).toBeTruthy();
      expect(within(panel).getByText('使用中')).toBeTruthy();
      // A relay with its own key is distinguished from one using Codex's.
      expect(within(panel).getByText('自带 key')).toBeTruthy();
      expect(within(panel).getByText('用 Codex 的 key')).toBeTruthy();
    });

    it('switches to another relay', async () => {
      render(<App />);
      const panel = await openRelays();
      await userEvent.click(within(panel).getByRole('button', { name: '切换' }));
      await waitFor(() => expect(urls()).toContain('/api/relays/activate'));
      expect(posted.find((p) => p.url === '/api/relays/activate').body).toEqual({ id: 'backup' });
    });

    it('runs a connectivity test for a specific relay', async () => {
      render(<App />);
      const panel = await openRelays();
      await userEvent.click(within(panel).getAllByRole('button', { name: '测试' })[1]);
      await waitFor(() => expect(urls()).toContain('/api/relays/test'));
      expect(posted.find((p) => p.url === '/api/relays/test').body).toEqual({ id: 'backup' });
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/HTTP 401/)).toBeTruthy();
    });

    it('shows the server-side validation error when a Base URL is bad', async () => {
      render(<App />);
      const panel = await openRelays();
      await userEvent.click(within(panel).getByRole('button', { name: '添加中转站' }));
      await userEvent.type(within(panel).getByLabelText('名称'), 'x');
      await userEvent.type(within(panel).getByLabelText('Base URL'), 'not-a-url');
      await userEvent.click(within(panel).getByRole('button', { name: '保存' }));
      await waitFor(() => expect(urls()).toContain('/api/relays/save'));
      expect(await screen.findByText(/Base URL 格式不对/)).toBeTruthy();
    });

    it('saving a new relay does not switch to it', async () => {
      render(<App />);
      const panel = await openRelays();
      await userEvent.click(within(panel).getByRole('button', { name: '添加中转站' }));
      await userEvent.type(within(panel).getByLabelText('名称'), 'x');
      await userEvent.type(within(panel).getByLabelText('Base URL'), 'https://ok.example.com/v1');
      await userEvent.click(within(panel).getByRole('button', { name: '保存' }));
      await waitFor(() => expect(urls()).toContain('/api/relays/save'));
      expect(posted.find((p) => p.url === '/api/relays/save').body.activate).toBe(false);
    });

    it('asks before deleting a relay', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      render(<App />);
      const panel = await openRelays();
      await userEvent.click(within(panel).getAllByRole('button', { name: '删除' })[0]);
      expect(confirmSpy).toHaveBeenCalled();
      expect(urls()).not.toContain('/api/relays/delete');
      confirmSpy.mockRestore();
    });
  });
});
