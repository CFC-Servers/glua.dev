import { extractRequestContext, OBS_CONTEXT_HEADER, serializeContext } from "./observability";

export async function hashIP(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

/**
 * Reassembles a session's full log history from R2
 *
 * Logs are stored as timestamped chunk objects under `logs/` (one per flush), plus a legacy single `logs.log` object from sessions written before chunking
 * Chunk keys are millisecond epochs, so lexicographic list order is chronological
 */
export async function readSessionLogs(bucket: R2Bucket, sessionId: string): Promise<string> {
  const parts: string[] = [];

  const legacy = await bucket.get(`sessions/${sessionId}/logs.log`);
  if (legacy) parts.push(await legacy.text());

  const chunkKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `sessions/${sessionId}/logs/`, cursor });
    chunkKeys.push(...page.objects.map((obj) => obj.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  for (const key of chunkKeys) {
    const chunk = await bucket.get(key);
    if (chunk) parts.push(await chunk.text());
  }

  return parts.join("");
}

/**
 * Copies geo/IP/ASN context into a header so Durable Objects can read it
 * DO stub fetches strip `request.cf`, so this is the only way to get the original request's geo data inside a DO
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
