import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { apiPost } from "../lib/api";
import { useSystemStore } from "../state/useSystemStore";

/**
 * SETTINGS — connect the optional, free integrations.
 * Everything here is optional; Nexus is fully functional with nothing
 * connected. Secrets go straight to the Runner's vault, never the DB.
 */

const label: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.55rem",
  letterSpacing: "0.15em",
  color: "var(--text-mute)",
  textTransform: "uppercase",
};

const inputStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.65rem",
  color: "var(--text-hi)",
  background: "var(--bg-panel-2)",
  border: "1px solid var(--line-hairline)",
  borderRadius: "var(--radius)",
  padding: "5px 8px",
  width: "100%",
  outline: "none",
};

function Field(props: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  password?: boolean;
}) {
  return (
    <input
      style={inputStyle}
      type={props.password ? "password" : "text"}
      placeholder={props.placeholder}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

function ActionButton({
  children,
  onClick,
  busy,
}: { children: React.ReactNode; onClick: () => void; busy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="cursor-pointer"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.55rem",
        letterSpacing: "0.15em",
        color: "var(--accent)",
        border: "1px solid var(--accent-deep)",
        background: "color-mix(in srgb, var(--accent) 8%, transparent)",
        borderRadius: "var(--radius)",
        padding: "5px 12px",
        opacity: busy ? 0.5 : 1,
      }}
    >
      {busy ? "…" : children}
    </button>
  );
}

