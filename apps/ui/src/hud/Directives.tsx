import { useState } from "react";
import { Panel } from "../components/Panel";
import { sendCommand } from "../lib/api";
import { useDocsStore } from "../state/useDocsStore";

/** Left column: the operator's standing directives (checklist). */
export function Directives() {
  const directives = useDocsStore((s) => s.directives);
  const [draft, setDraft] = useState("");
  const open = directives.filter((d) => !d.done).slice(0, 6);

  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await sendCommand({ type: "directive.add", text });
  };

  return (
    <Panel
      title="DIRECTIVES"
      titleRight={
        <span className="hud-label" style={{ fontSize: "0.5rem" }}>
          TOP.{open.length || 0}
        </span>
      }
    >
      <ul className="flex flex-col gap-1.5 py-1">
        {open.length === 0 && (
          <li className="hud-label" style={{ fontSize: "0.55rem" }}>
            NO OPEN DIRECTIVES
          </li>
        )}
        {open.map((d) => (
          <li key={d.id} className="flex items-start gap-2 group">
            <button
              type="button"
              aria-label="complete directive"
              onClick={() =>
                void sendCommand({ type: "directive.toggle", directiveId: d.id, done: true })
              }
              className="mt-0.5 shrink-0 cursor-pointer"
              style={{
                width: 9,
                height: 9,
                border: "1px solid var(--accent-deep)",
                background: "transparent",
              }}
            />
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.62rem",
                color: "var(--text)",
                lineHeight: 1.5,
              }}
            >
              {d.text}
            </span>
          </li>
        ))}
      </ul>
      <div
        className="flex items-center gap-1 mt-1 border-t pt-1.5"
        style={{ borderColor: "var(--line-hairline)" }}
      >
        <span style={{ color: "var(--accent-deep)", fontSize: "0.6rem" }}>+</span>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
          placeholder="ADD DIRECTIVE"
          className="w-full bg-transparent outline-none"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.6rem",
            color: "var(--text)",
            letterSpacing: "0.05em",
          }}
        />
      </div>
    </Panel>
  );
}
