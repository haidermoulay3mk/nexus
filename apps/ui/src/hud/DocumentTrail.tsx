import { Panel } from "../components/Panel";
import { fmtAgo } from "../lib/format";
import { useDocsStore } from "../state/useDocsStore";

/** Left column: the persisted document trail (vault). */
export function DocumentTrail() {
  const documents = useDocsStore((s) => s.documents);
  const shown = documents.slice(0, 7);

  return (
    <Panel
      title="DOCUMENTS"
      titleRight={
        <span className="hud-label" style={{ fontSize: "0.5rem" }}>
          INBOX.TRAIL
        </span>
      }
    >
      <ul className="flex flex-col py-0.5">
        {shown.length === 0 && (
          <li className="hud-label py-2" style={{ fontSize: "0.55rem" }}>
            VAULT EMPTY — RUN AN INTENT
          </li>
        )}
        {shown.map((d) => (
          <li
            key={d.id}
            className="flex items-center justify-between py-1 border-b last:border-0"
            style={{ borderColor: "color-mix(in srgb, var(--line-hairline) 55%, transparent)" }}
          >
            <span
              style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--text)" }}
            >
              {d.title.length > 30 ? `${d.title.slice(0, 30)}…` : d.title}
            </span>
            <span className="hud-label" style={{ fontSize: "0.5rem" }}>
              {fmtAgo(d.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