function Section({
  title,
  status,
  children,
}: { title: string; status?: string; children: React.ReactNode }) {
  const connected = status === "connected";
  return (
    <section
      className="flex flex-col gap-2 pb-3 mb-3 border-b"
      style={{ borderColor: "var(--line-hairline)" }}
    >
      <div className="flex items-center justify-between">
        <h3 style={{ ...label, color: "var(--text)" }}>
          <span style={{ color: "var(--accent-deep)", marginRight: 6 }}>◆</span>
          {title}
        </h3>
        {status && (
          <span style={{ ...label, color: connected ? "var(--ok)" : "var(--text-mute)" }}>
            {status.toUpperCase()}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

export function SettingsDialog() {
  const integrations = useSystemStore((s) => s.integrations);
  const statusOf = (p: string) =>
    integrations.find((i) => i.provider === p)?.status ?? "disconnected";

  const [notionToken, setNotionToken] = useState("");
  const [notionParent, setNotionParent] = useState("");
  const [gClientId, setGClientId] = useState("");
  const [gClientSecret, setGClientSecret] = useState("");
  const [imap, setImap] = useState({ host: "", port: "993", user: "", pass: "" });
  const [caldav, setCaldav] = useState({ url: "", user: "", pass: "" });
  const [ytChannels, setYtChannels] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  const run = async (name: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(name);
    setMsg("");
    try {
      const res = await fn();
      setMsg(
        res.ok
          ? `${name.toUpperCase()} · SAVED ✓`
          : `${name.toUpperCase()} · ${res.error ?? "failed"}`,
      );
    } catch (e) {
      setMsg(`${name.toUpperCase()} · ${e instanceof Error ? e.message : "failed"}`);
    } finally {
      setBusy("");
    }
  };

  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="cursor-pointer hud-label"
          style={{
            fontSize: "0.55rem",
            color: "var(--text-mute)",
            background: "none",
            border: "none",
            padding: "4px 0",
          }}
        >
          ⚙ SETTINGS
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[80]"
          style={{ background: "rgba(10,7,5,0.8)", backdropFilter: "blur(3px)" }}
        />
        <Dialog.Content
          className="hud-scroll fixed left-1/2 top-[8%] z-[81] -translate-x-1/2 w-[520px] max-h-[84vh] overflow-y-auto outline-none px-5 py-4"
          style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--line-hairline)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--glow)",
          }}
          aria-describedby={undefined}
        >
          <div className="flex items-center justify-between mb-3">
            <Dialog.Title className="hud-heading" style={{ fontSize: "0.9rem" }}>
              SETTINGS · INTEGRATIONS
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="cursor-pointer hud-label"
                style={{ background: "none", border: "none", fontSize: "0.6rem" }}
              >
                ✕ CLOSE
              </button>
            </Dialog.Close>
          </div>
          <p style={{ ...label, marginBottom: 14, lineHeight: 1.7 }}>
            ALL OPTIONAL · ALL FREE · NEXUS WORKS FULLY WITH NOTHING CONNECTED.
            <br />
            SECRETS GO TO THE LOCAL VAULT ONLY — NEVER THE CLOUD.
          </p>

          <Section title="NOTION" status={statusOf("notion")}>
            <span style={label}>Internal integration token (from notion.so/my-integrations)</span>
            <Field
              placeholder="ntn_… or secret_…"
              value={notionToken}
              onChange={setNotionToken}
              password
            />
            <span style={label}>Parent page ID (where Nexus may create pages — optional)</span>
            <Field
              placeholder="e.g. 1a2b3c4d5e6f…"
              value={notionParent}
              onChange={setNotionParent}
            />
            <div className="flex gap-2">
              <ActionButton
                busy={busy === "notion"}
                onClick={() =>
                  void run("notion", async () => {
                    const res = await apiPost<{ ok: boolean; error?: string }>(
                      "/integrations/notion/connect",
                      { token: notionToken },
                    );
                    if (res.ok && notionParent.trim()) {
                      await apiPost("/config/secret", {
                        key: "notion.parent_page",
                        value: notionParent.trim(),
                      });
                    }
                    return res;
                  })
                }
              >
                CONNECT NOTION
              </ActionButton>
              <ActionButton
                busy={busy === "notion-off"}
                onClick={() =>
                  void run("notion-off", () => apiPost("/integrations/notion/disconnect"))
                }
              >
                DISCONNECT
              </ActionButton>
            </div>
          </Section>

          <Section title="GOOGLE · CALENDAR + GMAIL" status={statusOf("google")}>
            <span style={label}>OAuth Desktop client (free, console.cloud.google.com)</span>
            <Field placeholder="Client ID" value={gClientId} onChange={setGClientId} />
            <Field
              placeholder="Client secret"
              value={gClientSecret}
              onChange={setGClientSecret}
              password
            />
            <div className="flex gap-2">
              <ActionButton
                busy={busy === "google"}
                onClick={() =>
                  void run("google", async () => {
                    const res = await apiPost<{ ok: boolean; authUrl?: string; error?: string }>(
                      "/integrations/google/start",
                      {
                        clientId: gClientId,
                        clientSecret: gClientSecret,
                      },
                    );
                    if (res.ok && res.authUrl) window.open(res.authUrl, "_blank");
                    return res;
                  })
                }
              >
                CONNECT GOOGLE
              </ActionButton>
              <ActionButton
                busy={busy === "google-off"}
                onClick={() =>
                  void run("google-off", () => apiPost("/integrations/google/disconnect"))
                }
              >
                DISCONNECT
              </ActionButton>
            </div>
            <span style={{ ...label, textTransform: "none", letterSpacing: "0.05em" }}>
              A Google login tab opens — approve it and come back.
            </span>
          </Section>

          <Section title="EMAIL · IMAP (ANY PROVIDER)" status={statusOf("imap")}>
            <div className="grid grid-cols-2 gap-2">
              <Field
                placeholder="Host (imap.example.com)"
                value={imap.host}
                onChange={(v) => setImap({ ...imap, host: v })}
              />
              <Field
                placeholder="Port (993)"
                value={imap.port}
                onChange={(v) => setImap({ ...imap, port: v })}
              />
              <Field
                placeholder="Username / email"
                value={imap.user}
                onChange={(v) => setImap({ ...imap, user: v })}
              />
              <Field
                placeholder="App password"
                value={imap.pass}
                onChange={(v) => setImap({ ...imap, pass: v })}
                password
              />
            </div>
            <ActionButton
              busy={busy === "imap"}
              onClick={() => void run("imap", () => apiPost("/integrations/imap/connect", imap))}
            >
              CONNECT IMAP
            </ActionButton>
          </Section>

          <Section title="CALENDAR · CALDAV (ANY PROVIDER)" status={statusOf("caldav")}>
            <div className="grid grid-cols-2 gap-2">
              <Field
                placeholder="Server URL"
                value={caldav.url}
                onChange={(v) => setCaldav({ ...caldav, url: v })}
              />
              <Field
                placeholder="Username"
                value={caldav.user}
                onChange={(v) => setCaldav({ ...caldav, user: v })}
              />
              <Field
                placeholder="Password"
                value={caldav.pass}
                onChange={(v) => setCaldav({ ...caldav, pass: v })}
                password
              />
            </div>
            <ActionButton
              busy={busy === "caldav"}
              onClick={() =>
                void run("caldav", () => apiPost("/integrations/caldav/connect", caldav))
              }
            >
              CONNECT CALDAV
            </ActionButton>
          </Section>

          <Section title="INTEL · YT WEEK CHANNELS">
            <span style={label}>
              YouTube channel IDs, comma-separated (free public RSS, no API key)
            </span>
            <Field placeholder="UCxxxx…, UCyyyy…" value={ytChannels} onChange={setYtChannels} />
            <ActionButton
              busy={busy === "yt"}
              onClick={() =>
                void run("yt", () =>
                  apiPost("/config/secret", {
                    key: "config.yt.channels",
                    value: ytChannels.trim(),
                  }),
                )
              }
            >
              SAVE CHANNELS
            </ActionButton>
          </Section>

          {msg && (
            <p style={{ ...label, color: msg.includes("✓") ? "var(--ok)" : "var(--warn)" }}>
              {msg}
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
