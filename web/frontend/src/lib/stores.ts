import { writable } from "svelte/store";

export const isEditorOpen = writable(false);
export type SessionState = "connecting" | "provisioning" | "active" | "closed" | "readonly";
export const sessionState = writable<SessionState>("connecting");
export interface ScriptEntry {
    content: string;
    logLine: number;
}
export const scriptMap = writable<Record<string, ScriptEntry>>({});
export const viewingScript = writable<{ name: string; content: string } | null>(null);
export const sessionMetadata = writable<{ branch: string; gameVersion: string; containerTag: string; startedAt: number; endedAt?: number } | null>(null);
export const sessionTimer = writable<{ endTime: number; duration: number; extensionThreshold: number } | null>(null);
