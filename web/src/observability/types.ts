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

export interface CapacitySnapshot {
  branch: string;
  branchUsed: number;
  branchMax: number;
  totalUsed: number;
  totalMax: number;
  queueDepth: number;
}

export interface SessionStartedEvent {
  sessionId: string;
  branch: string;
  context: RequestContext;
  capacity?: CapacitySnapshot;
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
  /** Container process exit code, when the session ended because the container stopped */
  exitCode?: number;
  /** "exit" for a clean stop, "runtime_signal" for a killed process */
  exitReason?: string;
  context?: RequestContext;
  capacity?: CapacitySnapshot;
}

export interface QueueEnteredEvent {
  sessionType: string;
  position: number;
  capacity: CapacitySnapshot;
  context: RequestContext;
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
