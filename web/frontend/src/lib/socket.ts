import type { ServerMessage } from "@glua/shared";
import type { VirtualConsole } from "./virtual-console";
import { sessionState, sessionTimer, sessionMetadata, scriptMap } from "./stores";
import { writable } from "svelte/store";
import { createEma } from "./smoothing";

export const healthData = writable<{ cpuUsage: number; diskUsage: number }>({ cpuUsage: 0, diskUsage: 0 });

const smoothCpu = createEma(0.3);

/**
 * Wires up a single message handler on the socket that parses once
 * and dispatches to the right store or console method.
 */
export function attachMessageHandler(socket: WebSocket, virtualConsole: VirtualConsole) {
  socket.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data) as ServerMessage;
      switch (msg.type) {
        case "HISTORY":
          virtualConsole.addLines(msg.payload.split("\n"));
          break;
        case "LOGS":
          virtualConsole.addLines(msg.payload);
          break;
        case "HEALTH":
          healthData.set({
            cpuUsage: smoothCpu(msg.payload.cpuusage ?? 0),
            diskUsage: msg.payload.diskusage ?? 0,
          });
          break;
        case "SESSION_TIMER":
          sessionState.set("active");
          sessionTimer.set(msg.payload);
          break;
        case "SESSION_CLOSED":
          sessionState.set("closed");
          break;
        case "CONTEXT_UPDATE":
          sessionMetadata.set(msg.payload);
          break;
        case "SCRIPT_EXECUTED":
          scriptMap.update((m) => ({ ...m, [msg.payload.name]: { content: msg.payload.content, logLine: msg.payload.logLine } }));
          virtualConsole.addScriptLink(msg.payload.name);
          break;
        case "SCRIPT_HISTORY":
          scriptMap.update((m) => ({ ...m, ...msg.payload }));
          break;
      }
    } catch (e) {
      console.error("Failed to process WebSocket message:", e);
    }
  });
}
