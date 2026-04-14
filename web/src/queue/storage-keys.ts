// Key schema for SessionManager's Durable Object storage
// One place to check if you're ever wondering what keys exist

export const SESSION_PREFIX = "session:";
export const QUEUE_PREFIX = "queue:";
export const RESOLVED_PREFIX = "resolved:";

export const sessionKey = (sessionId: string) => `${SESSION_PREFIX}${sessionId}`;
export const queueKey = (ticketId: string) => `${QUEUE_PREFIX}${ticketId}`;
export const resolvedKey = (ticketId: string) => `${RESOLVED_PREFIX}${ticketId}`;

export const stripSessionPrefix = (key: string) => key.slice(SESSION_PREFIX.length);
export const stripResolvedPrefix = (key: string) => key.slice(RESOLVED_PREFIX.length);
