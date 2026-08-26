// Shared presentation helpers for the event feed.

export const KIND_LABEL = {
  request: '请求', response: '响应', repair: '已修正', error: '错误', retry: '降级重试',
  listening: '已启动', stopped: '已停止', done: '完成', control: '操作', connected: '已连接',
  history: '历史异常',
};

// Chip colour per event kind. Only the ones that need emphasis get a colour.
export const KIND_COLOR = {
  repair: 'accent', error: 'danger', retry: 'warning', stopped: 'warning',
  listening: 'success', control: 'success', response: 'default',
  request: 'default', done: 'default', connected: 'default', history: 'warning',
};

const PHASE = {
  request: '发出前',
  stream: '流式响应中',
  response: '响应中',
  'known-bad': '发出前（用记住的黑名单）',
};

export function clockTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '--:--:--'
    : date.toLocaleTimeString('zh-CN', { hour12: false });
}

export function humanDuration(iso) {
  if (!iso) return '–';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours} 小时 ${minutes} 分`;
  if (minutes) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${seconds} 秒`;
}

// One-line summary. Repair pairs are rendered separately by the component.
export function describeEvent(event) {
  const tag = event.reqId ? `#${event.reqId} ` : '';
  switch (event.kind) {
    case 'request':
      return `${tag}${event.method} ${event.url} · ${event.bytes} 字节`;
    case 'response':
      return `${tag}HTTP ${event.status}${event.stream ? ' · 流式' : ''} · ${event.viaProxy ? '经系统代理' : '直连'}`;
    case 'repair': {
      const where = PHASE[event.phase] ?? event.phase;
      const refs = event.refs ? `，同步 ${event.refs} 处引用` : '';
      return `${tag}在${where}修正 ${event.ids} 个 id${refs}`;
    }
    case 'error': {
      const bits = [event.where, event.code, event.status && `HTTP ${event.status}`].filter(Boolean).join(' · ');
      const detail = event.message || (event.body || '').slice(0, 200);
      return `${tag}${bits}${detail ? ' — ' + detail : ''}`;
    }
    case 'retry':
      // Two kinds of retry: falling back to a direct connection, and renaming an
      // id the relay rejected. The latter carries its own message and id pair.
      if (event.mode === 'rename') {
        return `${tag}${event.message ?? '换新 id 重试'}\n${event.from} → ${event.to}`;
      }
      return `${tag}${event.reason} — 改为直连重试`;
    case 'listening':
      return `监听 127.0.0.1:${event.port} → ${event.upstream}${event.systemProxy ? ' 经 ' + event.systemProxy : ' 直连'} · PID ${event.pid}`;
    case 'stopped':
      return `进程退出（${event.reason}）· PID ${event.pid}`;
    case 'done':
      return `${tag}完成${event.streamIds ? `，本次流中修正 ${event.streamIds} 个 id` : ''}`;
    case 'history': {
      // The facts matter more than the prose here: whether the item the relay
      // asked for was actually in the request, and where it sat.
      const facts = [];
      if (event.reasoningId) {
        facts.push(`要的 reasoning: ${event.reasoningId}`);
        facts.push(event.reasoningPresent ? '在请求里' : '不在请求里');
        if (event.reasoningPresent) {
          facts.push(`位置 ${event.reasoningPosition} / 调用位置 ${event.callPosition}`);
          facts.push(event.reasoningHasEncryptedContent ? '带 encrypted_content' : '无 encrypted_content');
        }
      }
      return `${tag}${event.message}${facts.length ? '\n' + facts.join(' · ') : ''}`;
    }
    case 'control':
      return event.message || event.action || '';
    case 'connected':
      return '已连接到面板事件流';
    default:
      return JSON.stringify(event);
  }
}

export const FILTERS = [
  { id: 'all', label: '全部', match: () => true },
  { id: 'fix', label: '修正', match: (e) => e.kind === 'repair' },
  { id: 'error', label: '错误', match: (e) => ['error', 'retry', 'history'].includes(e.kind) },
  { id: 'traffic', label: '请求', match: (e) => ['request', 'response', 'done'].includes(e.kind) },
];
