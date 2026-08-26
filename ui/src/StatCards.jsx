import { useEffect, useState } from 'react';
import { Card, Tooltip } from '@heroui/react';
import { clockTime, humanDuration } from './format';

function Stat({ label, value, hint, tone }) {
  const accent = tone === 'accent' ? 'text-accent'
    : tone === 'danger' ? 'text-danger'
    : tone === 'success' ? 'text-success'
    : 'text-foreground';
  const border = tone === 'danger' ? 'border-danger/45' : undefined;

  const body = (
    <Card variant="secondary" className={border}>
      <Card.Content className="gap-1 p-4">
        <span className="text-xs text-muted">{label}</span>
        <strong className={`text-xl font-semibold tabular-nums ${accent}`}>{value}</strong>
      </Card.Content>
    </Card>
  );

  if (!hint) return body;
  return (
    <Tooltip delay={200}>
      <Tooltip.Trigger className="block">{body}</Tooltip.Trigger>
      <Tooltip.Content>{hint}</Tooltip.Content>
    </Tooltip>
  );
}

export function StatCards({ status }) {
  const health = status?.health;
  const codex = status?.codex;
  const [, tick] = useState(0);

  // Uptime is derived from a timestamp, so it needs its own repaint.
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const wiring = codex?.wired === true ? '已接入'
    : codex?.baseUrl ? '未接入'
    : codex?.error ? '读不到配置' : '–';

  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <Stat label="已处理请求" value={health?.requests ?? '–'} />
      <Stat label="已修正 id" value={health?.idsFixed ?? '–'} tone="accent" />
      <Stat label="已同步引用" value={health?.refsFixed ?? '–'} tone="accent" />
      <Stat label="最近一次修正" value={health?.lastFix ? clockTime(health.lastFix) : '尚未发生'} />
      <Stat label="运行时长" value={status?.running ? humanDuration(health?.started) : '–'} />
      <Stat
        label="Codex 接入状态"
        value={wiring}
        tone={codex?.wired === true ? 'success' : codex?.wired === false ? 'danger' : undefined}
        hint={codex?.baseUrl ? `config.toml 中 base_url = ${codex.baseUrl}` : codex?.error}
      />
    </section>
  );
}
