import { DurableObject } from "cloudflare:workers";
import { Container, getContainer } from "@cloudflare/containers";

// --- Type Definitions ---
interface WebSocketMessage {
  type: string;
  payload?: any;
}

interface SessionOptions {
  map: string;
  gamemode: string;
  gitRepos: string[];
}

const ALLOWED_MAPS = ["gm_construct", "gm_flatgrass", "gm_fork"];
const DEFAULT_OPTIONS: SessionOptions = { map: "gm_construct", gamemode: "sandbox", gitRepos: [] };
const REPO_SIZE_LIMIT_KB = 50 * 1024; // 50MB

function validateSessionOptions(raw: any): SessionOptions {
  const opts = { ...DEFAULT_OPTIONS };
  if (raw?.map && ALLOWED_MAPS.includes(raw.map)) opts.map = raw.map;
  if (raw?.gamemode && typeof raw.gamemode === "string") {
    const gm = raw.gamemode.slice(0, 64).replace(/[^a-zA-Z0-9_]/g, "");
    if (gm) opts.gamemode = gm;
  }
  if (Array.isArray(raw?.gitRepos)) {
    opts.gitRepos = raw.gitRepos
      .filter((r: any) => typeof r === "string" && r.length <= 256)
      .filter((r: string) => {
        try { return new URL(r).hostname === "github.com"; }
        catch { return false; }
      })
      .slice(0, 5);
  }
  return opts;
}

function parseGitHubRepo(repoUrl: string): string | null {
  try {
    const url = new URL(repoUrl);
    if (url.hostname !== "github.com") return null;
    const segments = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const owner = segments[0];
    const repo = segments[1];
    if (!/^[a-zA-Z0-9._-]+$/.test(owner) || !/^[a-zA-Z0-9._-]+$/.test(repo)) return null;
    return `${owner}/${repo}`;
  } catch { return null; }
}

async function checkRepoSize(repoUrl: string): Promise<{ ok: boolean; sizeKB?: number; error?: string }> {
  const path = parseGitHubRepo(repoUrl);
  if (!path) return { ok: false, error: "Only GitHub repositories are supported" };

  try {
    const res = await fetch(`https://api.github.com/repos/${path}`, {
      headers: { "User-Agent": "glua-dev" },
    });
    if (!res.ok) return { ok: false, error: "Repository not found or not public" };
    const data = await res.json<{ size?: number; private?: boolean }>();
    if (data.private) return { ok: false, error: "Repository is private" };
    const sizeKB = data.size ?? 0;
    if (sizeKB > REPO_SIZE_LIMIT_KB) {
      return { ok: false, sizeKB, error: `Repository is too large (${Math.round(sizeKB / 1024)}MB, limit is ${Math.round(REPO_SIZE_LIMIT_KB / 1024)}MB)` };
    }
    return { ok: true, sizeKB };
  } catch (e) {
    return { ok: false, error: "Failed to check repository" };
  }
}

export interface Env {
  GMOD_PUBLIC: DurableObjectNamespace;
  GMOD_SIXTYFOUR: DurableObjectNamespace;
  GMOD_PRERELEASE: DurableObjectNamespace;
  GMOD_DEV: DurableObjectNamespace;
  QUEUE_DO: DurableObjectNamespace<QueueDO>;
  LOG_BUCKET: R2Bucket;
}

// --- Session Time Limits ---
const SESSION_DURATION = 10 * 60 * 1000;      // 10 minutes default
const SESSION_HARD_LIMIT = 15 * 60 * 1000;    // 15 minutes absolute max
const SESSION_EXTENSION = 5 * 60 * 1000;      // 5 minutes per extension
const EXTENSION_THRESHOLD = 2 * 60 * 1000;    // allow extension requests with <2min remaining
const ACTIVITY_PING_INTERVAL = 30 * 1000;     // 30 seconds

// --- Container / Session Manager Base Class ---
export class BaseSession extends Container<Env> {
  sessionState: "NEW" | "PROVISIONING" | "ACTIVE" | "CLOSED";
  browserSockets: Set<WebSocket>;
  containerSocket: WebSocket | null;
  logBuffer: string[];
  logLineCount: number;
  scriptBuffer: Record<string, { content: string; logLine: number }>;
  scriptCount: number;
  sessionMetadata: { branch: string; gameVersion: string; containerTag: string; startedAt: number; endedAt?: number; options?: SessionOptions } | null;
  sessionOptions: SessionOptions | null;
  sessionEndTime?: number;
  sessionDuration?: number;
  extensionGranted = false;

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
    this.sessionOptions = null;
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
      console.warn(`Agent connection attempted in unexpected state: ${this.sessionState}. Already had containerSocket?: ${!!this.containerSocket}`);
      // TODO: Why is this firing inappropriately for non-public branches?
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
    ws.addEventListener("close", () => this.closeSession());
    ws.addEventListener("error", () => this.closeSession());
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
      // Fetch session options from QueueDO
      const queueDO = this.env.QUEUE_DO.get(this.env.QUEUE_DO.idFromName("global-queue"));
      const optionsRes = await queueDO.fetch(`http://do/api/get-session-options?session=${sessionId}`);
      this.sessionOptions = await optionsRes.json<SessionOptions>();

      const envVars: Record<string, string> = {
        SESSION_ID: sessionId,
        WORKER_URL: "https://beta.glua.dev",
        MAP: this.sessionOptions.map,
        GAMEMODE: this.sessionOptions.gamemode,
      };
      if (this.sessionOptions.gitRepos.length > 0) {
        envVars.GIT_REPOS = this.sessionOptions.gitRepos.join(",");
      }

