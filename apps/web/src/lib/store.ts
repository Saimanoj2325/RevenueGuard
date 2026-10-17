'use client';
import { caseRef, rememberCase } from './normalize';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { setTokenGetter } from './api';
import { DEMO_DEFAULT, isDemo, WS_URL } from './config';
import type { Provider, User, WsEvent } from './types';

// ---------------- auth ----------------
interface AuthState {
  token: string | null;
  user: User | null;
  set: (token: string, user: User) => void;
  logout: () => void;
}
export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      set: (token, user) => set({ token, user }),
      logout: () => set({ token: null, user: null }),
    }),
    {
      name: 'rg-auth',
      partialize: (s) => ({ token: s.token, user: s.user }),
    },
  ),
);
setTokenGetter(() => useAuth.getState().token);

/** true once the persisted session has been read from localStorage (avoids SSR/hydration mismatch). */
export function useAuthReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (useAuth.persist.hasHydrated()) setReady(true);
    return useAuth.persist.onFinishHydration(() => setReady(true));
  }, []);
  return ready;
}

// ---------------- websocket ----------------
export interface GuardrailToast { id: string; case_id: string; kind: string; detail: string; ts: number }
type WsStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
type Listener = (e: WsEvent) => void;

interface WsState {
  status: WsStatus;
  attempts: number;
  provider: Provider;
  events: (WsEvent & { _ts: number })[];
  guardrails: GuardrailToast[];
  toasts: GuardrailToast[];
  waQr: string | null;
  connect: (token: string) => void;
  disconnect: () => void;
  dismissToast: (id: string) => void;
}

const listeners = new Set<Listener>();
export function onWs(fn: Listener) { listeners.add(fn); return () => { listeners.delete(fn); }; }

let socket: WebSocket | null = null;
let mockUnsub: (() => void) | null = null;
let retryT: any = null;
let wantOpen = false;

const AGENT_TYPES = ['step_started', 'tool_call', 'tool_result', 'model_call', 'step_finished', 'run_finished', 'run_failed'];
/** API shape: `{type:"agent.event", case_id, case_number?, event:{run_id, case_id, type, agent, data, ts}}`.
 * Older/flattened encodings are still accepted. Case ids are mapped to the human case number ("RG-1042"), which is
 * what the UI uses as a case id everywhere (the API adds `case_number` next to every case uuid on the socket). */
export function normalizeWs(raw: any): WsEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const ref = (id: any, number?: any) => { rememberCase(id, number); return caseRef(id, number) ?? id; };
  if (raw.type === 'agent.event') {
    let ev: any;
    if (raw.event?.run_id) ev = raw.event; // {type, event:{...}}  (canonical)
    else if (raw.data?.run_id && raw.data?.type) ev = raw.data; // {type, data:{...agent event}}
    else ev = { ...raw, type: raw.event_type ?? raw.agent_event_type ?? raw.kind }; // flattened with renamed type
    if (!ev?.run_id) return null;
    const cid = ref(ev.case_id ?? raw.case_id, ev.case_number ?? raw.case_number);
    return { type: 'agent.event', case_id: cid, event: { ...ev, case_id: cid } };
  }
  if (AGENT_TYPES.includes(raw.type) && raw.run_id) { const cid = ref(raw.case_id, raw.case_number); return { type: 'agent.event', case_id: cid, event: { ...raw, case_id: cid } }; }
  if (raw.type === 'approval.updated' && raw.approval) return { ...raw, approval: { ...raw.approval, case_id: ref(raw.approval.case_id, raw.approval.case_number) } } as WsEvent;
  if ('case_id' in raw && raw.case_id) return { ...raw, case_id: ref(raw.case_id, raw.case_number) } as WsEvent;
  return raw as WsEvent;
}

