import { memo, useEffect, useMemo, useRef } from 'react';
import { Card, Chip, ScrollShadow, Tabs } from '@heroui/react';
import { clockTime, describeEvent, FILTERS, KIND_COLOR, KIND_LABEL } from './format';

function RepairPairs({ pairs }) {
  if (!pairs?.length) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {pairs.map((pair, index) => (
        <div key={index} className="flex flex-wrap items-center gap-1.5 font-mono text-[11.5px]">
          <span className="text-danger line-through decoration-danger/60">{pair.from}</span>
          <span className="text-muted">→</span>
          <span className="text-success">{pair.to}</span>
          {pair.name && <span className="text-muted">· {pair.name}</span>}
        </div>
      ))}
    </div>
  );
}

// Events are immutable once appended, so rows never need to re-render. Without
// this, one incoming event repaints the whole list and blocks interaction.
const Row = memo(function Row({ event }) {
  const emphasis = event.kind === 'repair' ? 'bg-accent-soft/25'
    : event.kind === 'error' ? 'bg-danger-soft/25' : '';

  return (
    <li className={`grid grid-cols-[64px_84px_1fr] items-baseline gap-3 border-b border-border-tertiary px-4 py-2 last:border-b-0 ${emphasis}`}>
      <span className="font-mono text-[11px] text-muted">{clockTime(event.at)}</span>
      <Chip size="sm" variant="soft" color={KIND_COLOR[event.kind] ?? 'default'}>
        <Chip.Label className="text-[10.5px]">{KIND_LABEL[event.kind] ?? event.kind}</Chip.Label>
      </Chip>
      <div className="min-w-0">
        <span className="font-mono text-[12px] break-all text-foreground/90">{describeEvent(event)}</span>
        <RepairPairs pairs={event.pairs} />
      </div>
    </li>
  );
});

export function EventStream({ events, filter, setFilter, autoscroll }) {
  const scroller = useRef(null);

  // One pass produces both the filtered rows and every tab's badge count.
  const { visible, counts } = useMemo(() => {
    const tally = Object.fromEntries(FILTERS.map((f) => [f.id, 0]));
    const rows = [];
    const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];
    for (const event of events) {
      for (const f of FILTERS) if (f.match(event)) tally[f.id]++;
      if (active.match(event)) rows.push(event);
    }
    return { visible: rows, counts: tally };
  }, [events, filter]);

  useEffect(() => {
    if (!autoscroll || !scroller.current) return;
    scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [visible.length, autoscroll]);

  return (
    <Card variant="secondary" className="flex min-h-0 min-w-0 flex-col">
      <Card.Header className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-border py-3">
        <Card.Title className="text-[13px] font-semibold tracking-wide text-muted uppercase">
          实时工作流
        </Card.Title>
        <Tabs selectedKey={filter} onSelectionChange={(key) => setFilter(String(key))}>
          <Tabs.List className="h-8">
            {FILTERS.map((item) => (
              <Tabs.Tab
                key={item.id}
                id={item.id}
                // HeroUI's .tabs__tab sets w-full, so each tab tries to fill the
                // list: they either shrink and wrap the Chinese label between
                // characters, or overflow the container. w-auto sizes to content.
                className="w-auto shrink-0 px-3 text-xs whitespace-nowrap"
              >
                {/* The indicator is a shared element and must sit inside the tab,
                    since TabList only scopes its collection items. */}
                <Tabs.Indicator />
                <span className="whitespace-nowrap">{item.label}</span>
                {item.id !== 'all' && (
                  <span className="ml-1.5 whitespace-nowrap text-muted">{counts[item.id]}</span>
                )}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
      </Card.Header>
      <Card.Content className="flex min-h-0 flex-1 flex-col p-0">
        {visible.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">
            还没有匹配的事件。代理运行后，Codex 每次请求都会出现在这里。
          </p>
        ) : (
          <ScrollShadow ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
            <ol className="list-none">
              {visible.map((event) => <Row key={event.key} event={event} />)}
            </ol>
          </ScrollShadow>
        )}
      </Card.Content>
    </Card>
  );
}
