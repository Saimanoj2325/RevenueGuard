'use client';
// Live feed store: plain lines built from socket events with the deterministic caption map.
import { create } from 'zustand';
import { captionFor, type FeedLine } from './captions';
import { onWs } from './store';
import type { WsEvent } from './types';

interface FeedState { lines: FeedLine[]; push: (l: FeedLine) => void; clear: () => void }
export const useFeed = create<FeedState>()((set) => ({
  lines: [],
  push: (l) => set((s) => (s.lines.some((x) => x.text === l.text && x.case_id === l.case_id && Math.abs(x.ts - l.ts) < 1500) ? s : { lines: [l, ...s.lines].slice(0, 60) })),
  clear: () => set({ lines: [] }),
}));

const lastState = new Map<string, string>();
let started = false;
export function startFeed() {
  if (started || typeof window === 'undefined') return;
  started = true;
  onWs((e: WsEvent) => {
    if (e.type === 'case.updated') {
      if (lastState.get(e.case_id) === e.state) return; // touch() re-emits the same state: no new line
      const first = !lastState.has(e.case_id);
      lastState.set(e.case_id, e.state);
      if (first) return; // first sighting is a snapshot, not news
    }
    const l = captionFor(e as any);
    if (l) useFeed.getState().push(l);
  });
}
