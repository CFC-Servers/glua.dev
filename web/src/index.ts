import { DurableObject } from "cloudflare:workers";
import { Container, getContainer } from "@cloudflare/containers";
import {
  notify,
  extractRequestContext,
  serializeContext,
  parseContext,
  OBS_CONTEXT_HEADER,
  type CapacitySnapshot,
  type CloseReason,
  type RequestContext,
} from "./observability";

// --- Type Definitions ---
interface WebSocketMessage {
  type: string;
  payload?: any;
}

export interface Env {
  GMOD_PUBLIC: DurableObjectNamespace;
  GMOD_SIXTYFOUR: DurableObjectNamespace;
  GMOD_PRERELEASE: DurableObjectNamespace;
  GMOD_DEV: DurableObjectNamespace;
  QUEUE_DO: DurableObjectNamespace<QueueDO>;
  LOG_BUCKET: R2Bucket;
  DISCORD_WEBHOOK_URL?: string;
}

// --- Session Time Limits ---
const SESSION_DURATION = 10 * 60 * 1000;      // 10 minutes default
const SESSION_HARD_LIMIT = 15 * 60 * 1000;    // 15 minutes absolute max
const SESSION_EXTENSION = 5 * 60 * 1000;      // 5 minutes per extension
const EXTENSION_THRESHOLD = 2 * 60 * 1000;    // allow extension requests with <2min remaining
const ACTIVITY_PING_INTERVAL = 30 * 1000;     // 30 seconds

// --- Container / Session Manager Base Class ---
export class BaseSession extends Container<Env> {
  protected branch: string = "public";

  sessionState: "NEW" | "PROVISIONING" | "ACTIVE" | "CLOSED";
  browserSockets: Set<WebSocket>;
  containerSocket: WebSocket | null;
  logBuffer: string[];
  logLineCount: number;
  scriptBuffer: Record<string, { content: string; logLine: number }>;
  scriptCount: number;
  sessionMetadata: { branch: string; gameVersion: string; containerTag: string; startedAt: number; endedAt?: number } | null;
  sessionEndTime?: number;
  sessionDuration?: number;
  extensionGranted = false;

  // In-memory only: on DO hibernation we lose geo/ISP fields in the end
  // embed, which is cosmetic — never a correctness concern.
  protected obsContext?: RequestContext;

  private async fetchCapacitySnapshot(): Promise<CapacitySnapshot | undefined> {
    try {
      const queueDO = this.env.QUEUE_DO.get(this.env.QUEUE_DO.idFromName("global-queue"));
      const res = await queueDO.fetch(`http://do/internal/capacity?branch=${encodeURIComponent(this.branch)}`);
      if (!res.ok) return undefined;
      return await res.json<CapacitySnapshot>();
    } catch (e) {
      console.error("[obs] fetchCapacitySnapshot failed:", e);
      return undefined;
    }
  }

  constructor(ctx: DurableObjectState, env: Env) {
    // Pass the container config to the super constructor.
    super(ctx, env, {
      sleepAfter: "5m",
      defaultPort: 8080
    });

    this.sessionState = "NEW";
    this.browserSockets = new Set();
    this.containerSocket = null;
    this.logBuffer = [];
    this.logLineCount = 0;
    this.scriptBuffer = {};
    this.scriptCount = 0;
  }

  override async fetch(request: Request): Promise<Response> {
    if (this.sessionState === "CLOSED") {
      return new Response("This session has been closed.", { status: 410 });
    }

    const url = new URL(request.url);
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected a WebSocket upgrade request.", { status: 426 });
    }

    const sessionId = url.searchParams.get("session");
    if (!sessionId) {
      return new Response("WebSocket request missing session ID.", { status: 400 });
    }

    // Because a DO serializes requests, the logic inside this fetch handler will
    // complete before the next request (e.g., from the agent) is processed.
    // This is how we solve the race condition.
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

      // Start the container, but don't wait for it to finish.
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

