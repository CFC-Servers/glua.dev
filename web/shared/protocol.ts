// WebSocket message protocol for glua.dev
// The same types are imported on both sides, so adding a new message variant
// is a single-file change that the compiler enforces everywhere

/** Anything the server pushes down a browser's WebSocket */
export type ServerMessage =
  // Raw output lines from the game console — ANSI-coded, rendered as-is
  | { type: "LOGS"; payload: string[] }
  // Full replay of prior output, sent once when a browser (re)connects
  | { type: "HISTORY"; payload: string }
  | { type: "HEALTH"; payload: HealthPayload }
  // Starts or updates the session countdown bar
  | { type: "SESSION_TIMER"; payload: SessionTimerPayload }
  | { type: "SESSION_CLOSED" }
  // Branch/version info the agent reports on boot
  | { type: "CONTEXT_UPDATE"; payload: SessionMetadata }
  // A script the user just ran — surfaced inline in the console as a clickable link
  | { type: "SCRIPT_EXECUTED"; payload: ScriptExecutedPayload }
  | { type: "SCRIPT_HISTORY"; payload: Record<string, ScriptEntry> };

/** Anything the browser sends up */
export type ClientMessage =
  | { type: "COMMAND"; payload: string }
  | { type: "SCRIPT"; payload: ScriptPayload }
  | { type: "REQUEST_EXTENSION" }
  | { type: "CLOSE_SESSION" };

/** What the container's agent process sends to the DO */
export type AgentMessage =
  | { type: "LOG"; payload: string | string[] }
  | { type: "HEALTH"; payload: HealthPayload }
  | { type: "METADATA"; payload: AgentMetadataPayload }
  | { type: "AGENT_SHUTDOWN" };

export type CloseReason =
  | "clean"
  | "timer_expired"
  | "agent_shutdown"
  | "container_stopped"
  | "container_error"
  | "container_start_failed"
  | "agent_ws_close"
  | "agent_ws_error"
  | "deploy_rollout";

export interface SessionMetadata {
  branch: string;
  gameVersion: string;
  containerTag: string;
  startedAt: number;
  endedAt?: number;
  closeReason?: CloseReason;
}

export interface SessionTimerPayload {
  endTime: number;
  duration: number;
  extensionThreshold: number;
}

export interface HealthPayload {
  cpuusage?: number;
  diskusage?: number;
}

export interface ScriptEntry {
  content: string;
  logLine: number;
}

export interface ScriptPayload {
  name?: string;
  content: string;
}

export interface ScriptExecutedPayload {
  name: string;
  content: string;
  logLine: number;
}

export interface AgentMetadataPayload {
  branch: string;
  gameVersion: string;
  containerTag: string;
}
