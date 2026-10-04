import type {
  CapabilityProfile,
  IntegrationDto,
  IntentDto,
  MetricDto,
  PluginDto,
  PrimaryDirectiveDto,
  SystemStatus,
} from "@nexus/core";
import { create } from "zustand";

export type ConnState = "connecting" | "online" | "lost";

interface SystemState {
  conn: ConnState;
  status: SystemStatus | null;
  capability: CapabilityProfile | null;
  intents: IntentDto[];
  integrations: IntegrationDto[];
  metrics: MetricDto[];
  primary: PrimaryDirectiveDto | null;
  plugins: PluginDto[];
  voice: { stt: boolean; tts: boolean };
  setConn(conn: ConnState): void;
  setStatus(status: SystemStatus): void;
  setCapability(c: CapabilityProfile): void;
  setIntegrations(i: IntegrationDto[]): void;
  setVitals(metrics: MetricDto[], primary: PrimaryDirectiveDto | null): void;
  hydrate(
    snap: Partial<
      Pick<
        SystemState,
        | "status"
        | "capability"
        | "intents"
        | "integrations"
        | "metrics"
        | "primary"
        | "plugins"
        | "voice"
      >
    >,
  ): void;
}

export const useSystemStore = create<SystemState>((set) => ({
  conn: "connecting",
  status: null,
  capability: null,
  intents: [],
  integrations: [],
  metrics: [],
  primary: null,
  plugins: [],
  voice: { stt: false, tts: false },
  setConn: (conn) => set({ conn }),
  setStatus: (status) => set({ status }),
  setCapability: (capability) => set({ capability }),
  setIntegrations: (integrations) => set({ integrations }),
  setVitals: (metrics, primary) => set({ metrics, primary }),
  hydrate: (snap) => set({ ...snap }),
}));
