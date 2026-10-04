import { useEffect, useState } from "react";
import { SettingsDialog } from "../hud/SettingsDialog";
import { fmtClock } from "../lib/format";
import { useSystemStore } from "../state/useSystemStore";

function Dot({ on, warn }: { on: boolean; warn?: boolean }) {
  return (
    <span
      className={on ? "pulse-dot" : ""}
      style={{
        display: "inline-block",
        width: 5,
        height: 5,
        borderRadius: "50%",
        background: on ? "var(--accent)" : warn ? "var(--err)" : "var(--text-mute)",
        boxShadow: on ? "0 0 6px rgba(255,140,66,0.8)" : "none",
        marginRight: 6,
      }}
    />
  );
}

function StatusPair({
  label,
  value,
  on,
  warn,
}: { label: string; value: string; on: boolean; warn?: boolean }) {
  return (
    <span className="hud-label flex items-center" style={{ fontSize: "0.6rem" }}>
      <Dot on={on} warn={warn} />
      <span style={{ color: "var(--text-mute)" }}>{label}</span>
      <span
        style={{
          color: on ? "var(--text)" : warn ? "var(--err)" : "var(--text-mute)",
          marginLeft: 6,
        }}
      >
        {value}
      </span>
    </span>
  );
}

/** Top status rail: wordmark, live process indicators, clock. */
export function StatusBar() {
  const status = useSystemStore((s) => s.status);
  const conn = useSystemStore((s) => s.conn);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const clock = fmtClock(now);
  const runnerAlive = conn === "online" && status?.runner === "alive";

  return (
    <header className="flex items-start justify-between px-6 pt-4 pb-2 relative z-40">
      <div>
        <h1
          className="hud-heading"
          style={{
            fontSize: "1.5rem",
            fontWeight: 700,
            letterSpacing: "0.35em",
            color: "var(--text-hi)",
          }}
        >
          N.E.X.U.S.
        </h1>
        <p className="hud-label" style={{ fontSize: "0.55rem", marginTop: 2 }}>
          voice-activated unified logic terminal
        </p>
      </div>

      <div className="flex items-center gap-6 pt-2">
        <StatusPair
          label="CORE"
          value={status?.core?.toUpperCase() ?? "—"}
          on={status?.core === "active"}
        />
        <StatusPair
          label="LINK"
          value={(status?.link ?? "—").toUpperCase()}
          on={status?.link === "online" || status?.link === "partial"}
        />
        <StatusPair
          label="RUNNER"
          value={runnerAlive ? "ALIVE" : conn === "connecting" ? "STARTING" : "DEAD"}
          on={runnerAlive}
          warn={conn === "lost"}
        />
        <StatusPair
          label="MODEL"
          value={
            status?.ollama === "ready"
              ? ((status.model ?? "READY").split(":")[0]?.toUpperCase() ?? "READY")
              : (status?.ollama ?? "—").toUpperCase()
          }
          on={status?.ollama === "ready"}
          warn={status?.ollama === "missing" || status?.ollama === "error"}
        />
      </div>

      <div className="text-right">
        <div
          className="hud-num"
          style={{
            fontFamily: "var(--font-hud)",
            fontSize: "2rem",
            fontWeight: 600,
            lineHeight: 1,
          }}
        >
          {clock.hm}
          <span style={{ fontSize: "0.9rem", color: "var(--text-mute)" }}>:{clock.s}</span>
        </div>
        <div className="hud-label" style={{ fontSize: "0.55rem", marginTop: 2 }}>
          {clock.date}
        </div>
        <SettingsDialog />
      </div>
    </header>
  );
}