  handleAgentConnection(ws: WebSocket) {
    (ws as any).accept();

    if (this.containerSocket || this.sessionState !== "PROVISIONING") {
      const warnMsg = `Agent connection attempted in unexpected state: ${this.sessionState}. Already had containerSocket?: ${!!this.containerSocket}`;
      console.warn(warnMsg);
      // TODO: Why is this firing inappropriately for non-public branches?
      // Webhook is wired up to collect diagnostic data; drop it once
      // the root cause is known.
      void notify.error(this.env, {
        where: "handleAgentConnection: unexpected state",
        error: new Error(warnMsg),
        sessionId: this.ctx.id.name,
        branch: this.branch,
        context: this.obsContext,
      });
      // ws.close(1013, "Duplicate or unexpected agent connection.");
      // return;
    }

    this.containerSocket = ws;
    this.sessionState = "ACTIVE";

    this.sessionDuration = SESSION_DURATION;
    this.sessionEndTime = Date.now() + this.sessionDuration;
    this.broadcastToBrowsers("SESSION_TIMER", this.sessionTimerPayload());

    this.broadcastToBrowsers("LOGS", ["\u001b[32mAgent connected. Session is live.\u001b[0m"]);
    this.renewActivityTimeout();
    this.ctx.storage.setAlarm(Date.now() + ACTIVITY_PING_INTERVAL);

    ws.addEventListener("message", this.onAgentMessage);
    ws.addEventListener("close", () => this.closeSession("agent_ws_close"));
    ws.addEventListener("error", () => this.closeSession("agent_ws_error"));
  }

  handleBrowserWebSocket(ws: WebSocket, sessionId: string) {
    (ws as any).accept();
    this.browserSockets.add(ws);

    if (this.sessionState === "ACTIVE" && this.sessionEndTime) {
      this.sendToBrowser(ws, "SESSION_TIMER", this.sessionTimerPayload());
    }

    // Restore logs and scripts from R2 and buffer for the new client
    this.ctx.blockConcurrencyWhile(async () => {
        try {
            const logKey = `sessions/${sessionId}/logs.log`;
            const existingLogs = await this.env.LOG_BUCKET.get(logKey);
            let fullLogContent = "";
            if (existingLogs) {
                fullLogContent += await existingLogs.text();
            }
            // Append any logs that have come in since the DO was activated
            if (this.logBuffer.length > 0) {
                if (fullLogContent.length > 0 && !fullLogContent.endsWith("\n")) {
                    fullLogContent += "\n";
                }
                fullLogContent += this.logBuffer.join("\n");
            }
            if (fullLogContent.length > 0) {
                this.sendToBrowser(ws, "HISTORY", fullLogContent);
            }

            // Restore scripts from R2 + in-memory buffer
            const sessionKey = `sessions/${sessionId}/session.json`;
            const existingSession = await this.env.LOG_BUCKET.get(sessionKey);
            let allScripts: Record<string, { content: string; logLine: number }> = {};
            if (existingSession) {
                const sessionData = JSON.parse(await existingSession.text());
                allScripts = sessionData.scripts || {};
            }
            Object.assign(allScripts, this.scriptBuffer);
            if (Object.keys(allScripts).length > 0) {
                this.sendToBrowser(ws, "SCRIPT_HISTORY", allScripts);
            }
        } catch (e) {
            console.error("Could not get history from R2", e);
        }
    });

    if (this.sessionState === "PROVISIONING") {
      this.sendToBrowser(ws, "LOGS", ["\u001b[33mProvisioning container... Waiting for agent connection.\u001b[0m"]);
    }

    ws.addEventListener("message", (msg) => this.onBrowserMessage(msg));
    ws.addEventListener("close", () => this.browserSockets.delete(ws));
  }

