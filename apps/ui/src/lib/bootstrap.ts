import type {
  CapabilityProfile,
  CardDto,
  DirectiveDto,
  DocumentDto,
  IntegrationDto,
  IntentDto,
  MetricDto,
  PluginDto,
  PrimaryDirectiveDto,
  SystemStatus,
  WireItemDto,
} from "@nexus/core";
import { useDocsStore } from "../state/useDocsStore";
import { useRunStore } from "../state/useRunStore";
import { useSystemStore } from "../state/useSystemStore";
import { apiGet } from "./api";
import { connectBus } from "./ws";

interface StateSnapshot {
  status: SystemStatus;
  capability: CapabilityProfile;
  intents: IntentDto[];
  cards: CardDto[];
  documents: DocumentDto[];
  wire: WireItemDto[];
  directives: DirectiveDto[];
  metrics: MetricDto[];
  primary: PrimaryDirectiveDto | null;
  plugins: PluginDto[];
  integrations: IntegrationDto[];
  voice: { stt: boolean; tts: boolean; state: string };
}

/** Fetch the full snapshot, hydrate stores, then attach the live bus. */
export async function bootstrap(): Promise<void> {
  try {
    const snap = await apiGet<StateSnapshot>("/state");
    useSystemStore.getState().hydrate({
      status: snap.status,
      capability: snap.capability,
      intents: snap.intents,
      integrations: snap.integrations,
      metrics: snap.metrics,
      primary: snap.primary,
      plugins: snap.plugins,
      voice: { stt: snap.voice.stt, tts: snap.voice.tts },
    });
    useRunStore.getState().setCards(snap.cards);
    useRunStore.getState().setWire(snap.wire);
    useDocsStore.getState().setDocuments(snap.documents);
    useDocsStore.getState().setDirectives(snap.directives);
  } catch (e) {
    console.error("[bootstrap] snapshot failed (runner offline?):", e);
    useSystemStore.getState().setConn("lost");
    // Bus will keep retrying; snapshot re-fetches on reconnect below.
    setTimeout(bootstrap, 2_000);
    return;
  }
  connectBus();
}
