import { z } from "zod";
import {
  CapabilityProfile,
  CardDto,
  DirectiveDto,
  DocumentDto,
  IntegrationDto,
  MetricDto,
  PrimaryDirectiveDto,
  RunStepKind,
  RunSummary,
  SystemStatus,
  VoiceState,
  WireItemDto,
} from "./types";

/* ------------------------------------------------------------------ */
/* Runner → UI events (WebSocket)                                      */
/* Every frame is { type, ts, payload }.                               */
/* ------------------------------------------------------------------ */

const ev = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({ type: z.literal(type), ts: z.string(), payload });

export const SystemStatusEvent = ev("system.status", SystemStatus);
export const CapabilityTiersEvent = ev("capability.tiers", CapabilityProfile);
export const LinkStatusEvent = ev(
  "link.status",
  z.object({ integrations: z.array(IntegrationDto) }),
);

export const RunQueuedEvent = ev("run.queued", RunSummary);
export const RunStartedEvent = ev("run.started", RunSummary);
export const RunStepEvent = ev(
  "run.step",
  z.object({
    runId: z.string(),
    idx: z.number().int().nonnegative(),
    kind: RunStepKind,
    name: z.string(),
    detail: z.string(),
    ms: z.number().nonnegative().nullable(),
  }),
);
export const RunTokenEvent = ev("run.token", z.object({ runId: z.string(), token: z.string() }));
export const RunCompletedEvent = ev("run.completed", RunSummary);
export const RunFailedEvent = ev("run.failed", RunSummary);

export const CardCreatedEvent = ev("card.created", CardDto);
export const CardUpdatedEvent = ev("card.updated", CardDto);
export const CardsClearedEvent = ev("cards.cleared", z.object({ count: z.number().int() }));

export const VitalsUpdateEvent = ev(
  "vitals.update",
  z.object({
    metrics: z.array(MetricDto),
    primary: PrimaryDirectiveDto.nullable(),
  }),
);

export const WireAppendEvent = ev("wire.append", WireItemDto);
export const DocumentCreatedEvent = ev("document.created", DocumentDto);
export const DirectivesUpdateEvent = ev(
  "directives.update",
  z.object({ directives: z.array(DirectiveDto) }),
);

export const VoiceListeningEvent = ev("voice.listening", z.object({ on: z.boolean() }));
export const VoiceTranscriptEvent = ev(
  "voice.transcript",
  z.object({ text: z.string(), final: z.boolean() }),
);
export const VoiceSpeakingEvent = ev(
  "voice.speaking",
  z.object({ on: z.boolean(), text: z.string().nullable() }),
);
export const VoiceStateEvent = ev("voice.state", z.object({ state: VoiceState }));

export const ToastEvent = ev(
  "toast",
  z.object({
    level: z.enum(["info", "ok", "warn", "err"]),
    title: z.string(),
    body: z.string().nullable(),
  }),
);

export const NexusEvent = z.discriminatedUnion("type", [
  SystemStatusEvent,
  CapabilityTiersEvent,
  LinkStatusEvent,
  RunQueuedEvent,
  RunStartedEvent,
  RunStepEvent,
  RunTokenEvent,
  RunCompletedEvent,
  RunFailedEvent,
  CardCreatedEvent,
  CardUpdatedEvent,
  CardsClearedEvent,
  VitalsUpdateEvent,
  WireAppendEvent,
  DocumentCreatedEvent,
  DirectivesUpdateEvent,
  VoiceListeningEvent,
  VoiceTranscriptEvent,
  VoiceSpeakingEvent,
  VoiceStateEvent,
  ToastEvent,
]);
export type NexusEvent = z.infer<typeof NexusEvent>;
export type NexusEventType = NexusEvent["type"];

/* ------------------------------------------------------------------ */
/* UI → Runner commands                                                */
/* ------------------------------------------------------------------ */

export const IntentDispatchCmd = z.object({
  type: z.literal("intent.dispatch"),
  intentKey: z.string(),
  /** free-form input, e.g. a voice transcript for `nexus.command` */
  input: z.string().nullable().default(null),
});

export const RunCancelCmd = z.object({
  type: z.literal("run.cancel"),
  runId: z.string(),
});

export const VoiceStartCmd = z.object({ type: z.literal("voice.start") });
export const VoiceStopCmd = z.object({ type: z.literal("voice.stop") });

export const SettingsUpdateCmd = z.object({
  type: z.literal("settings.update"),
  patch: z.record(z.unknown()),
});

export const PluginToggleCmd = z.object({
  type: z.literal("plugin.toggle"),
  pluginId: z.string(),
  enabled: z.boolean(),
});

export const CardMoveCmd = z.object({
  type: z.literal("card.move"),
  cardId: z.string(),
  x: z.number(),
  y: z.number(),
});

export const CardsClearCmd = z.object({ type: z.literal("cards.clear") });

export const DirectiveToggleCmd = z.object({
  type: z.literal("directive.toggle"),
  directiveId: z.string(),
  done: z.boolean(),
});

export const DirectiveAddCmd = z.object({
  type: z.literal("directive.add"),
  text: z.string().min(1),
});

export const ClientCommand = z.discriminatedUnion("type", [
  IntentDispatchCmd,
  RunCancelCmd,
  VoiceStartCmd,
  VoiceStopCmd,
  SettingsUpdateCmd,
  PluginToggleCmd,
  CardMoveCmd,
  CardsClearCmd,
  DirectiveToggleCmd,
  DirectiveAddCmd,
]);
export type ClientCommand = z.infer<typeof ClientCommand>;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function makeEvent<T extends NexusEventType>(
  type: T,
  payload: Extract<NexusEvent, { type: T }>["payload"],
): Extract<NexusEvent, { type: T }> {
  return { type, ts: new Date().toISOString(), payload } as Extract<NexusEvent, { type: T }>;
}
