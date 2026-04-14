import { Container } from "@cloudflare/containers";
import type { AgentMessage, ClientMessage, ScriptEntry, ServerMessage, SessionMetadata } from "@glua/shared";
import { MAX_SCRIPT_SIZE, MAX_SCRIPTS_PER_SESSION } from "@glua/shared";
import { SESSION_TIMING } from "../constants";
import type { Env } from "../env";
import {
  type CapacitySnapshot,
  type CloseReason,
  notify,
  OBS_CONTEXT_HEADER,
  parseContext,
  type RequestContext,
} from "../observability";
import { CLOSED_FLAG } from "./storage-keys";
import type { SessionState } from "./types";

/**
 * Manages a single GMod container session
 *
 * Lifecycle: NEW → PROVISIONING → ACTIVE → CLOSED
 *
 * Each session gets its own Durable Object (keyed by UUID via idFromName).
 * The DO owns the container, relays messages between browser(s) and the
 * container's agent process, and flushes logs/scripts to R2 periodically.
 *
 * Subclasses only override `branch` to select which GMod build to run
 */
export class BaseSession extends Container<Env> {
  protected branch = "public";

  private sessionState: SessionState;
  private browserSockets: Set<WebSocket>;
  private containerSocket: WebSocket | null;
  private logBuffer: string[];
  private logLineCount: number;
  private scriptBuffer: Record<string, ScriptEntry>;
  private scriptCount: number;
  private sessionMetadata: SessionMetadata | null;
  private sessionEndTime?: number;
  private sessionDuration?: number;
  private extensionGranted = false;
  private startRetries = 0;
  private lastExitCode?: number;
  private lastExitReason?: string;

