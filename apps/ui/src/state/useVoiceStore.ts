import type { VoiceState } from "@nexus/core";
import { create } from "zustand";

interface VoiceStoreState {
  state: VoiceState;
  /** true while the user is holding push-to-talk locally */
  holding: boolean;
  transcript: string;
  speakingText: string | null;
  micLevel: number;
  setState(state: VoiceState): void;
  setHolding(holding: boolean): void;
  setTranscript(t: string): void;
  setSpeaking(text: string | null): void;
  setMicLevel(v: number): void;
}

export const useVoiceStore = create<VoiceStoreState>((set) => ({
  state: "standby",
  holding: false,
  transcript: "",
  speakingText: null,
  micLevel: 0,
  setState: (state) => set({ state }),
  setHolding: (holding) => set({ holding }),
  setTranscript: (transcript) => set({ transcript }),
  setSpeaking: (speakingText) => set({ speakingText }),
  setMicLevel: (micLevel) => set({ micLevel }),
}));
