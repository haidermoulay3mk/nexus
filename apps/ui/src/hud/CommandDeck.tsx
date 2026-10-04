import { motion } from "motion/react";
import { Panel } from "../components/Panel";
import { sendCommand } from "../lib/api";
import { useSystemStore } from "../state/useSystemStore";

/** Right column: the intent grid. Click → enqueue → Runner executes. */
export function CommandDeck() {
  const intents = useSystemStore((s) => s.intents);
  const status = useSystemStore((s) => s.status);
  const deck = intents.filter((i) => i.key !== "nexus.command" && !i.hidden);
  const q = status?.queue;

  return (
    <Panel
      title="COMMAND DECK"
      active={(q?.active ?? 0) > 0}
      titleRight={
        <span
          className="hud-label hud-num whitespace-nowrap"
          style={{ fontSize: "0.48rem", color: (q?.active ?? 0) > 0 ? "var(--accent)" : undefined }}
        >
          {(q?.active ?? 0) > 0 ? "EXEC" : "IDLE"} · {q?.active ?? 0}/{q?.maxConcurrent ?? 3} ·{" "}
          {q?.queued ?? 0}Q
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-1 py-1">
        {deck.length === 0 && (
          <p className="hud-label col-span-2 py-2" style={{ fontSize: "0.55rem" }}>
            AWAITING RUNNER…
          </p>
        )}
        {deck.map((intent) => (
          <motion.button
            key={intent.key}
            type="button"
            whileTap={{ scale: 0.98 }}
            transition={{ duration: 0.04 }}
            title={
              intent.available
                ? intent.description
                : `${intent.description}\n(connect ${intent.requiresIntegration} to enable)`
            }
            onClick={() =>
              void sendCommand({ type: "intent.dispatch", intentKey: intent.key, input: null })
            }
            className="group relative text-left px-2 py-1.5 cursor-pointer"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.58rem",
              letterSpacing: "0.12em",
              color: intent.available ? "var(--text)" : "var(--text-mute)",
              border: "1px solid color-mix(in srgb, var(--line-hairline) 80%, transparent)",
              background: "color-mix(in srgb, var(--bg-panel-2) 55%, transparent)",
              borderRadius: "var(--radius)",
            }}
          >
            <span
              className="mr-1.5 transition-colors"
              style={{ color: intent.available ? "var(--accent-deep)" : "var(--text-mute)" }}
            >
              ▸
            </span>
            {intent.label}
            {!intent.available && (
              <span
                className="block hud-label"
                style={{ fontSize: "0.42rem", marginTop: 1, color: "var(--warn)" }}
              >
                CONNECT TO ENABLE
              </span>
            )}
            {/* hover underglow */}
            <span
              aria-hidden
              className="absolute inset-0 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity"
              style={{
                borderRadius: "var(--radius)",
                boxShadow: "inset 0 0 12px rgba(255,140,66,0.12), 0 0 8px rgba(255,140,66,0.15)",
                border: "1px solid color-mix(in srgb, var(--accent) 45%, transparent)",
              }}
            />
          </motion.button>
        ))}
      </div>
      <p
        className="hud-label pt-1 border-t"
        style={{ fontSize: "0.45rem", borderColor: "var(--line-hairline)" }}
      >
        INTENTS WRITE TO SYSTEM/QUEUE — RUNNER EXECUTES
      </p>
    </Panel>
  );
}
