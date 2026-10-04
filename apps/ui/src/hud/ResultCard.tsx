import type { CardDto } from "@nexus/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRef } from "react";
import { Panel } from "../components/Panel";
import { cardVariants } from "../design/motion";
import { sendCommand } from "../lib/api";
import { mdPreview } from "../lib/format";
import { useRunStore } from "../state/useRunStore";

const CARD_W = 240;

function ResultCard({
  card,
  stage,
}: { card: CardDto; stage: React.RefObject<HTMLDivElement | null> }) {
  const move = useRunStore((s) => s.moveCardLocal);
  const preview = mdPreview(card.bodyMd);
  return (
    <motion.div
      layout
      drag
      dragConstraints={stage}
      dragMomentum={false}
      variants={cardVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      onDragEnd={(_e, _info) => {
        const el = stage.current;
        if (!el) return;
        // persist the normalized position
        const rect = el.getBoundingClientRect();
        const self = (_e.target as HTMLElement).getBoundingClientRect?.();
        if (!self) return;
        const x = Math.min(1, Math.max(0, (self.left - rect.left + self.width / 2) / rect.width));
        const y = Math.min(1, Math.max(0, (self.top - rect.top + self.height / 2) / rect.height));
        move(card.id, x, y);
        void sendCommand({ type: "card.move", cardId: card.id, x, y });
      }}
      className="absolute cursor-grab active:cursor-grabbing pointer-events-auto"
      style={{
        width: CARD_W,
        left: `calc(${card.x * 100}% - ${CARD_W / 2}px)`,
        top: `${card.y * 100}%`,
        zIndex: 20,
      }}
    >
      <Panel
        title={card.title.length > 26 ? `${card.title.slice(0, 26)}…` : card.title}
        titleRight={
          <span className="hud-label whitespace-nowrap" style={{ fontSize: "0.45rem" }}>
            {card.kind.toUpperCase()}
          </span>
        }
      >
        <p
          className="hud-scroll overflow-y-auto"
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "0.62rem",
            lineHeight: 1.55,
            color: "var(--text)",
            maxHeight: 90,
            whiteSpace: "pre-wrap",
          }}
        >
          {preview.slice(0, 350)}
          {preview.length > 350 ? "…" : ""}
        </p>
      </Panel>
    </motion.div>
  );
}

/** The center stage: floating draggable result cards + CLEAR ALL. */
export function CardStage() {
  const cards = useRunStore((s) => s.cards);
  const stage = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  return (
    <div ref={stage} className="absolute inset-0 pointer-events-none" style={{ zIndex: 15 }}>
      {cards.length > 0 && (
        <motion.button
          type="button"
          initial={reduced ? undefined : { opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          onClick={() => void sendCommand({ type: "cards.clear" })}
          className="absolute left-1/2 -translate-x-1/2 top-2 pointer-events-auto cursor-pointer px-3 py-1"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.55rem",
            letterSpacing: "0.15em",
            color: "var(--text)",
            border: "1px solid var(--line-hairline)",
            background: "color-mix(in srgb, var(--bg-panel) 85%, transparent)",
            borderRadius: "var(--radius)",
            zIndex: 30,
          }}
        >
          CLEAR ALL ×{cards.length}
        </motion.button>
      )}
      <AnimatePresence>
        {cards.map((card) => (
          <ResultCard key={card.id} card={card} stage={stage} />
        ))}
      </AnimatePresence>
    </div>
  );
}
