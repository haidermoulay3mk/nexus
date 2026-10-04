import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import { sendCommand } from "../lib/api";
import { useSystemStore } from "../state/useSystemStore";

/**
 * ⌘K / Ctrl+K palette: type to filter intents, Enter to dispatch.
 * Free text that matches no intent is routed to the Planner via
 * the `nexus.command` intent.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const intents = useSystemStore((s) => s.intents);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQuery("");
        setCursor(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const deck = intents.filter((i) => i.key !== "nexus.command" && !i.hidden);
    if (!q) return deck;
    return deck.filter(
      (i) => i.label.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
    );
  }, [query, intents]);

  const dispatch = async () => {
    const chosen = matches[cursor];
    if (chosen) {
      await sendCommand({ type: "intent.dispatch", intentKey: chosen.key, input: null });
    } else if (query.trim().length > 2) {
      await sendCommand({
        type: "intent.dispatch",
        intentKey: "nexus.command",
        input: query.trim(),
      });
    }
    setOpen(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[80]"
          style={{ background: "rgba(10,7,5,0.75)", backdropFilter: "blur(3px)" }}
        />
        <Dialog.Content
          className="fixed left-1/2 top-[22%] z-[81] -translate-x-1/2 w-[480px] outline-none"
          style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--line-hairline)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--glow)",
          }}
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <div
            className="flex items-center gap-2 px-3 py-2 border-b"
            style={{ borderColor: "var(--line-hairline)" }}
          >
            <span
              style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: "0.7rem" }}
            >
              ❯
            </span>
            <input
              // the palette input must focus the moment the dialog opens
              ref={(el) => el?.focus()}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void dispatch();
                if (e.key === "ArrowDown") setCursor((c) => Math.min(matches.length - 1, c + 1));
                if (e.key === "ArrowUp") setCursor((c) => Math.max(0, c - 1));
              }}
              placeholder="TYPE AN INTENT OR A COMMAND…"
              className="w-full bg-transparent outline-none"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.7rem",
                letterSpacing: "0.08em",
                color: "var(--text-hi)",
              }}
            />
            <kbd className="hud-label" style={{ fontSize: "0.45rem" }}>
              ESC
            </kbd>
          </div>
          <ul className="hud-scroll max-h-[260px] overflow-y-auto py-1">
            {matches.map((i, idx) => (
              <li key={i.key}>
                <button
                  type="button"
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => void dispatch()}
                  className="w-full text-left px-3 py-1.5 cursor-pointer"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.6rem",
                    letterSpacing: "0.1em",
                    color: idx === cursor ? "var(--accent)" : "var(--text)",
                    background:
                      idx === cursor
                        ? "color-mix(in srgb, var(--accent) 8%, transparent)"
                        : "transparent",
                  }}
                >
                  <span style={{ color: "var(--accent-deep)", marginRight: 8 }}>▸</span>
                  {i.label}
                  <span className="hud-label ml-3" style={{ fontSize: "0.45rem" }}>
                    {i.agent.toUpperCase()}
                  </span>
                </button>
              </li>
            ))}
            {matches.length === 0 && (
              <li className="px-3 py-2 hud-label" style={{ fontSize: "0.55rem" }}>
                ↵ ROUTE TO PLANNER: “{query.trim().slice(0, 40)}”
              </li>
            )}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