  // Best-effort geo context — lost on DO eviction, which is fine
  // Worst case the end-session embed is missing location info
  protected obsContext?: RequestContext;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      sleepAfter: "5m",
      defaultPort: 8080,
    });

    this.sessionState = "NEW";
    this.browserSockets = new Set();
    this.containerSocket = null;
    this.logBuffer = [];
    this.logLineCount = 0;
    this.scriptBuffer = {};
    this.scriptCount = 0;
    this.sessionMetadata = null;

    ctx.blockConcurrencyWhile(async () => {
      const closed = await ctx.storage.get<boolean>(CLOSED_FLAG);
      if (closed) this.sessionState = "CLOSED";
    });
  }

  // ── Fetch entrypoint ──

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/internal/broadcast") {
      return this.handleInternalBroadcast(request);
    }

    if (this.sessionState === "CLOSED") {
      return new Response("This session has been closed.", { status: 410 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade request.", { status: 426 });
    }

    const sessionId = url.searchParams.get("session");
    if (!sessionId) {
      return new Response("WebSocket request missing session ID.", { status: 400 });
    }

    if (url.pathname === "/ws/browser" && this.sessionState === "NEW") {
      this.sessionState = "PROVISIONING";
      this.obsContext = parseContext(request.headers.get(OBS_CONTEXT_HEADER));

      void (async () => {
        const capacity = await this.fetchCapacitySnapshot();
        await notify.sessionStarted(this.env, {
          sessionId,
          branch: this.branch,
          context: this.obsContext ?? { ip: "unknown" },
          capacity,
        });
      })();

      void this.startContainer(sessionId);
    }

    const [client, server] = Object.values(new WebSocketPair());

    if (url.pathname === "/ws/agent") {
      this.handleAgentConnection(server);
    } else if (url.pathname === "/ws/browser") {
      this.handleBrowserWebSocket(server, sessionId);
    } else {
      return new Response("Unknown WebSocket endpoint.", { status: 404 });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Agent (container) connection ──

  private handleAgentConnection(ws: WebSocket) {
    ws.accept();

    if (this.containerSocket || this.sessionState !== "PROVISIONING") {
      const warnMsg = `Agent connection in unexpected state: ${this.sessionState}, containerSocket=${!!this.containerSocket}`;
      console.warn(warnMsg);
      this.ctx.waitUntil(
        notify.error(this.env, {
          where: "handleAgentConnection: unexpected state",
          error: new Error(warnMsg),
          sessionId: this.ctx.id.name,
          branch: this.branch,
          context: this.obsContext,
        }),
      );
    }

    this.containerSocket = ws;
    this.sessionState = "ACTIVE";

    this.sessionDuration = SESSION_TIMING.duration;
    this.sessionEndTime = Date.now() + this.sessionDuration;
    this.broadcast({ type: "SESSION_TIMER", payload: this.timerPayload() });
    this.broadcast({ type: "LOGS", payload: ["\u001b[32mAgent connected. Session is live.\u001b[0m"] });

    this.renewActivityTimeout();
    this.scheduleNextAlarm();

    ws.addEventListener("message", this.onAgentMessage);
    ws.addEventListener("close", () => this.closeSession("agent_ws_close"));
    ws.addEventListener("error", () => this.closeSession("agent_ws_error"));
  }

  // ── Browser connection ──

  private handleBrowserWebSocket(ws: WebSocket, sessionId: string) {
    ws.accept();
    this.browserSockets.add(ws);

    if (this.sessionState === "ACTIVE" && this.sessionEndTime) {
      this.send(ws, { type: "SESSION_TIMER", payload: this.timerPayload() });
    }

    // Async so we don't block the DO's concurrency gate on R2 reads
    void this.restoreHistory(ws, sessionId);

    if (this.sessionState === "PROVISIONING") {
      this.send(ws, {
        type: "LOGS",
        payload: ["\u001b[33mProvisioning container... Waiting for agent connection.\u001b[0m"],
      });
    }

    ws.addEventListener("message", (msg) => this.onBrowserMessage(msg));
    ws.addEventListener("close", () => this.browserSockets.delete(ws));
  }

  private async handleInternalBroadcast(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const body = await request.json<{ message?: string }>().catch(() => ({}) as { message?: string });
    if (typeof body.message !== "string" || body.message.length === 0) {
      return new Response("Missing message", { status: 400 });
    }
    this.broadcast({ type: "LOGS", payload: [body.message] });
    return new Response("ok");
  }

  private async restoreHistory(ws: WebSocket, sessionId: string) {
    try {
      const logKey = `sessions/${sessionId}/logs.log`;
      const existingLogs = await this.env.LOG_BUCKET.get(logKey);
      let fullLogContent = "";
      if (existingLogs) {
        fullLogContent += await existingLogs.text();
      }
      if (this.logBuffer.length > 0) {
        if (fullLogContent.length > 0 && !fullLogContent.endsWith("\n")) {
          fullLogContent += "\n";
        }
        fullLogContent += this.logBuffer.join("\n");
      }
      if (fullLogContent.length > 0) {
        this.send(ws, { type: "HISTORY", payload: fullLogContent });
      }

      const sessionKey = `sessions/${sessionId}/session.json`;
      const existingSession = await this.env.LOG_BUCKET.get(sessionKey);
      let allScripts: Record<string, ScriptEntry> = {};
      if (existingSession) {
        const sessionData = JSON.parse(await existingSession.text());
        allScripts = sessionData.scripts || {};
      }
      Object.assign(allScripts, this.scriptBuffer);
      if (Object.keys(allScripts).length > 0) {
        this.send(ws, { type: "SCRIPT_HISTORY", payload: allScripts });
      }
    } catch (e) {
      console.error("Could not restore history from R2:", e);
    }
  }

  // ── Container lifecycle ──

  private async startContainer(sessionId: string) {
    try {
      await this.start({
        envVars: {
          SESSION_ID: sessionId,
          WORKER_URL: "https://glua.dev",
        },
      });
    } catch (e) {
      console.error("Container start error:", e);
      this.broadcast({
        type: "LOGS",
        payload: [`\u001b[31mFailed to start container: ${e instanceof Error ? e.message : String(e)}\u001b[0m`],
      });
      this.ctx.waitUntil(
        notify.error(this.env, {
          where: "startContainer",
          error: e,
          sessionId,
          branch: this.branch,
          context: this.obsContext,
        }),
      );
      await this.closeSession("container_start_failed");
    }
  }

  override onStart(): void {
    this.broadcast({ type: "LOGS", payload: ["\u001b[33mContainer started. Waiting for agent...\u001b[0m"] });
    this.renewActivityTimeout();
  }

  override async onStop(params: { exitCode: number; reason: "exit" | "runtime_signal" }): Promise<void> {
    this.lastExitCode = params.exitCode;
    this.lastExitReason = params.reason;
    if (this.sessionState === "PROVISIONING" && this.startRetries < 3) {
      this.startRetries++;
      console.warn(`[onStop] Container died during provisioning, retry ${this.startRetries}/3`);
      await new Promise((r) => setTimeout(r, 2000));
      void this.startContainer(this.ctx.id.name!);
      return;
    }
    await this.closeSession("container_stopped");
  }

  override async onError(error: unknown): Promise<void> {
    console.error("Container error:", error);

    const message = error instanceof Error ? error.message : String(error);
    const isDeployRollout = /new version rollout/i.test(message);

    if (isDeployRollout) {
      this.broadcast({
        type: "LOGS",
        payload: [
          "\u001b[33m*** We just pushed an update to glua.dev. We can't hot-swap running sessions (yet), so yours had to be closed — sorry about that 🥀 Start a new one to pick up where you left off! ***\u001b[0m",
        ],
      });
      await this.closeSession("deploy_rollout");
      return;
    }

    this.ctx.waitUntil(
      notify.error(this.env, {
        where: "Container.onError",
        error,
        sessionId: this.ctx.id.name,
        branch: this.branch,
        context: this.obsContext,
      }),
    );
    await this.closeSession("container_error");
  }

  // ── Message handlers ──

  private onAgentMessage = (msg: MessageEvent) => {
    try {
      const message = JSON.parse(msg.data as string) as AgentMessage;
      switch (message.type) {
        case "LOG": {
          const lines = Array.isArray(message.payload) ? message.payload : [String(message.payload)];
          this.logBuffer.push(...lines);
          this.logLineCount += lines.length;
          this.broadcast({ type: "LOGS", payload: lines });
          break;
        }
        case "HEALTH":
          this.broadcast({ type: "HEALTH", payload: message.payload });
          break;
        case "METADATA": {
          const p = message.payload;
          if (typeof p.branch === "string" && typeof p.gameVersion === "string" && typeof p.containerTag === "string") {
            this.sessionMetadata = {
              branch: p.branch,
              gameVersion: p.gameVersion,
              containerTag: p.containerTag,
              startedAt: Date.now(),
            };
            this.broadcast({ type: "CONTEXT_UPDATE", payload: this.sessionMetadata });
          }
          break;
        }
        case "AGENT_SHUTDOWN":
          this.broadcast({ type: "LOGS", payload: ["\u001b[31mAgent is shutting down...\u001b[0m"] });
          void this.closeSession("agent_shutdown");
          break;
        default:
          console.warn(`Unknown agent message type: ${(message as { type: string }).type}`);
      }
    } catch (e) {
      console.error("Failed to parse agent message:", e);
    }
  };

  private onBrowserMessage(msg: MessageEvent) {
    try {
      const message = JSON.parse(msg.data as string) as ClientMessage;

      if (message.type === "REQUEST_EXTENSION") {
        this.handleExtensionRequest();
        return;
      }

      if (message.type === "CLOSE_SESSION") {
        if (this.sessionState === "ACTIVE") {
          void this.closeSession("clean");
        }
        return;
      }

      if (this.containerSocket?.readyState !== WebSocket.OPEN) return;

      if (message.type === "SCRIPT") {
        const content = message.payload.content ?? "";
        if (content.length > MAX_SCRIPT_SIZE) {
          this.broadcast({ type: "LOGS", payload: ["\u001b[31mScript too large (max 64KB).\u001b[0m"] });
          return;
        }
        if (this.scriptCount >= MAX_SCRIPTS_PER_SESSION) {
          this.broadcast({ type: "LOGS", payload: ["\u001b[31mScript limit reached (max 50 per session).\u001b[0m"] });
          return;
        }
        this.scriptCount++;
        const cleanName = (message.payload.name || "script").replace(/[^a-zA-Z0-9_-]/g, "_");
        const resolvedName = `${cleanName}_${this.scriptCount}.lua`;
        this.scriptBuffer[resolvedName] = { content, logLine: this.logLineCount };
        this.broadcast({
          type: "SCRIPT_EXECUTED",
          payload: { name: resolvedName, content, logLine: this.logLineCount },
        });
      }

      this.containerSocket.send(JSON.stringify(message));
    } catch (e) {
      console.error("Failed to parse browser message:", e);
    }
  }

  // ── Session timer ──

  private timerPayload() {
    return {
      endTime: this.sessionEndTime!,
      duration: this.sessionDuration!,
      extensionThreshold: SESSION_TIMING.extensionThreshold,
    };
  }

  private handleExtensionRequest() {
    if (!this.sessionEndTime || !this.sessionDuration || this.sessionState !== "ACTIVE") return;
    if (this.extensionGranted) return;

    const remaining = this.sessionEndTime - Date.now();
    if (remaining > SESSION_TIMING.extensionThreshold) return;

    this.extensionGranted = true;

    const elapsed = Date.now() - (this.sessionEndTime - this.sessionDuration);
    const newDuration = Math.min(elapsed + remaining + SESSION_TIMING.extension, SESSION_TIMING.hardLimit);
    const newEndTime = Date.now() + (newDuration - elapsed);

    this.sessionDuration = newDuration;
    this.sessionEndTime = newEndTime;
    this.broadcast({ type: "SESSION_TIMER", payload: this.timerPayload() });
    this.scheduleNextAlarm();
  }

  // ── Session shutdown ──

  async closeSession(reason: CloseReason) {
    if (this.sessionState === "CLOSED") return;
    this.sessionState = "CLOSED";
    await this.ctx.storage.put(CLOSED_FLAG, true);
    const endedAt = Date.now();
    if (this.sessionMetadata) {
      this.sessionMetadata.endedAt = endedAt;
    }

    if (this.containerSocket) {
      try {
        this.containerSocket.close(1000, "Session closed.");
      } catch {
        /* socket already closed */
      }
    }
    this.containerSocket = null;

    this.broadcast({ type: "SESSION_CLOSED" });
    this.browserSockets.forEach((ws) => {
      try {
        ws.close(1000, "Session ended.");
      } catch {
        /* socket already closed */
      }
    });

    await this.flushLogsToR2();
    await this.flushSessionToR2();

    try {
      await this.stop();
    } catch (e) {
      console.error("Error stopping container:", e);
    }

    await this.notifyQueueManagerOfClosure();

    this.ctx.waitUntil(
      (async () => {
        const capacity = await this.fetchCapacitySnapshot();
        await notify.sessionEnded(this.env, {
          sessionId: this.ctx.id.name ?? "unknown",
          branch: this.branch,
          reason,
          startedAt: this.sessionMetadata?.startedAt,
          endedAt,
          scriptCount: this.scriptCount,
          logLineCount: this.logLineCount,
          extensionGranted: this.extensionGranted,
          exitCode: this.lastExitCode,
          exitReason: this.lastExitReason,
          context: this.obsContext,
          capacity,
        });
      })(),
    );
  }

  private async notifyQueueManagerOfClosure() {
    const manager = this.env.SESSION_MANAGER.get(this.env.SESSION_MANAGER.idFromName("global-queue"));
    await manager.fetch("http://do/api/session-closed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: this.ctx.id.name! }),
    });
  }

  // ── Alarm (periodic flush + timeout check) ──

  async alarm() {
    try {
      await this.flushLogsToR2();
      await this.flushSessionToR2();
    } catch (e) {
      console.error("[alarm] flush error:", e);
    }

    if (this.sessionState === "ACTIVE") {
      if (this.sessionEndTime && Date.now() >= this.sessionEndTime) {
        await this.closeSession("timer_expired");
        return;
      }
      this.renewActivityTimeout();
      this.scheduleNextAlarm();
    }
  }

  private scheduleNextAlarm() {
    const nextPing = Date.now() + SESSION_TIMING.activityPing;
    const target = this.sessionEndTime ? Math.min(nextPing, this.sessionEndTime) : nextPing;
    this.ctx.storage.setAlarm(target);
  }

  // ── R2 persistence ──

  private async flushLogsToR2() {
    if (this.logBuffer.length === 0) return;
    const logKey = `sessions/${this.ctx.id.name!}/logs.log`;
    const logsToFlush = this.logBuffer.join("\n") + "\n";
    this.logBuffer = [];

    try {
      const existingLog = await this.env.LOG_BUCKET.get(logKey);
      const existingContent = existingLog ? await existingLog.text() : "";
      await this.env.LOG_BUCKET.put(logKey, existingContent + logsToFlush);
    } catch (e) {
      console.error(`Failed to flush logs for ${this.ctx.id.name!}:`, e);
      this.logBuffer.unshift(...logsToFlush.trim().split("\n"));
      this.ctx.waitUntil(
        notify.error(this.env, {
          where: "flushLogsToR2",
          error: e,
          sessionId: this.ctx.id.name,
          branch: this.branch,
          context: this.obsContext,
        }),
      );
    }
  }

  private async flushSessionToR2() {
    const hasNewScripts = Object.keys(this.scriptBuffer).length > 0;
    if (!hasNewScripts && !this.sessionMetadata) return;

    const sessionKey = `sessions/${this.ctx.id.name!}/session.json`;

    try {
      const existing = await this.env.LOG_BUCKET.get(sessionKey);
      let session: { metadata: SessionMetadata | null; scripts: Record<string, ScriptEntry> } = {
        metadata: null,
        scripts: {},
      };
      if (existing) {
        session = JSON.parse(await existing.text());
      }
      if (this.sessionMetadata) {
        session.metadata = this.sessionMetadata;
      }
      Object.assign(session.scripts, this.scriptBuffer);
      await this.env.LOG_BUCKET.put(sessionKey, JSON.stringify(session));
      this.scriptBuffer = {};
    } catch (e) {
      console.error(`Failed to flush session data for ${this.ctx.id.name!}:`, e);
      this.ctx.waitUntil(
        notify.error(this.env, {
          where: "flushSessionToR2",
          error: e,
          sessionId: this.ctx.id.name,
          branch: this.branch,
          context: this.obsContext,
        }),
      );
    }
  }

  // ── Helpers ──

  private async fetchCapacitySnapshot(): Promise<CapacitySnapshot | undefined> {
    try {
      const manager = this.env.SESSION_MANAGER.get(this.env.SESSION_MANAGER.idFromName("global-queue"));
      const res = await manager.fetch(`http://do/internal/capacity?branch=${encodeURIComponent(this.branch)}`);
      if (!res.ok) return undefined;
      return await res.json<CapacitySnapshot>();
    } catch (e) {
      console.error("[obs] fetchCapacitySnapshot failed:", e);
      return undefined;
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      console.error("Failed to send to browser socket:", e);
    }
  }

  private broadcast(message: ServerMessage): void {
    const serialized = JSON.stringify(message);
    this.browserSockets.forEach((ws) => {
      try {
        ws.send(serialized);
      } catch {
        this.browserSockets.delete(ws);
      }
    });
  }
}
