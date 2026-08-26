import { useMemo, useState } from 'react';
import { Button, Card, ScrollShadow } from '@heroui/react';
import { clockTime } from './format';

export function ErrorPanel({ events }) {
  // Dismissal is local to this panel; it must not wipe the whole event feed.
  const [dismissedBefore, setDismissedBefore] = useState(null);

  const errors = useMemo(() => {
    const all = events.filter((e) => e.kind === 'error');
    const kept = dismissedBefore ? all.filter((e) => e.at > dismissedBefore) : all;
    return kept.slice(-60).reverse();
  }, [events, dismissedBefore]);

  const onClear = () => setDismissedBefore(new Date().toISOString());

  return (
    <Card variant="secondary" data-testid="error-panel" className="flex min-h-0 min-w-0 flex-col">
      <Card.Header className="flex flex-none items-center justify-between gap-3 border-b border-border py-3">
        <Card.Title className="text-[13px] font-semibold tracking-wide text-muted uppercase">
          错误详情
        </Card.Title>
        {errors.length > 0 && (
          <Button variant="ghost" size="sm" onPress={onClear}>清空</Button>
        )}
      </Card.Header>
      <Card.Content className="flex min-h-0 flex-1 flex-col p-0">
        {errors.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-success">暂无错误。</p>
        ) : (
          <ScrollShadow className="min-h-0 flex-1 overflow-y-auto">
            {errors.map((event) => {
              const title = [event.where, event.code, event.status && `HTTP ${event.status}`]
                .filter(Boolean).join(' · ') || '错误';
              return (
                <div key={event.key} className="border-b border-border-tertiary px-4 py-3 last:border-b-0">
                  <div className="font-mono text-[11px] text-muted">
                    {clockTime(event.at)}{event.reqId ? ` · 请求 #${event.reqId}` : ''}
                  </div>
                  <div className="mt-0.5 text-[13px] font-semibold text-danger">{title}</div>
                  {(event.message || event.body) && (
                    <pre className="mt-2 max-h-52 overflow-auto rounded-lg bg-background/70 p-2.5 font-mono text-[11px] whitespace-pre-wrap break-all text-foreground/75">
                      {[event.message, event.body].filter(Boolean).join('\n\n')}
                    </pre>
                  )}
                </div>
              );
            })}
          </ScrollShadow>
        )}
      </Card.Content>
    </Card>
  );
}
