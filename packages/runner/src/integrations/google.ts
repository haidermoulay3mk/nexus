import { createHash, randomBytes } from "node:crypto";
import { type Result, err, ok } from "@nexus/core";
import type { SecretService } from "../services";

/**
 * Google Calendar + Gmail via OAuth 2.0 desktop **loopback** flow with PKCE.
 * 100% free: the user creates their own OAuth client (Desktop type) in the
 * free Google Cloud console; Nexus never proxies through any server.
 *
 * Implemented against Google's REST endpoints directly with `fetch` — same
 * free APIs the heavyweight SDK wraps, at a fraction of the footprint.
 * Tokens live only in the secret vault.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  // Write scopes for confirm-gated features: DRAFTS (never send) + events.
  // Accounts linked before these scopes existed must disconnect + reconnect
  // once to grant them; read features keep working on old tokens.
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

export class GoogleIntegration {
  private pending: {
    verifier: string;
    redirectUri: string;
    server: ReturnType<typeof Bun.serve>;
  } | null = null;

  constructor(private readonly secrets: SecretService) {}

  async isConnected(): Promise<boolean> {
    return (await this.secrets.get("google.refresh_token")) !== null;
  }

  /**
   * Start the loopback flow: spins up a one-shot 127.0.0.1 listener and
   * returns the URL the user's browser should open. Resolves `onDone` when
   * the redirect lands.
   */
  async start(
    clientId: string,
    clientSecret: string,
    onDone: (r: Result<string>) => void,
  ): Promise<Result<{ authUrl: string }>> {
    await this.secrets.set("google.client_id", clientId);
    await this.secrets.set("google.client_secret", clientSecret);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("hex");

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0, // ephemeral loopback port
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
        if (url.searchParams.get("state") !== state)
          return new Response("bad state", { status: 400 });
        const code = url.searchParams.get("code");
        if (!code) {
          onDone(err("OAUTH_DENIED", url.searchParams.get("error") ?? "authorization denied"));
        } else {
          onDone(await this.exchange(code));
        }
        setTimeout(() => server.stop(true), 500);
        this.pending = null;
        return new Response(
          "<html><body style='background:#0A0705;color:#EDE6DD;font-family:monospace'><h2>NEXUS — Google linked. You can close this tab.</h2></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      },
    });

    const redirectUri = `http://127.0.0.1:${server.port}/callback`;
    this.pending = { verifier, redirectUri, server };

    const authUrl =
      `${AUTH_URL}?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code&scope=${encodeURIComponent(SCOPES)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256` +
      `&access_type=offline&prompt=consent&state=${state}`;
    return ok({ authUrl });
  }

  private async exchange(code: string): Promise<Result<string>> {
    if (!this.pending) return err("OAUTH_NO_FLOW", "no pending OAuth flow");
    const clientId = (await this.secrets.get("google.client_id")) ?? "";
    const clientSecret = (await this.secrets.get("google.client_secret")) ?? "";
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: this.pending.redirectUri,
        grant_type: "authorization_code",
        code_verifier: this.pending.verifier,
      }),
    });
    if (!res.ok) return err("OAUTH_EXCHANGE", `token exchange failed: ${await res.text()}`);
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    await this.secrets.set("google.access_token", data.access_token);
    await this.secrets.set(
      "google.access_expiry",
      String(Date.now() + data.expires_in * 1000 - 60_000),
    );
    if (data.refresh_token) await this.secrets.set("google.refresh_token", data.refresh_token);
    return ok("connected");
  }

  private async accessToken(): Promise<Result<string>> {
    const expiry = Number((await this.secrets.get("google.access_expiry")) ?? 0);
    const current = await this.secrets.get("google.access_token");
    if (current && Date.now() < expiry) return ok(current);

    const refresh = await this.secrets.get("google.refresh_token");
    if (!refresh) return err("GOOGLE_NOT_CONNECTED", "Google is not connected");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refresh,
        client_id: (await this.secrets.get("google.client_id")) ?? "",
        client_secret: (await this.secrets.get("google.client_secret")) ?? "",
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) return err("GOOGLE_REFRESH", `token refresh failed: ${await res.text()}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    await this.secrets.set("google.access_token", data.access_token);
    await this.secrets.set(
      "google.access_expiry",
      String(Date.now() + data.expires_in * 1000 - 60_000),
    );
    return ok(data.access_token);
  }

  async calendarToday(): Promise<Result<Array<{ start: string; summary: string }>>> {
    const token = await this.accessToken();
    if (!token.ok) return token;
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 2); // today + tomorrow (PLAN TMRW uses it too)
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${dayStart.toISOString()}&timeMax=${dayEnd.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=25`;
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token.value}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return err("GCAL_HTTP", `calendar fetch failed: ${res.status}`);
      const data = (await res.json()) as {
        items?: Array<{ summary?: string; start?: { dateTime?: string; date?: string } }>;
      };
      return ok(
        (data.items ?? []).map((e) => ({
          start: e.start?.dateTime ?? e.start?.date ?? "",
          summary: e.summary ?? "(untitled)",
        })),
      );
    } catch (e) {
      return err("GCAL_OFFLINE", "calendar unreachable (offline?)", e);
    }
  }

  async gmailHeaders(
    limit = 15,
  ): Promise<Result<Array<{ from: string; subject: string; date: string }>>> {
    const token = await this.accessToken();
    if (!token.ok) return token;
    try {
      const listRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&labelIds=INBOX`,
        {
          headers: { authorization: `Bearer ${token.value}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!listRes.ok) return err("GMAIL_HTTP", `gmail list failed: ${listRes.status}`);
      const list = (await listRes.json()) as { messages?: Array<{ id: string }> };
      const out: Array<{ from: string; subject: string; date: string }> = [];
      for (const m of (list.messages ?? []).slice(0, limit)) {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          {
            headers: { authorization: `Bearer ${token.value}` },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!msgRes.ok) continue;
        const msg = (await msgRes.json()) as {
          payload?: { headers?: Array<{ name: string; value: string }> };
        };
        const h = (name: string) =>
          msg.payload?.headers?.find((x) => x.name.toLowerCase() === name)?.value ?? "";
        out.push({ from: h("from"), subject: h("subject"), date: h("date") });
      }
      return ok(out);
    } catch (e) {
      return err("GMAIL_OFFLINE", "gmail unreachable (offline?)", e);
    }
  }

  /**
   * Create a Gmail DRAFT (never sends — the operator reviews and hits send
   * in Gmail). Requires the gmail.compose scope; older connections get a
   * clear "reconnect" error instead of a mystery 403.
   */
  async createDraft(to: string, subject: string, body: string): Promise<Result<string>> {
    const token = await this.accessToken();
    if (!token.ok) return token;
    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
      "utf8",
    ).toString("base64url");
    try {
      const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
        method: "POST",
        headers: { authorization: `Bearer ${token.value}`, "content-type": "application/json" },
        body: JSON.stringify({ message: { raw } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 403) {
        return err(
          "GMAIL_SCOPE",
          "Gmail draft permission missing — disconnect and reconnect Google in Settings to grant it.",
        );
      }
      if (!res.ok) return err("GMAIL_DRAFT", `draft create failed: ${res.status}`);
      const data = (await res.json()) as { id?: string };
      return ok(data.id ?? "draft");
    } catch (e) {
      return err("GMAIL_OFFLINE", "gmail unreachable (offline?)", e);
    }
  }

  /** Create a calendar event. Only ever called from an explicit typed command. */
  async createEvent(
    summary: string,
    startISO: string,
    endISO: string,
    description = "",
  ): Promise<Result<string>> {
    const token = await this.accessToken();
    if (!token.ok) return token;
    try {
      const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
        method: "POST",
        headers: { authorization: `Bearer ${token.value}`, "content-type": "application/json" },
        body: JSON.stringify({
          summary,
          description,
          start: { dateTime: startISO },
          end: { dateTime: endISO },
          reminders: { useDefault: true },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 403) {
        return err(
          "GCAL_SCOPE",
          "Calendar write permission missing — disconnect and reconnect Google in Settings to grant it.",
        );
      }
      if (!res.ok) return err("GCAL_EVENT", `event create failed: ${res.status}`);
      const data = (await res.json()) as { id?: string };
      return ok(data.id ?? "event");
    } catch (e) {
      return err("GCAL_OFFLINE", "calendar unreachable (offline?)", e);
    }
  }

  async disconnect(): Promise<void> {
    for (const k of ["google.refresh_token", "google.access_token", "google.access_expiry"]) {
      await this.secrets.delete(k);
    }
  }
}
