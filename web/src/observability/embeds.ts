import type {
  CapacitySnapshot,
  CloseReason,
  ErrorEvent,
  QueueEnteredEvent,
  RequestContext,
  SessionEndedEvent,
  SessionStartedEvent,
  WarningEvent,
} from "./types";

interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  footer?: { text: string };
  fields?: DiscordEmbedField[];
}

export interface DiscordWebhookPayload {
  embeds: DiscordEmbed[];
}

const COLORS = {
  sessionStart: 0x10B981, // emerald-500
  sessionEnd:   0x6366F1, // indigo-500
  warning:      0xF59E0B, // amber-500
  error:        0xEF4444, // red-500
  info:         0x06B6D4, // cyan-500
} as const;

const BRANCH_META: Record<string, { emoji: string; label: string }> = {
  "public":     { emoji: "🔵", label: "public"     },
  "sixty-four": { emoji: "🟣", label: "sixty-four" },
  "prerelease": { emoji: "🟡", label: "prerelease" },
  "dev":        { emoji: "🔴", label: "dev"        },
};

const FOOTER = { text: "glua.dev · observability" } as const;

const LIMIT_DESCRIPTION = 4096;
const LIMIT_UA_INLINE = 200;
const LIMIT_ERROR_MESSAGE = 500;
const LIMIT_STACK = 900;

const relativeTimestamp = (): string => `<t:${Math.floor(Date.now() / 1000)}:R>`;

const flag = (cc: string | undefined): string =>
  cc ? `:flag_${cc.toLowerCase()}:` : "🌐";

const code = (s: string): string => `\`${s}\``;
const link = (text: string, url: string): string => `[${text}](${url})`;
const sub = (s: string): string => `-# ${s}`;

const truncate = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;

const ipLink = (ip: string): string => link(`\`${ip}\``, `https://ipinfo.io/${ip}`);

const ispLink = (ctx: RequestContext): string => {
  if (ctx.asOrganization && ctx.asn !== undefined) {
    return link(ctx.asOrganization, `https://ipinfo.io/AS${ctx.asn}`);
  }

  if (ctx.asOrganization) return ctx.asOrganization;
  if (ctx.asn !== undefined) return `AS${ctx.asn}`;

  return "unknown network";
};

const ansi = (ansiCode: string, text: string): string =>
  "```ansi\n\u001b[" + ansiCode + "m" + text + "\u001b[0m\n```";

const duration = (ms: number): string => {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;

  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
};

const branchMeta = (branch: string): { emoji: string; label: string } =>
  BRANCH_META[branch] ?? { emoji: "⚪", label: branch };

const locationHeader = (ctx: RequestContext): string => {
  const parts: string[] = [];

  if (ctx.city) parts.push(truncate(ctx.city, 60));
  if (ctx.region && ctx.region !== ctx.city) parts.push(truncate(ctx.region, 60));

  const place = parts.length > 0 ? parts.join(", ") : (ctx.country ?? "Unknown location");

  return `${flag(ctx.country)} ${place}`;
};

const sessionHistoryUrl = (sessionId: string): string =>
  `https://glua.dev/?session=${encodeURIComponent(sessionId)}`;

const networkFields = (ctx: RequestContext): DiscordEmbedField[] => [
  { name: "IP",      value: ipLink(ctx.ip), inline: true },
  { name: "Network", value: ispLink(ctx),   inline: true },
];

const capacityLine = (c: CapacitySnapshot, opts?: { skipQueue: boolean }): string =>
  `${c.branch} ${c.branchUsed}/${c.branchMax} · total ${c.totalUsed}/${c.totalMax}${!opts?.skipQueue && c.queueDepth > 0 ? ` · queue ${c.queueDepth}` : ""}`;

const contextSubtext = (ctx: RequestContext | undefined): string | undefined => {
  if (!ctx) return undefined;

  const locationName = ctx.city ?? ctx.country ?? "unknown"
  const location = `${flag(ctx.country)} ${locationName}`
  const ipInfo = `${ipLink(ctx.ip)} · ${ispLink(ctx)}`

  return sub(`${location} · ${ipInfo}`);
};

// Record<CloseReason, ...> is the exhaustiveness guard: adding a new
// CloseReason without a matching key here is a compile error.
const CLOSE_REASON_DISPLAY: Record<CloseReason, { label: string; icon: string; ansiCode: string; color: number }> = {
  clean:                  { label: "clean close",               icon: "●", ansiCode: "2;32", color: COLORS.sessionEnd },
  timer_expired:          { label: "timer expired",             icon: "⌛", ansiCode: "2;33", color: COLORS.warning    },
  agent_shutdown:         { label: "agent shutdown",            icon: "⏻", ansiCode: "2;36", color: COLORS.info       },
  container_stopped:      { label: "container stopped",         icon: "⏹", ansiCode: "2;31", color: COLORS.error      },
  container_error:        { label: "container error",           icon: "✖", ansiCode: "2;31", color: COLORS.error      },
  container_start_failed: { label: "container failed to start", icon: "✖", ansiCode: "2;31", color: COLORS.error      },
  agent_ws_close:         { label: "agent ws closed",           icon: "⚠", ansiCode: "2;33", color: COLORS.warning    },
  agent_ws_error:         { label: "agent ws errored",          icon: "⚠", ansiCode: "2;33", color: COLORS.warning    },
};

