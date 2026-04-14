import type { CloseReason } from "@glua/shared";
import type { VirtualConsole } from "./virtual-console";

const MAX_ATTEMPTS = 5;

const RETRY_MESSAGES = [
  "Connection lost. Trying to reconnect...",
  "still trying...",
  "hang tight, one more try...",
  "still no luck, trying again...",
  "last try...",
];

export type AbnormalCloseResult = "ended" | "retrying";

export class ReconnectionController {
  private attempts = 0;
  private line: ReturnType<VirtualConsole["addSpinnerLine"]> | null = null;

  constructor(
    private readonly virtualConsole: VirtualConsole,
    private readonly getSessionId: () => string | null,
    private readonly retry: () => void,
  ) {}

  get isReconnecting(): boolean {
    return this.attempts > 0;
  }

  handleOpen(): "initial" | "reconnected" {
    if (this.attempts > 0) {
      this.line?.finalize("\u001b[32mReconnected.\u001b[0m");
      this.line = null;
      this.attempts = 0;
      return "reconnected";
    }
    return "initial";
  }

  handleCleanClose(): void {
    this.line?.remove();
    this.line = null;
  }

  async handleAbnormalClose(): Promise<AbnormalCloseResult> {
    const reason = await this.fetchCloseReason();
    if (reason !== null) {
      this.line?.remove();
      this.line = null;
      this.virtualConsole.addLines([messageForCloseReason(reason)]);
      return "ended";
    }

    if (this.attempts < MAX_ATTEMPTS) {
      this.attempts++;
      const delay = Math.min(1000 * 2 ** (this.attempts - 1), 10000);
      const label = RETRY_MESSAGES[Math.min(this.attempts - 1, RETRY_MESSAGES.length - 1)];
      const text = `${label} \u001b[90m(${this.attempts}/${MAX_ATTEMPTS})\u001b[0m`;
      if (this.line) {
        this.line.update(text);
      } else {
        this.line = this.virtualConsole.addSpinnerLine(text);
      }
      setTimeout(() => this.retry(), delay);
      return "retrying";
    }

    this.line?.finalize("\u001b[31mCouldn't reconnect. The session may have ended.\u001b[0m");
    this.line = null;
    return "ended";
  }

  dispose(): void {
    this.line?.remove();
    this.line = null;
  }

  private async fetchCloseReason(): Promise<string | null> {
    const sessionId = this.getSessionId();
    if (!sessionId) return null;
    try {
      const res = await fetch(`/api/session-status?session=${sessionId}`);
      if (!res.ok) return "";
      const data = await res.json();
      if (data?.status === "active") return null;
      return data?.metadata?.closeReason ?? "";
    } catch {
      return null;
    }
  }
}

function messageForCloseReason(reason: string): string {
  const known = reason as CloseReason;
  switch (known) {
    case "timer_expired": return "\u001b[33mSession expired.\u001b[0m";
    case "deploy_rollout": return "\u001b[33mSession ended — we pushed an update.\u001b[0m";
    case "clean": return "\u001b[90mSession ended.\u001b[0m";
    case "agent_shutdown":
    case "container_stopped":
    case "container_error":
    case "container_start_failed":
    case "agent_ws_close":
    case "agent_ws_error":
      return "\u001b[31mSession ended unexpectedly.\u001b[0m";
    default: return "\u001b[90mSession ended.\u001b[0m";
  }
}
