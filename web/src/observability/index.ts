import { post } from "./webhook";
import {
  buildErrorEmbed,
  buildQueueEnteredEmbed,
  buildSessionEndedEmbed,
  buildSessionStartedEmbed,
  buildWarningEmbed,
} from "./embeds";
import type {
  ErrorEvent,
  QueueEnteredEvent,
  SessionEndedEvent,
  SessionStartedEvent,
  WarningEvent,
} from "./types";

export type { CapacitySnapshot, CloseReason, RequestContext } from "./types";
export { extractRequestContext, serializeContext, parseContext, OBS_CONTEXT_HEADER } from "./context";

type Env = { DISCORD_WEBHOOK_URL?: string };

export const notify = {
  sessionStarted: (env: Env, event: SessionStartedEvent) =>
    post(env, { embeds: [buildSessionStartedEmbed(event)] }),
  sessionEnded: (env: Env, event: SessionEndedEvent) =>
    post(env, {
      embeds: [buildSessionEndedEmbed(event)],
      ...(event.replyTo ? { message_reference: { message_id: event.replyTo } } : {}),
    }),
  queueEntered: (env: Env, event: QueueEnteredEvent) =>
    post(env, { embeds: [buildQueueEnteredEmbed(event)] }),
  error: (env: Env, event: ErrorEvent) =>
    post(env, { embeds: [buildErrorEmbed(event)] }),
  warning: (env: Env, event: WarningEvent) =>
    post(env, { embeds: [buildWarningEmbed(event)] }),
} as const;
