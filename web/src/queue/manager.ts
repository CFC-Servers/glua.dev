import { DurableObject } from "cloudflare:workers";
import type { SessionType } from "@glua/shared";
import { MAX_SESSIONS_PER_IP, VALID_SESSION_TYPES } from "@glua/shared";
import { CAPACITY, QUEUE_TIMING } from "../constants";
import type { Env } from "../env";
import { type CapacitySnapshot, notify, OBS_CONTEXT_HEADER, parseContext } from "../observability";
import { hashIP } from "../utils";
import {
  QUEUE_PREFIX,
  RESOLVED_PREFIX,
  SESSION_PREFIX,
  queueKey,
  resolvedKey,
  sessionKey,
  stripResolvedPrefix,
  stripSessionPrefix,
} from "./storage-keys";
import type { QueueEntry, ResolvedTicket } from "./types";

/**
 * Global singleton that manages session allocation and the waiting queue
 *
 * When a user requests a session, this DO either allocates one immediately
 * (if capacity allows) or puts them in a FIFO queue. When a session closes,
 * the next person in line gets promoted.
 *
 * Keyed as `idFromName("global-queue")` — there's exactly one of these
 */
export class SessionManager extends DurableObject<Env> {
  private activeSessions: Map<string, SessionType>;
  private sessionIPs: Map<string, string>;
  private waitingQueue: QueueEntry[];
  private resolvedTickets: Map<string, ResolvedTicket>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.activeSessions = new Map();
    this.sessionIPs = new Map();
    this.waitingQueue = [];
    this.resolvedTickets = new Map();

    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.list<{ type: SessionType; ip: string }>({ prefix: SESSION_PREFIX });
      for (const [key, value] of stored) {
        const sessionId = stripSessionPrefix(key);
        this.activeSessions.set(sessionId, value.type);
        this.sessionIPs.set(sessionId, value.ip);
      }

      const now = Date.now();
      const expiredKeys: string[] = [];

      const queueStored = await ctx.storage.list<QueueEntry>({ prefix: QUEUE_PREFIX });
      for (const [key, entry] of queueStored) {
        if (now - entry.createdAt > QUEUE_TIMING.entryTtl) {
          expiredKeys.push(key);
        } else {
          this.waitingQueue.push(entry);
        }
      }

      const resolvedStored = await ctx.storage.list<ResolvedTicket>({ prefix: RESOLVED_PREFIX });
      for (const [key, value] of resolvedStored) {
        if (now - value.createdAt > QUEUE_TIMING.resolvedTtl) {
          expiredKeys.push(key);
        } else {
          this.resolvedTickets.set(stripResolvedPrefix(key), value);
        }
      }

      if (expiredKeys.length > 0) {
        await ctx.storage.delete(expiredKeys);
      }

