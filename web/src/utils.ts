import { extractRequestContext, OBS_CONTEXT_HEADER, serializeContext } from "./observability";

export async function hashIP(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

/**
 * Copies geo/IP/ASN context into a header so Durable Objects can read it
 * DO stub fetches strip `request.cf`, so this is the only way to get
 * the original request's geo data inside a DO.
 */
export function withObsHeader(request: Request): Request {
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
