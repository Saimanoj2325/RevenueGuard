// Runtime configuration. Demo mode is a runtime switch (localStorage 'rg.demo'), defaulting to NEXT_PUBLIC_MOCK.
// On = in-browser mock backend (no server); Off = real API at NEXT_PUBLIC_API_URL.
export const DEMO_DEFAULT = process.env.NEXT_PUBLIC_MOCK === 'true';
export const DEMO_KEY = 'rg.demo';
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');
export const WS_URL = (process.env.NEXT_PUBLIC_WS_URL || API_URL.replace(/^http/, 'ws') + '/ws').replace(/\/$/, '');
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

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