  async startContainer(sessionId: string) {
    try {
      await this.start({
        envVars: {
          SESSION_ID: sessionId,
          WORKER_URL: "https://beta.glua.dev",
        }
      });
    } catch(e) {
      console.error("Container Start Error:", e);
      const errorMessage = `\u001b[31mFailed to start container: ${e instanceof Error ? e.message : String(e)}\u001b[0m`;
      this.broadcastToBrowsers("LOGS", [errorMessage]);
      void notify.error(this.env, {
        where: "startContainer",
        error: e,
        sessionId,
        branch: this.branch,
        context: this.obsContext,
      });
      await this.closeSession("container_start_failed");
    }
  }

  override onStart(): void {
    this.broadcastToBrowsers("LOGS", ["\u001b[33mContainer started. Waiting for agent...\u001b[0m"]);
    this.renewActivityTimeout();
  }

  startRetries = 0;

  override async onStop(): Promise<void> {
    // If the container died before the agent ever connected, retry once
    // (handles the case where Cloudflare hasn't fully freed the previous container's slot)
    if (this.sessionState === "PROVISIONING" && this.startRetries < 3) {
      this.startRetries++;
      console.log(`[onStop] Container died during provisioning, retry ${this.startRetries}/3`);
      await new Promise(r => setTimeout(r, 2000));
      const sessionId = this.ctx.id.name!;
      void this.startContainer(sessionId);
      return;
    }
    await this.closeSession("container_stopped");
  }

  override async onError(error: unknown): Promise<void> {
    console.error("Container Error:", error);
    void notify.error(this.env, {
      where: "Container.onError",
      error,
      sessionId: this.ctx.id.name,
      branch: this.branch,
      context: this.obsContext,
    });
    await this.closeSession("container_error");
  }

  onAgentMessage = (msg: MessageEvent) => {
    try {
      const message: WebSocketMessage = JSON.parse(msg.data as string);
      switch (message.type) {
        case "LOG":
          // The agent is sending a new log line.
          const lines = Array.isArray(message.payload) ? message.payload : [message.payload];
          this.logBuffer.push(...lines);
          this.logLineCount += lines.length;
          this.broadcastToBrowsers("LOGS", lines);
          break;
        case "HEALTH":
          this.broadcastToBrowsers("HEALTH", message.payload);
          break;
        case "METADATA":
          this.sessionMetadata = message.payload as { branch: string; gameVersion: string; containerTag: string; startedAt: number };
          this.sessionMetadata.startedAt = Date.now();
          this.broadcastToBrowsers("CONTEXT_UPDATE", this.sessionMetadata);
          break;
        case "AGENT_SHUTDOWN":
           this.broadcastToBrowsers("LOGS", ["\u001b[31mAgent is shutting down...\u001b[0m"]);
           void this.closeSession("agent_shutdown");
           break;
        default:
          console.warn(`Unknown message type from agent: ${message.type}`);
      }
    } catch (e) {
      console.error("Failed to parse agent message:", e);
    }
  }

  onBrowserMessage(msg: MessageEvent) {
    try {
      console.log("Received message from browser:", msg.data);
      const message: WebSocketMessage = JSON.parse(msg.data as string);
      if (message.type === "REQUEST_EXTENSION") {
        this.handleExtensionRequest();
        return;
      }
      if (message.type === "CLOSE_SESSION") {
        if (this.sessionState === "ACTIVE") {
          console.log("Browser requested session close");
          void this.closeSession("clean");
        }
        return;
      }
      if (this.containerSocket?.readyState === WebSocket.OPEN) {
        if (message.type === "SCRIPT") {
            const content = message.payload.content || "";
            if (content.length > 65536) {
              this.broadcastToBrowsers("LOGS", ["\u001b[31mScript too large (max 64KB).\u001b[0m"]);
              return;
            }
            if (this.scriptCount >= 50) {
              this.broadcastToBrowsers("LOGS", ["\u001b[31mScript limit reached (max 50 per session).\u001b[0m"]);
              return;
            }
            this.scriptCount++;
            const cleanName = (message.payload.name || "script").replace(/[^a-zA-Z0-9_-]/g, "_");
            const resolvedName = `${cleanName}_${this.scriptCount}.lua`;
            this.scriptBuffer[resolvedName] = { content, logLine: this.logLineCount };
            this.broadcastToBrowsers("SCRIPT_EXECUTED", { name: resolvedName, content, logLine: this.logLineCount });
        }
        this.containerSocket.send(JSON.stringify(message));
      }
    } catch (e) { console.error("Failed to parse browser message:", e); }
  }

