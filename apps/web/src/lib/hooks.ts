'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { onWs } from './store';
import type { WsEvent } from './types';

/**
 * Fetch + live refresh: refetches (debounced) whenever a WS event matching `refreshOn` arrives.
 * Keeps showing previous data while refreshing so live updates never flash empty states.
 */
export function useLive<T>(fetcher: () => Promise<T>, deps: unknown[], refreshOn?: (e: WsEvent) => boolean, debounceMs = 180) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fRef = useRef(fetcher);
  fRef.current = fetcher;
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const d = await fRef.current();
      if (my === seq.current) { setData(d); setError(null); }
    } catch (e: any) {
      if (my === seq.current) setError(e?.message ?? String(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { setLoading(true); load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, deps);

  const rRef = useRef(refreshOn);
  rRef.current = refreshOn;
  useEffect(() => {
    let t: any;
    const off = onWs((e) => {
      if (rRef.current && rRef.current(e)) { clearTimeout(t); t = setTimeout(load, debounceMs); }
    });
    return () => { off(); clearTimeout(t); };
  }, [load, debounceMs]);

  return { data, error, loading, reload: load, setData };
}

export function useNow(intervalMs = 15000) {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setN(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return n;
}