      if (this.waitingQueue.length > 0 || this.resolvedTickets.size > 0) {
        await ctx.storage.setAlarm(Date.now() + QUEUE_TIMING.cleanupInterval);
      }
    });
  }

  // ── Routing ──

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/internal/capacity":
        return this.handleCapacity(url);
      case "/api/request-session":
        return this.handleRequestSession(request, url);
      case "/api/queue-status":
        return this.handleQueueStatus(url);
      case "/api/session-closed":
        return this.handleSessionClosed(request);
      case "/api/session-status":
        return this.handleSessionStatus(url);
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  // ── Route handlers ──

  private handleCapacity(url: URL): Response {
    const branch = url.searchParams.get("branch");
    if (!branch) return new Response("Missing branch", { status: 400 });
    return Response.json(this.snapshotFor(branch));
  }

  private async handleRequestSession(request: Request, url: URL): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const sessionType = (url.searchParams.get("type") || "public") as SessionType;
    if (!VALID_SESSION_TYPES.includes(sessionType)) {
      return Response.json({ error: "Invalid session type" }, { status: 400 });
    }

    const rawIP = request.headers.get("CF-Connecting-IP");
    if (!rawIP) {
      // CF always populates this header in production — getting here means
      // either an unusual proxy setup or a Cloudflare bug. Either way it
      // breaks our per-IP rate limiting, so we want to know about it
      void notify.warning(this.env, {
        title: "Missing CF-Connecting-IP",
        description: "A request reached SessionManager without a CF-Connecting-IP header — per-IP rate limiting is disabled for this session",
        context: parseContext(request.headers.get(OBS_CONTEXT_HEADER)),
      });
    }
    const clientIP = rawIP ? await hashIP(rawIP) : "unknown";

    if (clientIP !== "unknown" && this.activeSessionCountForIP(clientIP) >= MAX_SESSIONS_PER_IP) {
      const obsContext = parseContext(request.headers.get(OBS_CONTEXT_HEADER));
      void notify.warning(this.env, {
        title: "IP rate limit hit",
        description: `Tried to open a **${sessionType}** session past the per-IP limit of **${MAX_SESSIONS_PER_IP}**.`,
        context: obsContext,
      });
      return Response.json({ status: "IP_LIMIT", limit: MAX_SESSIONS_PER_IP }, { status: 429 });
    }

    if (this.hasCapacity(sessionType)) {
      const sessionId = crypto.randomUUID();
      await this.persistSession(sessionId, sessionType, clientIP);
      return Response.json({ status: "READY", sessionId });
    }

    const ticketId = crypto.randomUUID();
    const entry: QueueEntry = { ticketId, sessionType, ip: clientIP, createdAt: Date.now() };
    this.waitingQueue.push(entry);
    await this.ctx.storage.put(queueKey(ticketId), entry);
    await this.ctx.storage.setAlarm(Date.now() + QUEUE_TIMING.cleanupInterval);
    const position = this.waitingQueue.filter((w) => w.sessionType === sessionType).length;

    const obsContext = parseContext(request.headers.get(OBS_CONTEXT_HEADER));
    if (obsContext) {
      void notify.queueEntered(this.env, {
        sessionType,
        position,
        capacity: this.snapshotFor(sessionType),
        context: obsContext,
      });
    }

    return Response.json({ status: "QUEUED", ticketId, position }, { status: 202 });
  }

  private handleQueueStatus(url: URL): Response {
    const ticketId = url.searchParams.get("ticketId");
    if (!ticketId) return new Response("Missing ticketId", { status: 400 });

    if (this.resolvedTickets.has(ticketId)) {
      const { sessionId, sessionType } = this.resolvedTickets.get(ticketId)!;
      this.resolvedTickets.delete(ticketId);
      void this.ctx.storage.delete(resolvedKey(ticketId));
      return Response.json({ status: "READY", sessionId, sessionType });
    }

    const entry = this.waitingQueue.find((p) => p.ticketId === ticketId);
    if (!entry) {
      return Response.json({ error: "Ticket not found or already processed." }, { status: 404 });
    }

    const position =
      this.waitingQueue.filter((w) => w.sessionType === entry.sessionType).findIndex((w) => w.ticketId === ticketId) +
      1;

    return Response.json({ status: "QUEUED", position });
  }

  private async handleSessionClosed(request: Request): Promise<Response> {
    const { sessionId } = await request.json<{ sessionId: string }>();
    const closedType = this.activeSessions.get(sessionId);
    await this.removeSession(sessionId);

    if (closedType) {
      const idx = this.waitingQueue.findIndex((w) => w.sessionType === closedType);
      if (idx !== -1) {
        const nextInLine = this.waitingQueue.splice(idx, 1)[0];
        const newSessionId = crypto.randomUUID();
        await this.persistSession(newSessionId, nextInLine.sessionType, nextInLine.ip);
        const resolved: ResolvedTicket = {
          sessionId: newSessionId,
          sessionType: nextInLine.sessionType,
          createdAt: Date.now(),
        };
        this.resolvedTickets.set(nextInLine.ticketId, resolved);
        await this.ctx.storage.put(resolvedKey(nextInLine.ticketId), resolved);
        await this.ctx.storage.delete(queueKey(nextInLine.ticketId));
      }
    }

    return new Response("Session closed and slot freed.", { status: 200 });
  }

  private async handleSessionStatus(url: URL): Promise<Response> {
    const sessionId = url.searchParams.get("session");
    if (!sessionId) {
      return Response.json({ status: "not-found" }, { status: 404 });
    }

    if (this.activeSessions.has(sessionId)) {
      const sessionType = this.activeSessions.get(sessionId)!;
      return Response.json({ status: "active", sessionType });
    }

    const logKey = `sessions/${sessionId}/logs.log`;
    const logObject = await this.env.LOG_BUCKET.get(logKey);
    if (!logObject) {
      return Response.json({ status: "not-found" }, { status: 404 });
    }

    const logs = await logObject.text();
    const sessionKey = `sessions/${sessionId}/session.json`;
    const sessionObject = await this.env.LOG_BUCKET.get(sessionKey);
    const sessionData = sessionObject ? JSON.parse(await sessionObject.text()) : {};
    return Response.json({
      status: "ended",
      logs,
      scripts: sessionData.scripts || {},
      metadata: sessionData.metadata || null,
    });
  }

  // ── Capacity tracking ──

  private activeSessionCountForIP(ip: string): number {
    let count = 0;
    for (const [sessionId, sessionIp] of this.sessionIPs) {
      if (sessionIp === ip && this.activeSessions.has(sessionId)) count++;
    }
    return count;
  }

  private activeCountForType(type: string): number {
    let count = 0;
    for (const t of this.activeSessions.values()) {
      if (t === type) count++;
    }
    return count;
  }

  private hasCapacity(type: SessionType): boolean {
    const max = CAPACITY.maxPerType[type] ?? 2;
    return this.activeCountForType(type) < max && this.activeSessions.size < CAPACITY.maxTotal;
  }

  private snapshotFor(branch: string): CapacitySnapshot {
    return {
      branch,
      branchUsed: this.activeCountForType(branch),
      branchMax: CAPACITY.maxPerType[branch as SessionType] ?? 2,
      totalUsed: this.activeSessions.size,
      totalMax: CAPACITY.maxTotal,
      queueDepth: this.waitingQueue.length,
    };
  }

  // ── Storage helpers ──

  private async persistSession(sessionId: string, type: SessionType, ip: string) {
    this.activeSessions.set(sessionId, type);
    this.sessionIPs.set(sessionId, ip);
    await this.ctx.storage.put(sessionKey(sessionId), { type, ip });
  }

  private async removeSession(sessionId: string) {
    this.activeSessions.delete(sessionId);
    this.sessionIPs.delete(sessionId);
    await this.ctx.storage.delete(sessionKey(sessionId));
  }

  // ── TTL cleanup ──

  async alarm() {
    const now = Date.now();
    const expiredKeys: string[] = [];

    this.waitingQueue = this.waitingQueue.filter((entry) => {
      if (now - entry.createdAt > QUEUE_TIMING.entryTtl) {
        expiredKeys.push(queueKey(entry.ticketId));
        return false;
      }
      return true;
    });

    for (const [ticketId, resolved] of this.resolvedTickets) {
      if (now - resolved.createdAt > QUEUE_TIMING.resolvedTtl) {
        this.resolvedTickets.delete(ticketId);
        expiredKeys.push(resolvedKey(ticketId));
      }
    }

    if (expiredKeys.length > 0) {
      await this.ctx.storage.delete(expiredKeys);
    }

    if (this.waitingQueue.length > 0 || this.resolvedTickets.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + QUEUE_TIMING.cleanupInterval);
    }
  }
}
