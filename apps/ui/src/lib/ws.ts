import { NexusEvent } from "@nexus/core";
import { useDocsStore } from "../state/useDocsStore";
import { useRunStore } from "../state/useRunStore";
import { useSystemStore } from "../state/useSystemStore";
import { useVoiceStore } from "../state/useVoiceStore";
import { synthesize } from "./api";
import { wsUrl } from "./conn";

let socket: WebSocket | null = null;
let retryMs = 500;
let ttsAudio: HTMLAudioElement | null = null;

/** Connect the live event bus; auto-reconnects with backoff. Idempotent —
 *  a second call (e.g. React StrictMode double-mount) is a no-op. */
export function connectBus(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  const sys = useSystemStore.getState();
  sys.setConn("connecting");
  socket = new WebSocket(wsUrl());

  socket.onopen = () => {
    retryMs = 500;
    useSystemStore.getState().setConn("online");
  };

  socket.onclose = () => {
    useSystemStore.getState().setConn("lost");
    setTimeout(connectBus, retryMs);
    retryMs = Math.min(retryMs * 2, 8_000);
  };

  socket.onmessage = (raw) => {
    let event: NexusEvent;
    try {
      const parsed = NexusEvent.safeParse(JSON.parse(String(raw.data)));
      if (!parsed.success) return;
      event = parsed.data;
    } catch {
      return;
    }
    dispatch(event);
  };
}

export function sendWs(frame: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function dispatch(event: NexusEvent): void {
  const sys = useSystemStore.getState();
  const runs = useRunStore.getState();
  const docs = useDocsStore.getState();
  const voice = useVoiceStore.getState();

  switch (event.type) {
    case "system.status":
      sys.setStatus(event.payload);
      break;
    case "capability.tiers":
      sys.setCapability(event.payload);
      break;
    case "link.status":
      sys.setIntegrations(event.payload.integrations);
      break;
    case "run.queued":
    case "run.started":
    case "run.completed":
    case "run.failed":
      runs.upsertRun(event.payload);
      break;
    case "run.step":
      // steps surface in the wire as terse trace lines
      runs.appendWire({
        id: `step-${event.payload.runId}-${event.payload.idx}`,
        channel: "trace",
        text: `» ${event.payload.name}${event.payload.detail ? ` · ${event.payload.detail.slice(0, 60)}` : ""}`,
        createdAt: event.ts,
      });
      break;
    case "run.token":
      runs.appendToken(event.payload.token);
      break;
    case "card.created":
    case "card.updated":
      runs.upsertCard(event.payload);
      break;
    case "cards.cleared":
      runs.clearCards();
      break;
    case "vitals.update":
      sys.setVitals(event.payload.metrics, event.payload.primary);
      break;
    case "wire.append":
      runs.appendWire(event.payload);
      break;
    case "document.created":
      docs.addDocument(event.payload);
      break;
    case "directives.update":
      docs.setDirectives(event.payload.directives);
      break;
    case "voice.listening":
      voice.setState(event.payload.on ? "listening" : "standby");
      break;
    case "voice.transcript":
      voice.setTranscript(event.payload.text);
      break;
    case "voice.state":
      voice.setState(event.payload.state);
      break;
    case "voice.speaking":
      if (event.payload.on && event.payload.text) {
        voice.setSpeaking(event.payload.text);
        void playTts(event.payload.text);
      } else {
        voice.setSpeaking(null);
        stopTts();
      }
      break;
    case "toast":
      runs.appendWire({
        id: `toast-${event.ts}`,
        channel: "system",
        text: `${event.payload.level.toUpperCase()} · ${event.payload.title}`,
        createdAt: event.ts,
      });
      break;
    default: {
      const exhaustive: never = event;
      void exhaustive;
    }
  }
}

async function playTts(text: string): Promise<void> {
  const blob = await synthesize(text);
  if (!blob) {
    useVoiceStore.getState().setSpeaking(null);
    return;
  }
  stopTts();
  ttsAudio = new Audio(URL.createObjectURL(blob));
  ttsAudio.onended = () => useVoiceStore.getState().setSpeaking(null);
  void ttsAudio.play();
}

export function stopTts(): void {
  if (ttsAudio) {
    ttsAudio.pause();
    ttsAudio = null;
  }
  useVoiceStore.getState().setSpeaking(null);
}
