import { Container } from "@cloudflare/containers";
import type { AgentMessage, ClientMessage, ScriptEntry, ServerMessage, SessionMetadata } from "@glua/shared";
import { MAX_SCRIPT_SIZE, MAX_SCRIPTS_PER_SESSION } from "@glua/shared";
import { AGENT_TOKEN_HEADER, SESSION_TIMING } from "../constants";
import type { Env } from "../env";
import {
  type CapacitySnapshot,
  type CloseReason,
  notify,
  OBS_CONTEXT_HEADER,
  parseContext,
  type RequestContext,
} from "../observability";
import { readSessionLogs } from "../utils";
import { CLOSED_FLAG } from "./storage-keys";
import type { SessionState } from "./types";

/**
 * Manages a single GMod container session
 *
 * Lifecycle: NEW → PROVISIONING → ACTIVE → CLOSED
 *
 * Each session gets its own Durable Object (keyed by UUID via idFromName)
 * The DO owns the container, relays messages between browser(s) and the container's agent process, and flushes logs/scripts to R2 periodically
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
  // Per-session secret minted when we start the container and handed to it via envVars
  // The agent echoes it on the /ws/agent handshake so a browser that knows the session UUID still can't impersonate the container
  private agentToken?: string;
  private lastExitCode?: number;
  private lastExitReason?: string;

  // Best-effort geo context, lost on DO eviction, which is fine
  // Worst case the end-session embed is missing location info
  protected obsContext?: RequestContext;

  constructor(ctx: Container<Env>["ctx"], env: Env) {
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

    if (url.pathname === "/ws/agent" && !this.isValidAgentToken(request)) {
      return new Response("Forbidden", { status: 403 });
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

    if (this.sessionState === "CLOSED") {
      ws.close(1000, "Session closed.");
      return;
    }

    if (this.containerSocket || this.sessionState !== "PROVISIONING") {
      const warnMsg = `Agent connection in unexpected state: ${this.sessionState}, containerSocket=${!!this.containerSocket}`;
      console.warn(warnMsg);
      this.notifyAsync(
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
    this.scheduleTick();
    this.scheduleExpiryCheck(this.sessionEndTime);

    ws.addEventListener("message", this.onAgentMessage);
    ws.addEventListener("close", () => this.closeSession("agent_ws_close"));
    ws.addEventListener("error", () => this.closeSession("agent_ws_error"));
  }

  // ── Browser connection ──

  private handleBrowserWebSocket(ws: WebSocket, sessionId: string) {
    ws.accept();

    if (this.sessionState === "PROVISIONING") {
      this.send(ws, {
        type: "LOGS",
        payload: ["\u001b[33mProvisioning container... Waiting for agent connection.\u001b[0m"],
      });
    }

    ws.addEventListener("message", (msg) => this.onBrowserMessage(msg));
    ws.addEventListener("close", () => this.browserSockets.delete(ws));

    // Sends the history replay, then subscribes the socket to live output
    // Subscribing happens after the replay snapshot (same synchronous step) so every line is partitioned: replayed if it predates the subscribe, broadcast live if it follows, never both
    void this.restoreHistory(ws, sessionId);
  }

  private async handleInternalBroadcast(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const body = await request.json<{ message?: string }>().catch(() => ({}) as { message?: string });
    if (typeof body.message !== "string" || body.message.length === 0) {
      return new Response("Missing message", { status: 400 });
    }
    this.broadcast({ type: "SYSTEM_NOTICE", payload: { message: body.message } });
    return new Response("ok");
  }

  private async restoreHistory(ws: WebSocket, sessionId: string) {
    let flushed = "";
    try {
      flushed = await readSessionLogs(this.env.LOG_BUCKET, sessionId);
    } catch (e) {
      // R2 unavailable: still replay the in-memory tail below and subscribe, rather than dropping the socket entirely
      console.error("Could not restore log history from R2:", e);
    }

    // No await from here until browserSockets.add: the logBuffer snapshot and the subscribe must agree on a single boundary
    // A LOG that arrives before this block lands in the snapshot (replayed, not yet subscribed); one that arrives after is broadcast live (subscribed, not in the snapshot)
    let history = flushed;
    if (this.logBuffer.length > 0) {
      if (history.length > 0 && !history.endsWith("\n")) history += "\n";
      history += this.logBuffer.join("\n");
    }

    if (this.sessionState === "CLOSED") {
      // Session closed while we were reading: deliver the replay, then close the socket like closeSession would have
      if (history.length > 0) this.send(ws, { type: "HISTORY", payload: history });
      this.send(ws, { type: "SESSION_CLOSED" });
      try {
        ws.close(1000, "Session ended.");
      } catch {
        /* already closed */
      }
      return;
    }

    if (history.length > 0) this.send(ws, { type: "HISTORY", payload: history });
    this.browserSockets.add(ws);

    // We weren't subscribed during the R2 read, so a PROVISIONING→ACTIVE transition may have broadcast a timer this socket missed
    if (this.sessionState === "ACTIVE" && this.sessionEndTime) {
      this.send(ws, { type: "SESSION_TIMER", payload: this.timerPayload() });
    }

    // Scripts land in a separate client store with no ordering tie to logs, so this can await freely after the subscribe
    void this.restoreScripts(ws, sessionId);
  }

  private async restoreScripts(ws: WebSocket, sessionId: string) {
    try {
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
      console.error("Could not restore script history from R2:", e);
    }
  }

  // ── Container lifecycle ──

  private async startContainer(sessionId: string) {
    this.agentToken = crypto.randomUUID();
    try {
      await this.start({
        envVars: {
          SESSION_ID: sessionId,
          WORKER_URL: "https://glua.dev",
          AGENT_TOKEN: this.agentToken,
        },
      });
    } catch (e) {
      console.error("Container start error:", e);
      this.broadcast({
        type: "LOGS",
        payload: [`\u001b[31mFailed to start container: ${e instanceof Error ? e.message : String(e)}\u001b[0m`],
      });
      this.notifyAsync(
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
      void this.startContainer(this.sessionId);
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
        type: "SYSTEM_NOTICE",
        payload: {
          message:
            "We just pushed an update to glua.dev. We can't hot-swap running sessions (yet), so yours had to be closed — sorry about that 🥀 Start a new one to pick up where you left off!",
        },
      });
      await this.closeSession("deploy_rollout");
      return;
    }

    this.notifyAsync(
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
        // HISTORY_DUMP is the container's pre-connect console backlog, sent once on connect
        // It's the only source of the server's boot logs (the agent's tail only follows lines written after it attaches), so we treat it exactly like live output
        case "LOG":
        case "HISTORY_DUMP": {
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
    if (this.sessionEndTime === undefined || this.sessionDuration === undefined) {
      throw new Error("timerPayload called before session became active");
    }
    return {
      endTime: this.sessionEndTime,
      duration: this.sessionDuration,
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
    // The pending checkSessionExpiry fires at the old deadline, sees time remaining, and re-arms for the new one
  }

  // ── Session shutdown ──

  async closeSession(reason: CloseReason) {
    if (this.sessionState === "CLOSED") return;
    this.sessionState = "CLOSED";
    await this.ctx.storage.put(CLOSED_FLAG, true);
    const endedAt = Date.now();
    if (this.sessionMetadata) {
      this.sessionMetadata.endedAt = endedAt;
      this.sessionMetadata.closeReason = reason;
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

    this.notifyAsync(
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
    await manager.sessionClosed(this.sessionId);
  }

  // ── Scheduled callbacks (periodic flush + timeout check) ──
  //
  // These run through the Container class's schedule() API rather than a raw alarm() override
  // The Container class owns the DO's single alarm slot: it uses it to enforce sleepAfter, sync container exit events, and clean up after itself
  // Overriding alarm(), or colliding with its scheduleNextAlarm method, breaks all of that and leaves every session DO waking on a leaked alarm forever

  /**
   * Heartbeat while the session is live: flushes buffers to R2 and keeps the container's activity timeout renewed
   * Re-schedules itself until the session closes
   */
  async activityTick() {
    if (this.sessionState !== "ACTIVE") return;

    try {
      await this.flushLogsToR2();
      await this.flushSessionToR2();
    } catch (e) {
      console.error("[activityTick] flush error:", e);
    }

    this.renewActivityTimeout();
    this.scheduleTick();
  }

  /**
   * Fires at the session deadline
   * Extensions move sessionEndTime after this is scheduled, so waking up early just means re-arming for the new deadline
   * Also reaps orphans: if the DO was restarted mid-session, sessionEndTime is gone and we close rather than let the container linger
   */
  async checkSessionExpiry() {
    if (this.sessionState === "CLOSED") return;

    // schedule() has one-second granularity, so this can fire up to ~1s before the deadline
    // Close rather than re-arm for a sub-second gap
    if (this.sessionEndTime === undefined || Date.now() >= this.sessionEndTime - 1000) {
      await this.closeSession("timer_expired");
      return;
    }

    this.scheduleExpiryCheck(this.sessionEndTime);
  }

  private scheduleTick(): void {
    this.schedule(SESSION_TIMING.activityPing / 1000, "activityTick").catch((e) =>
      console.error("Failed to schedule activityTick:", e),
    );
  }

  private scheduleExpiryCheck(endTime: number): void {
    this.schedule(new Date(endTime), "checkSessionExpiry").catch((e) =>
      console.error("Failed to schedule expiry check:", e),
    );
  }

  // ── R2 persistence ──

  private async flushLogsToR2() {
    if (this.logBuffer.length === 0) return;
    const lines = this.logBuffer;
    this.logBuffer = [];

    // Each flush writes its own chunk object because R2 can't append
    // Read-modify-writing one big log re-copied the whole thing every 30s and could drop lines when two flushes overlapped
    // Millisecond timestamps keep chunk keys in chronological sort order
    const chunkKey = `sessions/${this.sessionId}/logs/${Date.now()}.log`;

    try {
      await this.env.LOG_BUCKET.put(chunkKey, `${lines.join("\n")}\n`);
    } catch (e) {
      console.error(`Failed to flush logs for ${this.sessionId}:`, e);
      this.logBuffer.unshift(...lines);
      this.notifyAsync(
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

    const sessionKey = `sessions/${this.sessionId}/session.json`;

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
      console.error(`Failed to flush session data for ${this.sessionId}:`, e);
      this.notifyAsync(
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

  private notifyAsync(promise: Promise<unknown>): void {
    this.ctx.waitUntil(promise);
  }

  // Constant-time comparison against the token we minted for this session's container
  // Rejects when no container has been started (token unset), e.g. a stray /ws/agent to a fresh or evicted DO
  private isValidAgentToken(request: Request): boolean {
    const presented = request.headers.get(AGENT_TOKEN_HEADER);
    if (!this.agentToken || !presented) return false;
    const a = new TextEncoder().encode(presented);
    const b = new TextEncoder().encode(this.agentToken);
    if (a.byteLength !== b.byteLength) return false;
    return crypto.subtle.timingSafeEqual(a, b);
  }

  private get sessionId(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error("Session DO constructed without idFromName");
    return name;
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
