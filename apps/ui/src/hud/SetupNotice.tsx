import { Panel } from "../components/Panel";
import { useSystemStore } from "../state/useSystemStore";

/**
 * First-run / degraded-state notice. Rendered over the stage when the local
 * model is missing — with the exact free steps to fix it. Nexus never asks
 * for money or an account.
 */
export function SetupNotice() {
  const status = useSystemStore((s) => s.status);
  const conn = useSystemStore((s) => s.conn);

  if (conn === "lost") {
    return (
      <div className="absolute left-1/2 top-[30%] -translate-x-1/2 z-40 w-[420px]">
        <Panel title="RUNNER LINK LOST" active>
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.62rem",
              lineHeight: 1.7,
              color: "var(--text)",
            }}
          >
            Reconnecting to the local runner… If this persists, start it with{" "}
            <span style={{ color: "var(--accent)" }}>bun run dev:runner</span>.
          </p>
        </Panel>
      </div>
    );
  }

  if (!status || status.ollama === "ready" || status.ollama === "starting") return null;

  return (
    <div className="absolute left-1/2 top-[26%] -translate-x-1/2 z-40 w-[460px]">
      <Panel title="LOCAL MODEL OFFLINE" active>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            lineHeight: 1.8,
            color: "var(--text)",
          }}
        >
          <p>Nexus thinks with a local model via Ollama — free, offline, private.</p>
          <ol className="list-decimal ml-4 mt-2" style={{ color: "var(--text-mute)" }}>
            <li>
              Install Ollama (free):{" "}
              <span style={{ color: "var(--accent)" }}>ollama.com/download</span>
            </li>
            <li>
              Pull the chat model:{" "}
              <span style={{ color: "var(--accent)" }}>ollama pull qwen2.5:7b-instruct-q4_K_M</span>
            </li>
            <li>
              Pull embeddings:{" "}
              <span style={{ color: "var(--accent)" }}>ollama pull nomic-embed-text</span>
            </li>
          </ol>
          <p className="mt-2" style={{ color: "var(--text-mute)" }}>
            Nexus re-checks automatically — this panel disappears when the model is live.
          </p>
        </div>
      </Panel>
    </div>
  );
}