  sessionTimerPayload() {
    return {
      endTime: this.sessionEndTime,
      duration: this.sessionDuration,
      extensionThreshold: EXTENSION_THRESHOLD,
    };
  }

  handleExtensionRequest() {
    if (!this.sessionEndTime || !this.sessionDuration || this.sessionState !== "ACTIVE") return;
    if (this.extensionGranted) return;

    const remaining = this.sessionEndTime - Date.now();
    if (remaining > EXTENSION_THRESHOLD) return;

    this.extensionGranted = true;

    const elapsed = Date.now() - (this.sessionEndTime - this.sessionDuration);
    const newDuration = Math.min(elapsed + remaining + SESSION_EXTENSION, SESSION_HARD_LIMIT);
    const newEndTime = Date.now() + (newDuration - elapsed);

    this.sessionDuration = newDuration;
    this.sessionEndTime = newEndTime;
    this.broadcastToBrowsers("SESSION_TIMER", this.sessionTimerPayload());
  }

  async closeSession(reason: CloseReason) {
    const stack = new Error().stack;
    console.trace("Closing session", this.sessionState, "reason:", reason);
    console.log(stack)

    if (this.sessionState === "CLOSED") return;
    this.sessionState = "CLOSED";
    const endedAt = Date.now();
    if (this.sessionMetadata) {
      this.sessionMetadata.endedAt = endedAt;
    }

    if(this.containerSocket) {
      try { this.containerSocket.close(1000, "Session closed."); } catch(e) {}
    }

    this.containerSocket = null;
    this.broadcastToBrowsers("SESSION_CLOSED", {});
    this.browserSockets.forEach(ws => {
      try { ws.close(1000, "Session ended."); } catch(e) {}
    });

    await this.flushLogsToR2();
    await this.flushSessionToR2();

    try { await this.stop(); }
    catch(e) { console.error("Error stopping container:", e); }

    await this.notifyQueueManagerOfClosure();

    void (async () => {
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
        context: this.obsContext,
        capacity,
      });
    })();
  }

  async notifyQueueManagerOfClosure() {
    const queueDO = this.env.QUEUE_DO.get(this.env.QUEUE_DO.idFromName("global-queue"));
    await queueDO.fetch("http://do/api/session-closed", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ sessionId: this.ctx.id.name! })
    });
  }

  async alarm() {
    console.log(`[alarm] state=${this.sessionState}, running=${this.running}`);
    try {
      await this.flushLogsToR2();
      await this.flushSessionToR2();
    } catch (e) {
      console.error("[alarm] flush error:", e);
    }

    if (this.sessionState === "ACTIVE") {
      if (this.sessionEndTime && Date.now() >= this.sessionEndTime) {
        console.log("[alarm] session time expired, closing");
        await this.closeSession("timer_expired");
        return;
      }
      this.renewActivityTimeout();
      this.ctx.storage.setAlarm(Date.now() + ACTIVITY_PING_INTERVAL);
      console.log("[alarm] renewed activity timeout, next alarm scheduled");
    } else {
      console.log("[alarm] not rescheduling, session not active");
    }
  }

  async flushLogsToR2() {
    if (this.logBuffer.length === 0) return;
    const logKey = `sessions/${this.ctx.id.name!}/logs.log`;
    const logsToFlush = this.logBuffer.join("\n") + "\n";
    this.logBuffer = [];

    try {
      const existingLog = await this.env.LOG_BUCKET.get(logKey);
      const existingContent = existingLog ? await existingLog.text() : "";
      const newContent = existingContent + logsToFlush;

      await this.env.LOG_BUCKET.put(logKey, newContent);
    } catch (e) {
      console.error(`Failed to flush logs for DO ${this.ctx.id.name!}:`, e);
      this.logBuffer.unshift(...logsToFlush.trim().split("\n"));
      void notify.error(this.env, {
        where: "flushLogsToR2",
        error: e,
        sessionId: this.ctx.id.name,
        branch: this.branch,
        context: this.obsContext,
      });
    }
  }

  async flushSessionToR2() {
    const hasNewScripts = Object.keys(this.scriptBuffer).length > 0;
    if (!hasNewScripts && !this.sessionMetadata) return;

    const sessionKey = `sessions/${this.ctx.id.name!}/session.json`;

    try {
      const existing = await this.env.LOG_BUCKET.get(sessionKey);
      let session: { metadata: typeof this.sessionMetadata; scripts: Record<string, { content: string; logLine: number }> } = {
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
      console.error(`Failed to flush session data for DO ${this.ctx.id.name!}:`, e);
      void notify.error(this.env, {
        where: "flushSessionToR2",
        error: e,
        sessionId: this.ctx.id.name,
        branch: this.branch,
        context: this.obsContext,
      });
    }
  }

  sendToBrowser(ws: WebSocket, type: string, payload: any) {
    console.log("Sending to browser:", type, payload);

    try { ws.send(JSON.stringify({ type, payload })); }
    catch (e) { console.error("Failed to send to browser socket:", e); }
  }

  broadcastToBrowsers(type: string, payload: any) {
    const message = JSON.stringify({ type, payload });

    this.browserSockets.forEach(ws => {
      try { ws.send(message); } 
      catch (e) { this.browserSockets.delete(ws); }
    });
  }
}


