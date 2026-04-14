export { SessionManager } from "./queue/manager";
export { GmodDev, GmodPrerelease, GmodPublic, GmodSixtyFour } from "./session/branches";

import type { Env } from "./env";
import { withObsHeader } from "./utils";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const forwarded = withObsHeader(request);

    if (url.pathname.startsWith("/api/")) {
      const manager = env.SESSION_MANAGER.get(env.SESSION_MANAGER.idFromName("global-queue"));
      return manager.fetch(forwarded);
    }

    if (url.pathname.startsWith("/ws/")) {
      const sessionId = url.searchParams.get("session");
      const branch = url.searchParams.get("type") || "public";
      if (!sessionId) {
        return new Response("Missing 'session' param for WebSocket", { status: 400 });
      }

      let sessionBinding: DurableObjectNamespace;
      switch (branch) {
        case "sixty-four":
          sessionBinding = env.GMOD_SIXTYFOUR;
          break;
        case "prerelease":
          sessionBinding = env.GMOD_PRERELEASE;
          break;
        case "dev":
          sessionBinding = env.GMOD_DEV;
          break;
        default:
          sessionBinding = env.GMOD_PUBLIC;
      }

      const stub = sessionBinding.get(sessionBinding.idFromName(sessionId));
      return stub.fetch(forwarded);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
