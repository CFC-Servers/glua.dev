import { DurableObject } from "cloudflare:workers";
import { Container } from "@cloudflare/containers";

// --- Type Definitions ---
interface WebSocketMessage {
    type: string;
    payload?: any;
}

export interface Env {
    // These are now the primary DOs, not SessionManager
    GMOD_PUBLIC: DurableObjectNamespace;
    GMOD_SIXTYFOUR: DurableObjectNamespace;
    GMOD_PRERELEASE: DurableObjectNamespace;
    GMOD_DEV: DurableObjectNamespace;
    
    QUEUE_DO: DurableObjectNamespace<QueueDO>;
    LOG_BUCKET: R2Bucket;
    WORKER_URL: string;
}

// --- Container / Session Manager Base Class ---
// This is the new core. It extends Container and has all the session logic.
export class BaseSession extends Container<Env> {
    sessionState: "NEW" | "PROVISIONING" | "ACTIVE" | "CLOSED";
    browserSockets: Set<WebSocket>;
    containerSocket: WebSocket | null;
    sessionId: string | null;
    logBuffer: string[];

    constructor(ctx: DurableObjectState, env: Env) {
        // We pass the container config to the super constructor.
        super(ctx, env, {
            // Container configuration
            sleepAfter: "5m",
            defaultPort: 8080 // Port the Go agent listens on
        });
        
        this.sessionState = "NEW";
        this.browserSockets = new Set();
        this.containerSocket = null;
        this.sessionId = null;
        this.logBuffer = [];

        this.ctx.blockConcurrencyWhile(() => this.initialize());
    }
    
    async initialize() {
        const currentAlarm = await this.ctx.storage.getAlarm();
        if (currentAlarm === null) {
            this.ctx.storage.setAlarm(Date.now() + 60 * 1000);
        }
    }

    // The fetch handler is now the primary entry point for this DO.
    // It routes WebSocket connections from either the browser or the agent.
    override async fetch(request: Request): Promise<Response> {
        if (this.sessionState === "CLOSED") {
             return new Response("This session has been closed.", { status: 410 });
        }
        const url = new URL(request.url);
        const upgradeHeader = request.headers.get("Upgrade");
        if (upgradeHeader !== "websocket") {
            return new Response("Expected a WebSocket upgrade request.", { status: 426 });
        }

        this.sessionId = url.searchParams.get("session");
        console.log(`Set Session ID: ${this.sessionId}, Pathname: ${url.pathname}`);
        
        const [client, server] = Object.values(new WebSocketPair());

        if (url.pathname === "/ws/agent") {
            this.handleAgentConnection(server);
        } else if (url.pathname === "/ws/browser") {
            this.handleBrowserSession(server);
        } else {
            return new Response("Unknown WebSocket endpoint.", { status: 404 });
        }

        return new Response(null, { status: 101, webSocket: client });
    }
    
    handleAgentConnection(ws: WebSocket) {
        (ws as any).accept();
        if (this.containerSocket) {
            ws.close(1013, "Duplicate agent connection.");
            return;
        }
        this.containerSocket = ws;
        this.sessionState = "ACTIVE";
        this.broadcastToBrowsers("LOGS", ["\u001b[32mAgent connected. Session is live.\u001b[0m"]);
        
        ws.addEventListener("message", (msg) => this.onAgentMessage(msg));
        ws.addEventListener("close", () => this.closeSession());
        ws.addEventListener("error", () => this.closeSession());
    }

    async handleBrowserSession(ws: WebSocket) {
        (ws as any).accept();
        this.browserSockets.add(ws);

        try {
            const logKey = `logs/${this.sessionId}.log`;
            const existingLogs = await this.env.LOG_BUCKET.get(logKey);
            if (existingLogs) this.sendToBrowser(ws, "HISTORY", await existingLogs.text());
            if (this.logBuffer.length > 0) this.sendToBrowser(ws, "LOGS", this.logBuffer);
        } catch (e) { console.error("Could not get log history from R2", e); }
        
        if (this.sessionState === "NEW") {
            this.sessionState = "PROVISIONING";
            this.broadcastToBrowsers("LOGS", ["\u001b[33mProvisioning container...\u001b[0m"]);
            // We can now call `this.start()` because we extend the Container class.
            try {
                await this.start({
                  envVars: {
                    SESSION_ID: this.sessionId || "",
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

        ws.addEventListener("message", (msg) => this.onBrowserMessage(msg));
        ws.addEventListener("close", () => this.browserSockets.delete(ws));
    }
    
    // --- Lifecycle hooks from @cloudflare/containers ---
    override onStart(): void {
        this.broadcastToBrowsers("LOGS", ["\u001b[33mContainer started. Waiting for agent...\u001b[0m"]);
    }
    
    override async onStop(stopParams: { exitCode: number; reason: string }): Promise<void> {
        await this.closeSession();
    }
    
    override async onError(error: unknown): Promise<void> {
        console.error("Container Error:", error);
        await this.closeSession();
    }
    
    // --- Message and State Logic ---
    onAgentMessage(msg: MessageEvent) {
        try {
            const message: WebSocketMessage = JSON.parse(msg.data as string);
            if (message.type === "LOG" || message.type === "HISTORY_DUMP") {
                const lines = Array.isArray(message.payload) ? message.payload : [message.payload];
                this.logBuffer.push(...lines);
                this.broadcastToBrowsers("LOGS", lines);
            }
            if (message.type === "HEALTH") {
                this.broadcastToBrowsers("HEALTH", message.payload);
            }
        } catch (e) { console.error("Failed to parse agent message:", e); }
    }

    onBrowserMessage(msg: MessageEvent) {
         try {
            const message: WebSocketMessage = JSON.parse(msg.data as string);
            if (this.containerSocket?.readyState === WebSocket.OPEN) {
                this.containerSocket.send(JSON.stringify(message));
            }
        } catch (e) { console.error("Failed to parse browser message:", e); }
    }
    
    async closeSession() {
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
    }
    
    async notifyQueueManagerOfClosure() {
        const queueDO = this.env.QUEUE_DO.get(this.env.QUEUE_DO.idFromName("global-queue"));
        void queueDO.fetch("http://do/api/session-closed", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ sessionId: this.ctx.id.name! })
        });
    }
    
    // ... WebSocket helpers and R2 flush logic ...
    async alarm() {
        await this.flushLogsToR2();
        if (this.sessionState !== "CLOSED") {
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


// These are the actual DO classes that will be bound in wrangler.jsonc.
// They just inherit all the logic from the BaseSession.
export class GmodPublic extends BaseSession {}
export class GmodSixtyFour extends BaseSession {}
export class GmodPrerelease extends BaseSession {}
export class GmodDev extends BaseSession {}

// QueueDO remains unchanged.
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
            
            // Route to the correct container DO based on the branch
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