export class GmodPublic extends BaseSession {
  protected override branch = "public";
}
export class GmodSixtyFour extends BaseSession {
  protected override branch = "sixty-four";
}
export class GmodPrerelease extends BaseSession {
  protected override branch = "prerelease";
}
export class GmodDev extends BaseSession {
  protected override branch = "dev";
}

const MAX_SESSIONS_PER_IP = 2;

async function hashIP(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

export class QueueDO extends DurableObject<Env> {
  activeSessions: Map<string, string>; // sessionId → type
  sessionIPs: Map<string, string>; // sessionId → hashed IP
  waitingQueue: {
    ticketId: string;
    sessionType: string;
    ip: string;
    resolve: (value: string) => void
  }[];
  resolvedTickets: Map<string, { sessionId: string; sessionType: string }>;
  maxPerType: Record<string, number>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.activeSessions = new Map();
    this.sessionIPs = new Map();
    this.waitingQueue = [];
    this.resolvedTickets = new Map();
    this.maxPerType = {
      "public": 10,
      "sixty-four": 5,
      "prerelease": 2,
      "dev": 2,
    };

    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.list<{ type: string; ip: string }>({ prefix: "session:" });
      for (const [key, value] of stored) {
        const sessionId = key.slice("session:".length);
        this.activeSessions.set(sessionId, value.type);
        this.sessionIPs.set(sessionId, value.ip);
      }
    });
  }

  private async persistSession(sessionId: string, type: string, ip: string) {
    this.activeSessions.set(sessionId, type);
    this.sessionIPs.set(sessionId, ip);
    await this.ctx.storage.put(`session:${sessionId}`, { type, ip });
  }

  private async removeSession(sessionId: string) {
    this.activeSessions.delete(sessionId);
    this.sessionIPs.delete(sessionId);
    await this.ctx.storage.delete(`session:${sessionId}`);
  }

  activeSessionCountForIP(ip: string): number {
    let count = 0;
    for (const [sessionId, sessionIp] of this.sessionIPs) {
      if (sessionIp === ip && this.activeSessions.has(sessionId)) count++;
    }
    return count;
  }

  activeCountForType(type: string): number {
    let count = 0;
    for (const t of this.activeSessions.values()) {
      if (t === type) count++;
    }
    return count;
  }

  maxTotalSessions = 12;

  hasCapacity(type: string): boolean {
    const max = this.maxPerType[type] ?? 2;
    return this.activeCountForType(type) < max && this.activeSessions.size < this.maxTotalSessions;
  }

  private snapshotFor(branch: string): CapacitySnapshot {
    return {
      branch,
      branchUsed: this.activeCountForType(branch),
      branchMax: this.maxPerType[branch] ?? 2,
      totalUsed: this.activeSessions.size,
      totalMax: this.maxTotalSessions,
      queueDepth: this.waitingQueue.length,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal-only: the worker entrypoint routes /api/* and /ws/* to DOs,
    // so /internal/* paths are unreachable externally (404 at the worker)
    // but work over DO stub-to-stub calls, which bypass the entrypoint.
    if (url.pathname === "/internal/capacity") {
      const branch = url.searchParams.get("branch");
      if (!branch) return new Response("Missing branch", { status: 400 });
      return new Response(JSON.stringify(this.snapshotFor(branch)), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/api/request-session") {
      const sessionType = url.searchParams.get("type") || "public";
      const rawIP = request.headers.get("CF-Connecting-IP") || "unknown";
      const clientIP = rawIP !== "unknown" ? await hashIP(rawIP) : "unknown";

      if (clientIP !== "unknown" && this.activeSessionCountForIP(clientIP) >= MAX_SESSIONS_PER_IP) {
        const obsContext = parseContext(request.headers.get(OBS_CONTEXT_HEADER));
        void notify.warning(this.env, {
          title: "IP rate limit hit",
          description: `Tried to open a **${sessionType}** session past the per-IP limit of **${MAX_SESSIONS_PER_IP}**.`,
          context: obsContext,
        });

        return new Response(JSON.stringify({
          status: "IP_LIMIT",
          limit: MAX_SESSIONS_PER_IP,
        }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (this.hasCapacity(sessionType)) {
        const sessionId = crypto.randomUUID();
        await this.persistSession(sessionId, sessionType, clientIP);
        return new Response(JSON.stringify({ status: "READY", sessionId }), { headers: { "Content-Type": "application/json" }, });
      } else {
        const ticketId = crypto.randomUUID();
        this.waitingQueue.push({ ticketId, sessionType, ip: clientIP, resolve: (sessionId: string) => {
          this.resolvedTickets.set(ticketId, { sessionId, sessionType });
        }});
        const position = this.waitingQueue.filter(w => w.sessionType === sessionType).length;

        const obsContext = parseContext(request.headers.get(OBS_CONTEXT_HEADER));
        if (obsContext) {
          void notify.queueEntered(this.env, {
            sessionType,
            position,
            capacity: this.snapshotFor(sessionType),
            context: obsContext,
          });
        }

        return new Response(JSON.stringify({
          status: "QUEUED",
          ticketId,
          position
        }), {
          status: 202,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }
    }

    if (url.pathname === "/api/queue-status") {
      const ticketId = url.searchParams.get("ticketId");
      if (!ticketId) return new Response("Missing ticketId", { status: 400 });

      if (this.resolvedTickets.has(ticketId)) {
        const { sessionId, sessionType } = this.resolvedTickets.get(ticketId)!;
        this.resolvedTickets.delete(ticketId);

        return new Response(JSON.stringify({
          status: "READY",
          sessionId,
          sessionType
        }), {
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      const entry = this.waitingQueue.find(p => p.ticketId === ticketId);
      if (!entry) {
        return new Response(JSON.stringify({
          error: "Ticket not found or already processed."
        }), {
          status: 404
        })
      }

      const position = this.waitingQueue
        .filter(w => w.sessionType === entry.sessionType)
        .findIndex(w => w.ticketId === ticketId) + 1;

      return new Response(JSON.stringify({
        status: "QUEUED",
        position
      }), {
        headers: {
          "Content-Type": "application/json"
        }
      });
    }

    if (url.pathname === "/api/session-closed") {
      const { sessionId } = await request.json<{sessionId: string}>();
      const closedType = this.activeSessions.get(sessionId);
      await this.removeSession(sessionId);

      if (closedType) {
        const idx = this.waitingQueue.findIndex(w => w.sessionType === closedType);
        if (idx !== -1) {
          const nextInLine = this.waitingQueue.splice(idx, 1)[0];
          const newSessionId = crypto.randomUUID();
          await this.persistSession(newSessionId, nextInLine.sessionType, nextInLine.ip);
          nextInLine.resolve(newSessionId);
        }
      }

      return new Response("Session closed and slot freed.", { status: 200 });
    }

    if (url.pathname === "/api/session-status") {
      const sessionId = url.searchParams.get("session");
      if (!sessionId) {
        return new Response(JSON.stringify({ status: "not-found" }), { headers: { "Content-Type": "application/json" } });
      }

      // Check if session is currently active
      if (this.activeSessions.has(sessionId)) {
        const sessionType = this.activeSessions.get(sessionId)!;
        return new Response(JSON.stringify({ status: "active", sessionType }), { headers: { "Content-Type": "application/json" } });
      }

      // Check R2 for ended session
      const logKey = `sessions/${sessionId}/logs.log`;
      const logObject = await this.env.LOG_BUCKET.get(logKey);
      if (!logObject) {
        return new Response(JSON.stringify({ status: "not-found" }), { headers: { "Content-Type": "application/json" } });
      }

      const logs = await logObject.text();
      const sessionKey = `sessions/${sessionId}/session.json`;
      const sessionObject = await this.env.LOG_BUCKET.get(sessionKey);
      const sessionData = sessionObject ? JSON.parse(await sessionObject.text()) : {};
      return new Response(JSON.stringify({
        status: "ended",
        logs,
        scripts: sessionData.scripts || {},
        metadata: sessionData.metadata || null,
      }), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("Not found in QueueDO", { status: 404 });
  }
}

// --- Main Worker Entrypoint ---
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const forwarded = withObsHeader(request);

    if (url.pathname.startsWith("/api/")) {
      const queueDO = env.QUEUE_DO.get(env.QUEUE_DO.idFromName("global-queue"));
      return queueDO.fetch(forwarded);
    }

    if (url.pathname.startsWith("/ws/")) {
      const sessionId = url.searchParams.get("session");
      const branch = url.searchParams.get("type") || "public";
      if (!sessionId) {
        return new Response("Missing 'session' param for WebSocket", { status: 400 });
      }

      let sessionBinding: DurableObjectNamespace;
      switch(branch) {
        case "sixty-four": sessionBinding = env.GMOD_SIXTYFOUR; break;
        case "prerelease": sessionBinding = env.GMOD_PRERELEASE; break;
        case "dev":        sessionBinding = env.GMOD_DEV; break;
        default:           sessionBinding = env.GMOD_PUBLIC;
      }

      const sessionDOId = sessionBinding.idFromName(sessionId);
      const stub = sessionBinding.get(sessionDOId);
      return stub.fetch(forwarded);
    }

    return new Response("Not Found", { status: 404 });
  },
};

// Runs on the real request path — must never throw. Worst case: we log
// and forward the unmodified request (context just won't be attached).
function withObsHeader(request: Request): Request {
  try {
    const obsContext = extractRequestContext(request);
    const headers = new Headers(request.headers);
    headers.set(OBS_CONTEXT_HEADER, serializeContext(obsContext));
    return new Request(request, { headers });
  } catch (e) {
    const name = e instanceof Error ? e.name : typeof e;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[obs] withObsHeader failed, forwarding without context: ${name}: ${msg}`);
    return request;
  }
}

