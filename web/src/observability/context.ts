import type { RequestContext } from "./types";

export const OBS_CONTEXT_HEADER = "X-Obs-Context";

export function extractRequestContext(request: Request): RequestContext {
  const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const userAgent = request.headers.get("User-Agent") ?? undefined;

  return {
    ip,
    country: cf?.country,
    region: cf?.region,
    city: cf?.city,
    colo: cf?.colo,
    asn: cf?.asn,
    asOrganization: cf?.asOrganization,
    userAgent,
  };
}

// DO stub fetches strip `request.cf`, so we carry the extracted context
// from the worker entrypoint into the DO via this header.
export function serializeContext(ctx: RequestContext): string {
  return encodeURIComponent(JSON.stringify(ctx));
}

export function parseContext(header: string | null | undefined): RequestContext | undefined {
  if (!header) return undefined;
  try {
    return JSON.parse(decodeURIComponent(header)) as RequestContext;
  } catch (e) {
    const name = e instanceof Error ? e.name : typeof e;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[obs] parseContext failed: ${name}: ${msg}`);
    return undefined;
  }
}
