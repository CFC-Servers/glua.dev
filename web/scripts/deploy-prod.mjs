#!/usr/bin/env node
// Warns active sessions that a deploy is incoming, waits, then deploys.
// Usage: npm run deploy-prod

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRACE_SECONDS = 15;
const ALERT_MESSAGE = `\u001b[33m*** glua.dev is deploying an update in ${GRACE_SECONDS}s — your session will briefly disconnect. Start a new one if it doesn't come back. ***\u001b[0m`;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

console.log(`[deploy-prod] broadcasting heads-up to active sessions…`);
try {
  await run("node", [join(__dirname, "prod-alert.mjs"), ALERT_MESSAGE]);
} catch (e) {
  console.warn(`[deploy-prod] alert failed (${e.message}) — continuing anyway`);
}

console.log(`[deploy-prod] waiting ${GRACE_SECONDS}s so users can read the message…`);
await new Promise((r) => setTimeout(r, GRACE_SECONDS * 1000));

console.log(`[deploy-prod] running wrangler deploy`);
await run("npx", ["wrangler", "deploy"]);
