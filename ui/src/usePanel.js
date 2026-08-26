import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_EVENTS = 600;

// Owns all panel state: status polling, the SSE event feed, and action calls.
export function usePanel() {
  const [status, setStatus] = useState(null);
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(null);
  const [modal, setModal] = useState(null);
  const [notice, setNotice] = useState(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      setStatus(await res.json());
    } catch {
      setStatus((prev) => (prev ? { ...prev, running: false, unreachable: true } : { unreachable: true }));
    }
  }, []);

  // Busy sessions emit many events per second; one status fetch each would be
  // wasteful, so requests are coalesced into at most one per second.
  const refreshPending = useRef(false);
  const refreshSoon = useCallback(() => {
    if (refreshPending.current) return;
    refreshPending.current = true;
    setTimeout(() => { refreshPending.current = false; refresh(); }, 1000);
  }, [refresh]);

  // History and the live feed can carry the same event, so entries are keyed by
  // content and merged in timestamp order rather than arrival order.
  const identity = (e) => [e.at, e.kind, e.reqId ?? '', e.phase ?? '', e.status ?? '', e.message ?? ''].join('|');

  const push = useCallback((incoming) => {
    if (!incoming.length) return;
    setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.id));
      const added = [];
      for (const event of incoming) {
        const id = identity(event);
        if (seen.has(id)) continue;
        seen.add(id);
        added.push({ ...event, id, key: ++seq.current });
      }
      if (!added.length) return prev;
      const next = [...prev, ...added];
      // Live events almost always arrive in order, so only pay for a sort when
      // something actually lands out of sequence.
      const lastAt = prev.length ? prev[prev.length - 1].at : '';
      const needsSort = added.some((e, i) => e.at < (i ? added[i - 1].at : lastAt));
      if (needsSort) next.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.key - b.key));
      return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
    });
  }, []);

  useEffect(() => {
    let source;
    let cancelled = false;

    (async () => {
      await refresh();
      try {
        const res = await fetch('/api/history?limit=200');
        const { events: history } = await res.json();
        if (!cancelled) push(history);
      } catch {}
      if (cancelled) return;

      // Subscribe only after history is in, so the feed appends to a settled list.
      source = new EventSource('/api/events');
      source.onopen = () => { setConnected(true); refresh(); };
      source.onerror = () => setConnected(false);
      source.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data);
          push([event]);
          // Anything that changes lifecycle or counters warrants a status re-read.
          if (['repair', 'error', 'listening', 'stopped', 'control'].includes(event.kind)) refreshSoon();
        } catch {}
      };
    })();

    const timer = setInterval(refresh, 5000);
    return () => { cancelled = true; source?.close(); clearInterval(timer); };
  }, [refresh, refreshSoon, push]);

  const act = useCallback(async (path, label, { confirm: needsConfirm, body } = {}) => {
    if (needsConfirm && !window.confirm(needsConfirm)) return;
    setBusy(label);
    setNotice(null);
    try {
      const res = await fetch(path, body
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : { method: 'POST' });
      const data = await res.json();
      if (data.output !== undefined) setModal({ title: label, body: data.output, ok: data.ok });
      else if (!data.ok) setNotice({ status: 'danger', text: `${label}失败：${data.error || '未知错误'}` });
      return data;
    } catch (err) {
      setNotice({ status: 'danger', text: `${label}失败：${err.message}` });
    } finally {
      setBusy(null);
      refresh();
    }
  }, [refresh]);

  return {
    status, events, connected, busy, modal, notice,
    setModal, setNotice, act, refresh,
    clearEvents: () => setEvents([]),
  };
}
