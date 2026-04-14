import type { SessionManager } from "./queue/manager";

/** Cloudflare Worker bindings for glua.dev */
export interface Env {
  /** Session DOs — one namespace per GMod branch */
  GMOD_PUBLIC: DurableObjectNamespace;
  GMOD_SIXTYFOUR: DurableObjectNamespace;
  GMOD_PRERELEASE: DurableObjectNamespace;
  GMOD_DEV: DurableObjectNamespace;

  /** Global singleton that manages session allocation and the waiting queue */
  SESSION_MANAGER: DurableObjectNamespace<SessionManager>;

  /** Stores session logs and script history */
  LOG_BUCKET: R2Bucket;

  /** Optional — when set, fires Discord webhook notifications for observability */
  DISCORD_WEBHOOK_URL?: string;

  /** Bearer token required to call /api/broadcast — matches GLUA_BROADCAST_TOKEN in .env */
  BROADCAST_TOKEN?: string;
}
