export type CloseReason =
  | "clean"
  | "timer_expired"
  | "agent_shutdown"
  | "container_stopped"
  | "container_error"
  | "container_start_failed"
  | "agent_ws_close"
  | "agent_ws_error";

export interface RequestContext {
  ip: string;
  country?: string;
  region?: string;
  city?: string;
  colo?: string;
  asn?: number;
  asOrganization?: string;
  userAgent?: string;
}

export interface SessionStartedEvent {
  sessionId: string;
  branch: string;
  context: RequestContext;
}

export interface SessionEndedEvent {
  sessionId: string;
  branch: string;
  reason: CloseReason;
  startedAt?: number;
  endedAt: number;
  scriptCount: number;
  logLineCount: number;
  extensionGranted: boolean;
  context?: RequestContext;
}

export interface ErrorEvent {
  where: string;
  error: unknown;
  sessionId?: string;
  branch?: string;
  context?: RequestContext;
}

export interface WarningEvent {
  title: string;
  description: string;
  context?: RequestContext;
}
