import { useEffect, useRef } from "react";
import { Panel } from "../components/Panel";
import { useRunStore } from "../state/useRunStore";

/**
 * AI WIRE — the streaming intel feed. Shows persisted wire items plus the
 * live model token stream (typewriter) while a run is generating.
 */
export function AIWire() {
  const wire = useRunStore((s) => s.wire);
  const liveTokens = useRunStore((s) => s.liveTokens);
  const anyActive = useRunStore((s) => s.anyActive);
  const scroller = useRef<HTMLDivElement>(null);

  // No dep array on purpose: pin the feed to the bottom after every render
  // (renders are driven by wire/liveTokens updates from the store).
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const tail = anyActive ? liveTokens.slice(-420) : "";

  return (
    <Panel
      title="AI WIRE"
      active={anyActive}
      titleRight={
        <span className="hud-label" style={{ fontSize: "0.5rem" }}>
          MORNING.INTEL
        </span>
      }
      className="flex-1 min-h-0 flex flex-col"
    >
      <div
        ref={scroller}
        className="hud-scroll overflow-y-auto flex flex-col gap-1 py-1"
        style={{ maxHeight: 190, minHeight: 90 }}
      >
        {wire.length === 0 && !tail && (
          <p className="hud-label py-2" style={{ fontSize: "0.55rem" }}>
            WIRE SILENT — DISPATCH AN INTENT
          </p>
        )}
        {wire.map((item) => (
          <p
            key={item.id}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.58rem",
              lineHeight: 1.55,
              color: item.channel === "trace" ? "var(--text-mute)" : "var(--text)",
            }}
          >
            <span style={{ color: "var(--accent-deep)", marginRight: 5 }}>•</span>
            {item.text}
          </p>
        ))}
        {tail && (
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.58rem",
              lineHeight: 1.55,
              color: "var(--accent)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {tail}
            <span className="pulse-dot" style={{ color: "var(--accent-hot)" }}>
              ▌
            </span>
          </p>
        )}
      </div>
    </Panel>
  );
}
