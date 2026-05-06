import { derived, readable, writable } from "svelte/store";
import type { SessionMetadata, SessionTimerPayload, ScriptEntry } from "@glua/shared";

export type SessionState = "connecting" | "provisioning" | "active" | "closed" | "readonly";

export const isEditorOpen = writable(false);
export const sessionState = writable<SessionState>("connecting");
export const scriptMap = writable<Record<string, ScriptEntry>>({});
export const viewingScript = writable<{ name: string; content: string } | null>(null);
export const sessionMetadata = writable<SessionMetadata | null>(null);
export const sessionTimer = writable<SessionTimerPayload | null>(null);

const clock = readable(Date.now(), (set) => {
    const id = setInterval(() => set(Date.now()), 1000);
    return () => clearInterval(id);
});

export const sessionTimeRemaining = derived(
    [sessionTimer, clock],
    ([$t, $c]) => ($t ? Math.max(0, $t.endTime - $c) : 0),
);
