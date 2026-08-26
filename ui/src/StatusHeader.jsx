import { Chip, Spinner } from '@heroui/react';

function Lamp({ state }) {
  const tone = state === 'on' ? 'bg-success' : state === 'off' ? 'bg-danger' : 'bg-muted';
  return (
    <span className="relative flex size-3.5 items-center justify-center">
      {state === 'on' && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
      )}
      <span className={`relative inline-flex size-3.5 rounded-full ${tone}`} />
    </span>
  );
}

export function StatusHeader({ status, connected }) {
  const unknown = !status;
  const running = Boolean(status?.running);
  const state = unknown ? 'unknown' : running ? 'on' : 'off';

  const label = unknown
    ? '正在检测…'
    : status.unreachable
      ? '面板已断开'
      : running
        ? '正在运行'
        : status.listening
          ? '端口被占用但无响应'
          : '已停止';

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur-md">
      {/* Fixed height: the reconnect chip must not reflow the page below it. */}
      <div className="mx-auto flex h-[72px] max-w-[1600px] items-center justify-between gap-4 px-6">
        <div className="flex items-center gap-3.5">
          <Lamp state={state} />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Codex ID 修复代理</h1>
            <p className="mt-0.5 text-xs text-muted">
              把 <code className="rounded bg-background-secondary px-1.5 py-0.5 font-mono">custom_tool_call</code> 的 id
              前缀实时改成 <code className="rounded bg-background-secondary px-1.5 py-0.5 font-mono">ctc_</code>，防止会话卡死
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className={connected ? 'invisible' : undefined}>
            <Chip color="warning" variant="soft" size="sm">
              <Chip.Label className="flex items-center gap-1.5">
                <Spinner size="sm" /> 事件流重连中
              </Chip.Label>
            </Chip>
          </span>
          <div className="text-right">
            <div className="flex items-center justify-end gap-1.5 text-sm font-semibold">
              {unknown && <Spinner size="sm" />}{label}
            </div>
            <div className="font-mono text-[11px] text-muted">
              {running
                ? `127.0.0.1:${status.proxyPort} → ${status.health?.upstream ?? ''} · PID ${status.pid ?? '?'}`
                : `127.0.0.1:${status?.proxyPort ?? 7801} 未监听`}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
