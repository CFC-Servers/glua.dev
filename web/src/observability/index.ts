import {
  buildErrorEmbed,
  buildQueueEnteredEmbed,
  buildSessionEndedEmbed,
  buildSessionStartedEmbed,
  buildWarningEmbed,
} from "./embeds";
import type { ErrorEvent, QueueEnteredEvent, SessionEndedEvent, SessionStartedEvent, WarningEvent } from "./types";
import { post } from "./webhook";

export { extractRequestContext, OBS_CONTEXT_HEADER, parseContext, serializeContext } from "./context";
export type { CapacitySnapshot, CloseReason, RequestContext } from "./types";

type Env = { DISCORD_WEBHOOK_URL?: string };

export const notify = {
  sessionStarted: (env: Env, event: SessionStartedEvent) => post(env, { embeds: [buildSessionStartedEmbed(event)] }),
  sessionEnded: (env: Env, event: SessionEndedEvent) => post(env, { embeds: [buildSessionEndedEmbed(event)] }),
  queueEntered: (env: Env, event: QueueEnteredEvent) => post(env, { embeds: [buildQueueEnteredEmbed(event)] }),
  error: (env: Env, event: ErrorEvent) => post(env, { embeds: [buildErrorEmbed(event)] }),
  warning: (env: Env, event: WarningEvent) => post(env, { embeds: [buildWarningEmbed(event)] }),
} as const;
