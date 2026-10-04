import type { CardDto, RunSummary, WireItemDto } from "@nexus/core";
import { create } from "zustand";

interface RunState {
  /** runs currently queued/active, keyed by id */
  runs: Map<string, RunSummary>;
  /** rolling stream of model tokens (drives AI WIRE typewriter) */
  liveTokens: string;
  wire: WireItemDto[];
  cards: CardDto[];
  /** monotonically increases on run.started — pulses the nebula */
  activityPulse: number;
  anyActive: boolean;
  upsertRun(run: RunSummary): void;
  appendToken(token: string): void;
  appendWire(item: WireItemDto): void;
  setWire(items: WireItemDto[]): void;
  setCards(cards: CardDto[]): void;
  upsertCard(card: CardDto): void;
  clearCards(): void;
  moveCardLocal(id: string, x: number, y: number): void;
}

const MAX_LIVE = 1600;
const MAX_WIRE = 40;

export const useRunStore = create<RunState>((set, get) => ({
  runs: new Map(),
  liveTokens: "",
  wire: [],
  cards: [],
  activityPulse: 0,
  anyActive: false,

  upsertRun: (run) => {
    const runs = new Map(get().runs);
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      runs.delete(run.id);
    } else {
      runs.set(run.id, run);
    }
    const anyActive = [...runs.values()].some((r) => r.status === "active");
    set({
      runs,
      anyActive,
      activityPulse: run.status === "active" ? get().activityPulse + 1 : get().activityPulse,
    });
  },

  appendToken: (token) => {
    const next = (get().liveTokens + token).slice(-MAX_LIVE);
    set({ liveTokens: next });
  },

  appendWire: (item) => {
    if (get().wire.some((w) => w.id === item.id)) return; // dedupe replays
    set({ wire: [...get().wire, item].slice(-MAX_WIRE) });
  },
  setWire: (items) => set({ wire: items.slice(-MAX_WIRE) }),
  setCards: (cards) => set({ cards }),
  upsertCard: (card) => {
    const cards = get().cards.filter((c) => c.id !== card.id);
    set({ cards: [...cards, card] });
  },
  clearCards: () => set({ cards: [] }),
  moveCardLocal: (id, x, y) =>
    set({ cards: get().cards.map((c) => (c.id === id ? { ...c, x, y } : c)) }),
}));
