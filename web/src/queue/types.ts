import type { SessionType } from "@glua/shared";

export interface QueueEntry {
  ticketId: string;
  sessionType: SessionType;
  ip: string;
  createdAt: number;
}

export interface ResolvedTicket {
  sessionId: string;
  sessionType: SessionType;
  createdAt: number;
}
