import type { DiscordWebhookPayload } from "./embeds";

const WEBHOOK_TIMEOUT_MS = 3000;

export async function post(env: { DISCORD_WEBHOOK_URL?: string }, payload: DiscordWebhookPayload): Promise<void> {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch (e) {
    console.error("[obs] webhook payload JSON.stringify failed:", e);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const resBody = await res.text().catch(() => "<unreadable>");
      console.error(
        `[obs] webhook non-2xx: status=${res.status} statusText=${res.statusText} body=${resBody.slice(0, 300)}`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      console.error(`[obs] webhook timed out after ${WEBHOOK_TIMEOUT_MS}ms`);
    } else {
      const name = e instanceof Error ? e.name : typeof e;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[obs] webhook post failed: ${name}: ${msg}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
