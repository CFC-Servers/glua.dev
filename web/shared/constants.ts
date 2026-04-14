export const VALID_SESSION_TYPES = ["public", "sixty-four", "prerelease", "dev"] as const;
export type SessionType = (typeof VALID_SESSION_TYPES)[number];

export const MAX_SCRIPT_SIZE = 65_536;
export const MAX_SCRIPTS_PER_SESSION = 50;
export const MAX_SESSIONS_PER_IP = 2;
