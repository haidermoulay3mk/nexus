import { Panel } from "../components/Panel";
import { Readout } from "../components/Readout";
import { Sparkline } from "../components/Sparkline";
import { fmtDelta } from "../lib/format";
import { useSystemStore } from "../state/useSystemStore";

/** Left column: numeric readouts + sparklines for every recorded metric. */
export function SystemVitals() {
  const metrics = useSystemStore((s) => s.metrics);
  const shown = metrics.filter((m) => !m.key.startsWith("primary.")).slice(0, 5);

  return (
    <Panel
      title="SYSTEM VITALS"
      titleRight={
        <span className="hud-label" style={{ fontSize: "0.5rem" }}>
          LOCAL.LINK
        </span>
      }
    >
      {shown.length === 0 ? (
        <p className="hud-label py-3" style={{ fontSize: "0.55rem", color: "var(--text-mute)" }}>
          NO VITALS YET — RUN «METRICS PULL»
        </p>
      ) : (
        <ul className="flex flex-col gap-3 py-1">
          {shown.map((m) => (
            <li key={m.key}>
              <div className="flex items-center justify-between">
                <span className="hud-label" style={{ fontSize: "0.55rem" }}>
                  <span style={{ color: "var(--accent-deep)", marginRight: 4 }}>•</span>
                  {m.label}
                </span>
                <span
                  className="hud-num"
                  style={{
                    fontSize: "0.55rem",
                    color: (m.delta ?? 0) > 0 ? "var(--accent)" : "var(--text-mute)",
                  }}
                >
                  {fmtDelta(m.delta, m.deltaUnit)}
                </span>
              </div>
              <div className="flex items-end justify-between mt-0.5">
                <Readout
                  value={m.value}
                  style={{
                    fontFamily: "var(--font-hud)",
                    fontSize: "1.9rem",
                    fontWeight: 600,
                    lineHeight: 1,
                  }}
                />
                <Sparkline series={m.series} width={110} height={24} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
