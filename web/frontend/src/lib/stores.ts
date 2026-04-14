import { writable } from "svelte/store";
import type { SessionMetadata, SessionTimerPayload, ScriptEntry } from "@glua/shared";

export type SessionState = "connecting" | "provisioning" | "active" | "closed" | "readonly";

export const isEditorOpen = writable(false);
export const sessionState = writable<SessionState>("connecting");
export const scriptMap = writable<Record<string, ScriptEntry>>({});
export const viewingScript = writable<{ name: string; content: string } | null>(null);
export const sessionMetadata = writable<SessionMetadata | null>(null);
export const sessionTimer = writable<SessionTimerPayload | null>(null);
