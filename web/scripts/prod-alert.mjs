#!/usr/bin/env node
// Sends a message that the worker will broadcast to every active session.
// Usage: npm run prod-alert -- "Your message (ANSI escapes allowed)"

const message = process.argv.slice(2).join(" ");
if (!message) {
  console.error("Usage: npm run prod-alert -- \"message to broadcast\"");
  process.exit(1);
}

const token = process.env.GLUA_BROADCAST_TOKEN;
const base = process.env.GLUA_PROD_URL ?? "https://glua.dev";
if (!token) {
  console.error("GLUA_BROADCAST_TOKEN is not set — add it to web/.env");
  process.exit(1);
}

const res = await fetch(`${base}/api/broadcast`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ message }),
});

if (!res.ok) {
  console.error(`Broadcast failed: ${res.status} ${res.statusText}`);
  console.error(await res.text());
  process.exit(1);
}

const result = await res.json();
console.log(`Broadcast delivered to ${result.delivered}/${result.sessions} active sessions`);