/** The API sends guardrail details as objects ({reason, idempotency_key, …}); the feed renders text. */
export function guardText(d: unknown): string {
  if (d == null) return '';
  if (typeof d === 'string') return d;
  if (typeof d !== 'object') return String(d);
  const o = d as Record<string, unknown>;
  const main = o.reason ?? o.message ?? o.detail;
  const rest = Object.entries(o).filter(([k, v]) => !['reason', 'message', 'detail'].includes(k) && v != null && typeof v !== 'object').map(([k, v]) => `${k}=${v}`);
  return [main, ...rest].filter(Boolean).join(' · ') || JSON.stringify(o);
}

function ingest(raw: WsEvent) {
  const e = normalizeWs(raw);
  if (!e) return;
  const s = useWs.getState();
  const patch: Partial<WsState> = { events: [{ ...e, _ts: Date.now() }, ...s.events].slice(0, 400) };
  if (e.type === 'llm.provider') patch.provider = e.provider;
  if (e.type === 'wa.qr') patch.waQr = e.qr;
  if (e.type === 'guardrail') {
    const t: GuardrailToast = { id: Math.random().toString(36).slice(2), case_id: e.case_id, kind: e.kind, detail: guardText(e.detail), ts: Date.now() };
    patch.guardrails = [t, ...s.guardrails].slice(0, 100);
    patch.toasts = [t, ...s.toasts].slice(0, 3);
    setTimeout(() => useWs.getState().dismissToast(t.id), 5500);
  }
  useWs.setState(patch);
  listeners.forEach((l) => l(e));
}

export const useWs = create<WsState>()((set, get) => ({
  status: 'idle',
  attempts: 0,
  provider: 'nim',
  events: [],
  guardrails: [],
  toasts: [],
  waQr: null,
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  disconnect: () => {
    wantOpen = false;
    clearTimeout(retryT);
    mockUnsub?.(); mockUnsub = null;
    socket?.close(); socket = null;
    set({ status: 'closed' });
  },
  connect: (token) => {
    wantOpen = true;
    if (isDemo()) {
      if (mockUnsub) return;
      set({ status: 'connecting' });
      import('./mock/backend').then(({ mockBackend }) => {
        if (!wantOpen || mockUnsub) return;
        mockUnsub = mockBackend().subscribe(ingest);
        set({ status: 'open', provider: mockBackend().db.provider });
      });
      return;
    }
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    set({ status: get().attempts ? 'reconnecting' : 'connecting' });
    try {
      socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    } catch {
      scheduleRetry(token);
      return;
    }
    socket.onopen = () => {
      const wasRetry = get().attempts > 0;
      set({ status: 'open', attempts: 0 });
      // catch up on anything missed while the socket was down
      if (wasRetry) import('./api').then(({ api }) => api.eventsRecent().then((evs) => evs.forEach((e: any) => ingest({ ...e, _catchup: true }))).catch(() => {}));
    };
    socket.onmessage = (m) => {
      try {
        const data = JSON.parse(m.data);
        if (Array.isArray(data)) data.forEach(ingest); else if (data?.type) ingest(data);
      } catch { /* ignore non-JSON pings */ }
    };
    socket.onclose = () => { socket = null; if (wantOpen) scheduleRetry(token); else set({ status: 'closed' }); };
    socket.onerror = () => socket?.close();
  },
}));

function scheduleRetry(token: string) {
  const attempts = useWs.getState().attempts + 1;
  const delay = Math.min(15000, 500 * 2 ** Math.min(attempts, 5)) + Math.random() * 400;
  useWs.setState({ status: 'reconnecting', attempts });
  clearTimeout(retryT);
  retryT = setTimeout(() => wantOpen && useWs.getState().connect(token), delay);
}

// ---------------- ui ----------------
interface UiState { hoverNodes: string[]; setHover: (ids: string[]) => void; navOpen: boolean; setNav: (v: boolean) => void }
export const useUi = create<UiState>()((set) => ({
  hoverNodes: [],
  setHover: (ids) => set({ hoverNodes: ids }),
  navOpen: false,
  setNav: (v) => set({ navOpen: v }),
}));

/** Demo flag as React state: build default during prerender, real setting after mount (no hydration mismatch). */
export function useDemo() {
  const [v, setV] = useState(DEMO_DEFAULT);
  useEffect(() => { setV(isDemo()); }, []);
  return v;
}
