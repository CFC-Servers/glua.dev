// Server-side timing and capacity constants
// Shared constants (session types, limits) live in @glua/shared

export const SESSION_TIMING = {
  /** How long a fresh session lasts */
  duration: 10 * 60_000,
  /** Absolute ceiling — extensions can't push past this */
  hardLimit: 15 * 60_000,
  /** Time added when a user requests an extension */
  extension: 5 * 60_000,
  /** Show the "need more time?" prompt when this much time is left */
  extensionThreshold: 2 * 60_000,
  /** How often we ping the container and flush logs to R2 */
  activityPing: 30_000,
} as const;

export const QUEUE_TIMING = {
  /** Queue entries older than this are garbage-collected */
  entryTtl: 5 * 60_000,
  /** Resolved tickets stick around this long for the client to claim */
  resolvedTtl: 2 * 60_000,
  /** Alarm interval for TTL cleanup */
  cleanupInterval: 30_000,
} as const;

export const CAPACITY = {
  maxTotal: 12,
  maxPerType: {
    public: 10,
    "sixty-four": 5,
    prerelease: 2,
    dev: 2,
  },
} as const satisfies { maxTotal: number; maxPerType: Record<string, number> };
