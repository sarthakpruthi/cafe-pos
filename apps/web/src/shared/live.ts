import { useEffect, useRef, useState } from 'react';

const EVENTS = ['order.created', 'order.updated', 'order.accepted', 'order.rejected', 'order.served', 'order_item.updated', 'table.updated',
  'session.opened', 'session.closed', 'bill.updated', 'payment.recorded', 'payment.voided', 'menu.updated', 'notification.created'];

export type LiveState = 'connecting' | 'live' | 'reconnecting';

/**
 * Listens to server events. Events are only hints: after any reconnect we call onResync so the
 * screen refetches the real data. Repeated events (same id) are ignored.
 */
export function useLive(url: string | null, onEvent: (type: string, payload: any) => void, onResync: () => void): LiveState {
  const [state, setState] = useState<LiveState>('connecting');
  const handler = useRef(onEvent); handler.current = onEvent;
  const resync = useRef(onResync); resync.current = onResync;
  useEffect(() => {
    if (!url) return;
    const seen = new Set<string>();
    let hadError = false;
    const es = new EventSource(url, { withCredentials: true });
    es.onopen = () => { setState('live'); if (hadError) { hadError = false; resync.current(); } };
    es.onerror = () => { hadError = true; setState('reconnecting'); };
    for (const t of EVENTS) es.addEventListener(t, (m) => {
      const ev = JSON.parse((m as MessageEvent).data);
      if (seen.has(ev.eventId)) return;
      seen.add(ev.eventId); if (seen.size > 300) seen.delete(seen.values().next().value as string);
      handler.current(t, ev.payload);
    });
    return () => es.close();
  }, [url]);
  return state;
}

/** Runs fn at most once per `ms` after a burst of calls. */
export function useDebounced(fn: () => void, ms = 250) {
  const ref = useRef(fn); ref.current = fn;
  const timer = useRef<number>();
  return () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => ref.current(), ms); };
}

let audio: AudioContext | null = null;
export function beep() {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(); const g = audio.createGain();
    o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + 0.25);
  } catch { /* sound is optional */ }
}
