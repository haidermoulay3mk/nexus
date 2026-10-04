/**
 * Connection info for the Runner.
 *
 * Packaged mode: the Tauri Shell injects `window.__NEXUS__` (port + token)
 * via its initialization script — the token never touches disk in the UI.
 * Dev-web mode: `scripts/dev-web.ts` passes them as Vite env vars.
 */

declare global {
  interface Window {
    __NEXUS__?: { port: number; token: string };
  }
}

export interface Conn {
  port: number;
  token: string;
}

export function getConn(): Conn {
  if (window.__NEXUS__) return window.__NEXUS__;
  return {
    port: Number(import.meta.env.VITE_NEXUS_PORT ?? 4571),
    token: String(import.meta.env.VITE_NEXUS_TOKEN ?? ""),
  };
}

export const httpBase = (): string => `http://127.0.0.1:${getConn().port}`;
export const wsUrl = (): string =>
  `ws://127.0.0.1:${getConn().port}/ws?token=${encodeURIComponent(getConn().token)}`;
