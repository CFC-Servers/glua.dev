import { writable } from 'svelte/store';

export const isEditorOpen = writable(false);
export type SessionState = "connecting" | "provisioning" | "active" | "closed" | "readonly";
export const sessionState = writable<SessionState>("connecting");
