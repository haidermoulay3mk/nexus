import { Readout } from "../components/Readout";
import { useSystemStore } from "../state/useSystemStore";

/**
 * The oversized center number — the single metric the operator is living
 * by right now (metric key `primary.value`, label + unit from the DB).
 */
export function PrimaryDirective() {
  const primary = useSystemStore((s) => s.primary);
  if (!primary) return null;

  return (
    <div className="pointer-events-none select-none text-center" aria-live="polite">
      <div
        className="hud-label"
        style={{ fontSize: "0.6rem", color: "var(--text-mute)", marginBottom: 4 }}
      >
        <span style={{ color: "var(--accent-deep)" }}>—— </span>
        {primary.label}
        <span style={{ color: "var(--accent-deep)" }}> ——</span>
      </div>
      <div className="flex items-baseline justify-center gap-3">
        <Readout
          value={primary.value}
          mode="full"
          style={{
            fontFamily: "var(--font-hud)",
            fontSize: "5.5rem",
            fontWeight: 700,
            lineHeight: 0.95,
            color: "var(--text-hi)",
            textShadow: "0 0 32px rgba(255,140,66,0.25)",
          }}
        />
        <span className="hud-label" style={{ fontSize: "0.8rem", color: "var(--text-mute)" }}>
          {primary.unit}
        </span>
      </div>
      <div
        className="hud-label mt-2 flex justify-center gap-4"
        style={{
          fontSize: "0.52rem",
          borderTop: "1px solid var(--line-hairline)",
          paddingTop: 6,
          display: "inline-flex",
        }}
      >
        {primary.sublines.map((s) => (
          <span key={s}>{s}</span>
        ))}
      </div>
    </div>
  );
}
