import { writable } from 'svelte/store';

export const isEditorOpen = writable(false);
export type SessionState = "connecting" | "provisioning" | "active" | "closed" | "readonly";
export const sessionState = writable<SessionState>("connecting");
export const scriptMap = writable<Record<string, string>>({});
export const viewingScript = writable<{ name: string; content: string } | null>(null);
