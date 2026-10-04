import type { NexusEvent, NexusEventType } from "@nexus/core";

type Listener = (event: NexusEvent) => void;

/**
 * In-process event bus. The WS server subscribes and fans every event out
 * to connected HUD clients; internal services subscribe for reactions
 * (e.g. TTS on run completion).
 */
export class EventBus {
  private listeners = new Set<Listener>();
  /** small replay buffer so a reconnecting HUD repaints instantly */
  private replay: NexusEvent[] = [];
  private static REPLAY_TYPES: NexusEventType[] = [
    "system.status",
    "capability.tiers",
    "link.status",
    "vitals.update",
    "directives.update",
  ];

  emit<T extends NexusEventType>(
    type: T,
    payload: Extract<NexusEvent, { type: T }>["payload"],
  ): void {
    // Payload is statically tied to `type` by the signature; the cast only
    // reassembles the discriminated union TS cannot infer across generics.
    const event = { type, ts: new Date().toISOString(), payload } as NexusEvent;
    if (EventBus.REPLAY_TYPES.includes(type)) {
      this.replay = this.replay.filter((e) => e.type !== type);
      this.replay.push(event);
    }
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        console.error(`[bus] listener failed for ${type}:`, e);
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** latest snapshot events, sent to every new WS client */
  snapshot(): NexusEvent[] {
    return [...this.replay];
  }
}
