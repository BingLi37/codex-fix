import { Button, Separator, Spinner, Switch } from '@heroui/react';

const REPAIR_CONFIRM = '将修复所有会话文件里前缀错误的 custom_tool_call id。\n'
  + '原文件会先备份到 .codex\\backups。是否继续？';

// The three long-running actions. Each reserves a fixed-width slot for its
// spinner so the button keeps the same size while running; growing it would
// shove every control to its right, which is the layout shift fixed earlier.
function ActionButton({ label, busy, isBusy, onPress }) {
  return (
    <Button variant="ghost" isDisabled={Boolean(busy)} isPending={isBusy} onPress={onPress}>
      <span className="flex items-center gap-1.5">
        {label}
        <span className="inline-flex w-3.5 shrink-0 items-center justify-center" aria-hidden={!isBusy}>
          {isBusy && <Spinner size="sm" />}
        </span>
      </span>
    </Button>
  );
}

export function Controls({ status, busy, act, autoscroll, setAutoscroll, onClear, showRelays, setShowRelays }) {
  const running = Boolean(status?.running);
  const anyBusy = Boolean(busy);

  return (
    <section className="flex flex-wrap items-center gap-2.5">
      <Button
        variant="primary"
        isDisabled={running || anyBusy}
        isPending={busy === '启动'}
        onPress={() => act('/api/start', '启动')}
      >
        启动
      </Button>
      <Button
        variant="danger-soft"
        isDisabled={!running || anyBusy}
        isPending={busy === '停止'}
        onPress={() => act('/api/stop', '停止')}
      >
        停止
      </Button>
      <Button
        variant="outline"
        isDisabled={anyBusy}
        isPending={busy === '重启'}
        onPress={() => act('/api/restart', '重启')}
      >
        重启
      </Button>

      <Separator orientation="vertical" className="mx-1 h-6" />

      {/* Fixed label. Putting the relay name in here would widen the button once
          status arrives and shove every control to its right. */}
      <Button variant="secondary" onPress={() => setShowRelays(true)}>中转站</Button>
      <ActionButton
        label="运行自检"
        busy={busy}
        isBusy={busy === '自检结果'}
        onPress={() => act('/api/selftest', '自检结果')}
      />
      <ActionButton
        label="扫描历史会话"
        busy={busy}
        isBusy={busy === '扫描结果（未改动任何文件）'}
        onPress={() => act('/api/scan', '扫描结果（未改动任何文件）')}
      />
      <ActionButton
        label="修复历史会话"
        busy={busy}
        isBusy={busy === '修复结果'}
        onPress={() => act('/api/scan?apply=1', '修复结果', { confirm: REPAIR_CONFIRM })}
      />

      {/* Shown on the right, where a width change cannot move the buttons. */}
      <div className="ml-auto flex items-center gap-4">
        {status?.health?.relay && (
          <span className="text-xs text-muted">
            当前中转站 <span className="font-mono text-foreground/80">{status.health.relay}</span>
          </span>
        )}
        <Switch isSelected={autoscroll} onChange={setAutoscroll} size="sm">
          <Switch.Control><Switch.Thumb /></Switch.Control>
          <Switch.Content>
            <span className="text-xs text-muted">自动滚动</span>
          </Switch.Content>
        </Switch>
        <Button variant="ghost" size="sm" onPress={onClear}>清空视图</Button>
      </div>
    </section>
  );
}