export function buildSessionStartedEmbed(e: SessionStartedEvent): DiscordEmbed {
  const { emoji, label } = branchMeta(e.branch);
  const ctx = e.context;

  const lines: string[] = [
    code(truncate(e.sessionId, 100)),
    `### ${locationHeader(ctx)}`,
    sub(`started ${relativeTimestamp()}${ctx.colo ? ` · edge ${code(ctx.colo)}` : ""}`),
  ];
  if (e.capacity) lines.push(sub(capacityLine(e.capacity)));

  const fields: DiscordEmbedField[] = [
    { name: "Branch", value: `${emoji} ${code(label)}`, inline: true },
    ...networkFields(ctx),
  ];

  if (ctx.userAgent) {
    fields.push({
      name: "User-Agent",
      value: "```\n" + truncate(ctx.userAgent, LIMIT_UA_INLINE) + "\n```",
      inline: false,
    });
  }

  return {
    title: "🚀 Session started",
    url: sessionHistoryUrl(e.sessionId),
    description: truncate(lines.join("\n"), LIMIT_DESCRIPTION),
    color: COLORS.sessionStart,
    timestamp: new Date().toISOString(),
    fields,
    footer: FOOTER,
  };
}

export function buildSessionEndedEmbed(e: SessionEndedEvent): DiscordEmbed {
  const { emoji, label } = branchMeta(e.branch);
  const reason = CLOSE_REASON_DISPLAY[e.reason];
  const ctx = e.context;
  const durationMs = e.startedAt !== undefined ? e.endedAt - e.startedAt : undefined;

  const lines: string[] = [
    code(truncate(e.sessionId, 100)),
    `### ${ctx ? locationHeader(ctx) : "🌐 Unknown location"}`,
    sub(`ended ${relativeTimestamp()}${durationMs !== undefined ? ` · ran for **${duration(durationMs)}**` : ""}`),
  ];
  if (e.capacity) lines.push(sub(capacityLine(e.capacity)));

  const fields: DiscordEmbedField[] = [
    { name: "Branch", value: `${emoji} ${code(label)}`, inline: true },
  ];
  if (ctx) fields.push(...networkFields(ctx));

  fields.push(
    { name: "Close reason", value: ansi(reason.ansiCode, `${reason.icon} ${reason.label}`), inline: false },
    { name: "Scripts",   value: code(String(e.scriptCount)),  inline: true },
    { name: "Log lines", value: code(String(e.logLineCount)), inline: true },
    { name: "Extended",  value: e.extensionGranted ? "✅" : "❌", inline: true },
  );

  return {
    title: `🏁 Session ended · ${reason.label}`,
    url: sessionHistoryUrl(e.sessionId),
    description: truncate(lines.join("\n"), LIMIT_DESCRIPTION),
    color: reason.color,
    timestamp: new Date(e.endedAt).toISOString(),
    fields,
    footer: FOOTER,
  };
}

export function buildErrorEmbed(e: ErrorEvent): DiscordEmbed {
  const err = e.error;
  const rawMsg = err instanceof Error ? (err.message || err.name || "Error") : String(err);
  const msg = truncate(rawMsg, LIMIT_ERROR_MESSAGE);
  const stack = err instanceof Error ? err.stack : undefined;

  const lines: string[] = [
    `### ✖ ${truncate(e.where, 120)}`,
    ansi("2;31", msg),
  ];

  if (stack) {
    lines.push("```ts\n" + truncate(stack, LIMIT_STACK) + "\n```");
  }

  const ctxSub = contextSubtext(e.context);
  if (ctxSub) lines.push(ctxSub);

  const fields: DiscordEmbedField[] = [];
  if (e.sessionId) {
    fields.push({ name: "Session", value: code(truncate(e.sessionId, 100)), inline: true });
  }
  if (e.branch) {
    const { emoji, label } = branchMeta(e.branch);
    fields.push({ name: "Branch", value: `${emoji} ${label}`, inline: true });
  }

  return {
    title: "⚠ Error",
    description: truncate(lines.join("\n"), LIMIT_DESCRIPTION),
    color: COLORS.error,
    timestamp: new Date().toISOString(),
    fields: fields.length > 0 ? fields : undefined,
    footer: FOOTER,
  };
}

export function buildQueueEnteredEmbed(e: QueueEnteredEvent): DiscordEmbed {
  const { emoji, label } = branchMeta(e.sessionType);
  const ctx = e.context;

  const lines: string[] = [
    `### ${locationHeader(ctx)}`,
    sub(`position ${code("#" + e.position)} · ${capacityLine(e.capacity, { skipQueue: true })}`),
  ];

  const fields: DiscordEmbedField[] = [
    { name: "Branch", value: `${emoji} ${code(label)}`, inline: true },
    ...networkFields(ctx),
  ];

  return {
    title: "⏳ Queue entered",
    description: truncate(lines.join("\n"), LIMIT_DESCRIPTION),
    color: COLORS.info,
    timestamp: new Date().toISOString(),
    fields,
    footer: FOOTER,
  };
}

export function buildWarningEmbed(e: WarningEvent): DiscordEmbed {
  const lines: string[] = [
    `## ⚠️ ${truncate(e.title, 120)}`,
    truncate(e.description, LIMIT_DESCRIPTION - 200),
  ];
  const ctxSub = contextSubtext(e.context);
  if (ctxSub) lines.push(ctxSub);

  return {
    description: truncate(lines.join("\n\n"), LIMIT_DESCRIPTION),
    color: COLORS.warning,
    timestamp: new Date().toISOString(),
    footer: FOOTER,
  };
}
