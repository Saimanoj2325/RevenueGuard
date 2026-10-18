// Runtime configuration. Demo mode is a runtime switch (localStorage 'rg.demo'), defaulting to NEXT_PUBLIC_MOCK.
// On = in-browser mock backend (no server); Off = real API at NEXT_PUBLIC_API_URL or via /api-backend proxy.
declare const process: any;
export const DEMO_DEFAULT: boolean = process.env.NEXT_PUBLIC_MOCK === 'true';
export const DEMO_KEY: string = 'rg.demo';

const publicApi = process.env.NEXT_PUBLIC_API_URL;
const internalApi = process.env.INTERNAL_API_URL;
const publicWs = process.env.NEXT_PUBLIC_WS_URL;

export const API_URL: string = (
  typeof window !== 'undefined'
    ? (publicApi && publicApi !== 'http://localhost:8000' ? publicApi : '/api-backend')
    : (publicApi || internalApi || 'http://api:8000')
).replace(/\/$/, '');

function computeWsUrl(): string {
  if (publicWs) return publicWs.replace(/\/$/, '');
  if (typeof window !== 'undefined') {
    if (API_URL.startsWith('http://') || API_URL.startsWith('https://')) {
      return (API_URL.replace(/^http/, 'ws') + '/ws').replace(/\/$/, '');
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}${API_URL}/ws`.replace(/\/$/, '');
  }
  return 'ws://api:8000/ws';
}

export const WS_URL: string = computeWsUrl();

export const BASE_PATH: string = process.env.NEXT_PUBLIC_BASE_PATH || '';

/** Current demo setting. On the server (prerender) this is the build default. */
export function isDemo(): boolean {
  if (typeof window === 'undefined') return DEMO_DEFAULT;
  try {
    const v = window.localStorage.getItem(DEMO_KEY);
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
  } catch { /* storage blocked */ }
  return DEMO_DEFAULT;
}

/** Flip demo mode: signs out (clears the session) and reloads, so no data from one backend leaks into the other. */
export function setDemo(on: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DEMO_KEY, on ? '1' : '0');
    window.localStorage.removeItem('rg-auth');
  } catch { /* ignore */ }
  window.location.reload();
}
