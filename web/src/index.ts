import { DurableObject } from "cloudflare:workers";
import { Container, getContainer } from "@cloudflare/containers";

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
}

// --- Container / Session Manager Base Class ---
export class BaseSession extends Container<Env> {
  sessionState: "NEW" | "PROVISIONING" | "ACTIVE" | "CLOSED";
  browserSockets: Set<WebSocket>;
  containerSocket: WebSocket | null;
  logBuffer: string[];
  sessionMetadata: { branch: string; gameVersion: string; containerTag: string } | null;

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
      console.warn(`Agent connection attempted in unexpected state: ${this.sessionState}.`);
      ws.close(1013, "Duplicate or unexpected agent connection.");
      return;
    }

    this.containerSocket = ws;
    this.sessionState = "ACTIVE";
    this.broadcastToBrowsers("LOGS", ["\u001b[32mAgent connected. Session is live.\u001b[0m"]);
    this.ctx.storage.setAlarm(Date.now() + 60 * 1000);

    ws.addEventListener("message", this.onAgentMessage);
    ws.addEventListener("close", this.closeSession);
    ws.addEventListener("error", this.closeSession);
  }

  handleBrowserWebSocket(ws: WebSocket, sessionId: string) {
    (ws as any).accept();
    this.browserSockets.add(ws);

    // Restore logs from R2 and buffer for the new client
    this.ctx.blockConcurrencyWhile(async () => {
        try {
            const logKey = `logs/${sessionId}.log`;
            const existingLogs = await this.env.LOG_BUCKET.get(logKey);
            let fullLogContent = "";
            if (existingLogs) {
                fullLogContent += await existingLogs.text();
            }
            // Append any logs that have come in since the DO was activated
            if (this.logBuffer.length > 0) {
                if (fullLogContent.length > 0 && !fullLogContent.endsWith("\n")) {
                    fullLogContent += "\n"; // Ensure newline if content exists
                }
                fullLogContent += this.logBuffer.join("\n");
            }
            if (fullLogContent.length > 0) {
                this.sendToBrowser(ws, "HISTORY", fullLogContent);
            }
        } catch (e) {
            console.error("Could not get log history from R2", e);
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
        await this.closeSession();
    }
  }

  override onStart(): void {
    this.broadcastToBrowsers("LOGS", ["\u001b[33mContainer started. Waiting for agent...\u001b[0m"]);
  }

  override async onStop(): Promise<void> {
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
          this.broadcastToBrowsers("LOGS", lines);
          break;
        case "HEALTH":
          this.broadcastToBrowsers("HEALTH", message.payload);
          break;
        case "METADATA":
          this.sessionMetadata = message.payload as { branch: string; gameVersion: string; containerTag: string };
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
      if (this.containerSocket?.readyState === WebSocket.OPEN) {
        this.containerSocket.send(JSON.stringify(message));
      }
    } catch (e) { console.error("Failed to parse browser message:", e); }
  }

  async closeSession() {
    const stack = new Error().stack;
    console.trace("Closing session", this.sessionState);
    console.log(stack)

    if (this.sessionState === "CLOSED") return;
    this.sessionState = "CLOSED";

    if(this.containerSocket) {
      try { this.containerSocket.close(1000, "Session closed."); } catch(e) {}
    }

    this.containerSocket = null;
    this.broadcastToBrowsers("SESSION_CLOSED", {});
    this.browserSockets.forEach(ws => {
      try { ws.close(1000, "Session ended."); } catch(e) {}
    });

    await this.flushLogsToR2();
    await this.notifyQueueManagerOfClosure();

    try { await this.stop(); }
    catch(e) { console.error("Error stopping container:", e); }
  }

  async notifyQueueManagerOfClosure() {
    const queueDO = this.env.QUEUE_DO.get(this.env.QUEUE_DO.idFromName("global-queue"));
    void queueDO.fetch("http://do/api/session-closed", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ sessionId: this.ctx.id.name! })
    });
  }

  async alarm() {
    await this.flushLogsToR2();

    if (this.sessionState === "ACTIVE") {
      this.ctx.storage.setAlarm(Date.now() + 60 * 1000);
    }
  }

  async flushLogsToR2() {
    if (this.logBuffer.length === 0) return;
    const logKey = `logs/${this.ctx.id.name!}.log`;
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

  sendToBrowser(ws: WebSocket, type: string, payload: any) {
    console.log("Sending to browser:", type, payload);

    try { ws.send(JSON.stringify({ type, payload })); }
    catch (e) { console.error("Failed to send to browser socket:", e); }
  }

  broadcastToBrowsers(type: string, payload: any) {
    console.log("Broadcasting to browsers:", type, payload);
    const message = JSON.stringify({ type, payload });

    this.browserSockets.forEach(ws => {
      try { ws.send(message); } 
      catch (e) { this.browserSockets.delete(ws); }
    });
  }
}


// --- Exported Classes for Wrangler ---
export class GmodPublic extends BaseSession {}
export class GmodSixtyFour extends BaseSession {}
export class GmodPrerelease extends BaseSession {}
export class GmodDev extends BaseSession {}
export class QueueDO extends DurableObject<Env> {
  activeSessions: Set<string>; waitingQueue: { ticketId: string; resolve: (value: string) => void }[]; resolvedTickets: Map<string, string>; maxSessions: number;
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); this.activeSessions = new Set(); this.waitingQueue = []; this.resolvedTickets = new Map(); this.maxSessions = 10; }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/request-session") {
      if (this.activeSessions.size < this.maxSessions) {
        const sessionId = crypto.randomUUID(); this.activeSessions.add(sessionId);
        return new Response(JSON.stringify({ status: "READY", sessionId }), { headers: { "Content-Type": "application/json" }, });
      } else {
        const ticketId = crypto.randomUUID(); const position = this.waitingQueue.length + 1;
        new Promise<string>((resolve) => { this.waitingQueue.push({ ticketId, resolve }); }).then((sessionId) => { this.resolvedTickets.set(ticketId, sessionId); });
        return new Response(JSON.stringify({ status: "QUEUED", ticketId, position }), { status: 202, headers: { "Content-Type": "application/json" }, });
      }
    }
    if (url.pathname === "/api/queue-status") {
      const ticketId = url.searchParams.get("ticketId"); if (!ticketId) return new Response("Missing ticketId", { status: 400 });
      if (this.resolvedTickets.has(ticketId)) {
        const sessionId = this.resolvedTickets.get(ticketId)!; this.resolvedTickets.delete(ticketId);
        return new Response(JSON.stringify({ status: "READY", sessionId }), { headers: { "Content-Type": "application/json" }, });
      }
      const position = this.waitingQueue.findIndex(p => p.ticketId === ticketId);
      if (position === -1) { return new Response(JSON.stringify({ error: "Ticket not found or already processed."}), { status: 404 }); }
      return new Response(JSON.stringify({ status: "QUEUED", position: position + 1 }), { headers: { "Content-Type": "application/json" }, });
    }
    if (url.pathname === "/api/session-closed") {
      const { sessionId } = await request.json<{sessionId: string}>(); this.activeSessions.delete(sessionId);
      if (this.waitingQueue.length > 0) {
        const nextInLine = this.waitingQueue.shift()!; const newSessionId = crypto.randomUUID();
        this.activeSessions.add(newSessionId); nextInLine.resolve(newSessionId);
      }
      return new Response("Session closed and slot freed.", { status: 200 });
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