      await this.start({ envVars });
    } catch(e) {
      console.error("Container Start Error:", e);
      const errorMessage = `\u001b[31mFailed to start container: ${e instanceof Error ? e.message : String(e)}\u001b[0m`;
        this.broadcastToBrowsers("LOGS", [errorMessage]);
        await this.closeSession();
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
    await this.closeSession();
  }

  override async onError(error: unknown): Promise<void> {
    console.error("Container Error:", error);
    await this.closeSession();
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
          if (this.sessionOptions) {
            this.sessionMetadata.options = this.sessionOptions;
          }
          this.broadcastToBrowsers("CONTEXT_UPDATE", this.sessionMetadata);
          break;
        case "AGENT_SHUTDOWN":
           this.broadcastToBrowsers("LOGS", ["\u001b[31mAgent is shutting down...\u001b[0m"]);
           this.closeSession();
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

  async closeSession() {
    const stack = new Error().stack;
    console.trace("Closing session", this.sessionState);
    console.log(stack)

    if (this.sessionState === "CLOSED") return;
    this.sessionState = "CLOSED";
    if (this.sessionMetadata) {
      this.sessionMetadata.endedAt = Date.now();
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
        await this.closeSession();
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


export class GmodPublic extends BaseSession {}
export class GmodSixtyFour extends BaseSession {}
export class GmodPrerelease extends BaseSession {}
export class GmodDev extends BaseSession {}

export class QueueDO extends DurableObject<Env> {
  activeSessions: Map<string, { type: string; options: SessionOptions }>;
  waitingQueue: {
    ticketId: string;
    sessionType: string;
    options: SessionOptions;
    resolve: (value: string) => void;
  }[];
  resolvedTickets: Map<string, { sessionId: string; sessionType: string }>;
  maxPerType: Record<string, number>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.activeSessions = new Map();
    this.waitingQueue = [];
    this.resolvedTickets = new Map();
    this.maxPerType = {
      "public": 10,
      "sixty-four": 5,
      "prerelease": 2,
      "dev": 2,
    };
  }

  activeCountForType(type: string): number {
    let count = 0;
    for (const entry of this.activeSessions.values()) {
      if (entry.type === type) count++;
    }
    return count;
  }

  maxTotalSessions = 12;

  hasCapacity(type: string): boolean {
    const max = this.maxPerType[type] ?? 2;
    return this.activeCountForType(type) < max && this.activeSessions.size < this.maxTotalSessions;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/request-session") {
      let sessionType = "public";
      let options = DEFAULT_OPTIONS;

      if (request.method === "POST") {
        const body = await request.json<{ type?: string; options?: any }>();
        sessionType = body.type || "public";
        options = validateSessionOptions(body.options);
      } else {
        sessionType = url.searchParams.get("type") || "public";
      }

      // Check repo sizes before allowing the session
      if (options.gitRepos.length > 0) {
        const checks = await Promise.all(options.gitRepos.map(checkRepoSize));
        const failed = checks.find(c => !c.ok);
        if (failed) {
          return new Response(JSON.stringify({ status: "ERROR", error: failed.error }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      if (this.hasCapacity(sessionType)) {
        const sessionId = crypto.randomUUID();
        this.activeSessions.set(sessionId, { type: sessionType, options });
        return new Response(JSON.stringify({ status: "READY", sessionId }), { headers: { "Content-Type": "application/json" } });
      } else {
        const ticketId = crypto.randomUUID();
        this.waitingQueue.push({ ticketId, sessionType, options, resolve: (sessionId: string) => {
          this.resolvedTickets.set(ticketId, { sessionId, sessionType });
        }});
        const position = this.waitingQueue.filter(w => w.sessionType === sessionType).length;

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
      const closed = this.activeSessions.get(sessionId);
      this.activeSessions.delete(sessionId);

      if (closed) {
        const idx = this.waitingQueue.findIndex(w => w.sessionType === closed.type);
        if (idx !== -1) {
          const nextInLine = this.waitingQueue.splice(idx, 1)[0];
          const newSessionId = crypto.randomUUID();
          this.activeSessions.set(newSessionId, { type: nextInLine.sessionType, options: nextInLine.options });
          nextInLine.resolve(newSessionId);
        }
      }

      return new Response("Session closed and slot freed.", { status: 200 });
    }

    if (url.pathname === "/api/get-session-options") {
      const sessionId = url.searchParams.get("session");
      if (!sessionId || !this.activeSessions.has(sessionId)) {
        return new Response(JSON.stringify(DEFAULT_OPTIONS), { headers: { "Content-Type": "application/json" } });
      }
      const { options } = this.activeSessions.get(sessionId)!;
      return new Response(JSON.stringify(options), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/api/session-status") {
      const sessionId = url.searchParams.get("session");
      if (!sessionId) {
        return new Response(JSON.stringify({ status: "not-found" }), { headers: { "Content-Type": "application/json" } });
      }

      // Check if session is currently active
      if (this.activeSessions.has(sessionId)) {
        const { type: sessionType } = this.activeSessions.get(sessionId)!;
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

    if (url.pathname.startsWith("/api/")) {
      const queueDO = env.QUEUE_DO.get(env.QUEUE_DO.idFromName("global-queue"));
      return queueDO.fetch(request);
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
      return stub.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
};

