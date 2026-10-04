import type { ClientCommand } from "@nexus/core";
import { getConn, httpBase } from "./conn";

async function req(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${httpBase()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${getConn().token}`,
      ...(init?.body && typeof init.body === "string"
        ? { "content-type": "application/json" }
        : {}),
      ...init?.headers,
    },
  });
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await req(path);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await req(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export async function sendCommand(cmd: ClientCommand): Promise<{ ok: boolean; error?: string }> {
  return apiPost("/cmd", cmd);
}

export async function transcribe(
  wav: Blob,
  dispatch: boolean,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const res = await req(`/voice/transcribe?dispatch=${dispatch}`, {
    method: "POST",
    body: wav,
    headers: { "content-type": "audio/wav" },
  });
  return (await res.json()) as { ok: boolean; text?: string; error?: string };
}

export async function synthesize(text: string): Promise<Blob | null> {
  const res = await req("/voice/tts", { method: "POST", body: JSON.stringify({ text }) });
  if (!res.ok) return null;
  return await res.blob();
}
