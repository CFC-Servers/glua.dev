import { Container } from "@cloudflare/containers";

// Define the interface for environment variables and bindings from wrangler.toml
export interface Env {
  GmodPublic: any;
  GmodSixtyFour: any;
  GmodPrerelease: any;
  GmodDev: any;
  LOG_BUCKET: R2Bucket;
}

export class BaseRunner extends Container {
  defaultPort = 8080;
  sleepAfter = "3m";
}
export class GmodPublic extends BaseRunner {}
export class GmodSixtyFour extends BaseRunner {}
export class GmodPrerelease extends BaseRunner {}
export class GmodDev extends BaseRunner {}

const getContainer = (env: Env, sessionId: string): BaseRunner => {
  console.log(`Fetching container for session ID: ${sessionId}`);
  const id = env.GmodPublic.idFromName(sessionId)
  console.log(`Container ID: ${id}`);
  const container = env.GmodPublic.get(id)
  console.log(`Container fetched: ${container}`);

  if (!container) {
    throw new Error(`Container with session ID ${sessionId} not found.`)
  }

  return container
}

const createRequest = (endpoint: string, method: string = "GET", body?: string): Request => {
  return new Request(`http://localhost:8080/cgi-bin/${endpoint}`, { method, body });
}

/**
 * Request router
 * @param request The incoming request
 * @param env The environment bindings
 * @returns A response promise
 */
const handleApiRequest = async (request: Request, env: Env): Promise<Response> => {
  const { pathname } = new URL(request.url);

  try {
    if (pathname === "/api/start" && request.method === "POST") {
      return await handleStartSession();
    }
    if (pathname === "/api/logs" && request.method === "GET") {
      return await handleGetLogs(request, env);
    }
    if (pathname === "/api/history" && request.method === "GET") {
      return await handleGetHistory(request, env);
    }
    if (pathname === "/api/command" && request.method === "POST") {
      return await handleSendCommand(request, env);
    }
    if (pathname === "/api/health" && request.method === "GET") {
      return await handleHealthCheck(request, env);
    }

    return new Response("Not Found", { status: 404 });
  } catch (error) {
    console.error("API Error:", error);
    const errorResponse = { error: "An internal server error occurred." };

    return new Response(JSON.stringify(errorResponse), { 
      status: 500, 
      headers: { "Content-Type": "application/json" }
    });
  }
};

/**
 * Creates a new session ID. The container itself is spun up lazily
 * by Cloudflare on the first request that uses this ID.
 */
const handleStartSession = async (): Promise<Response> => {
  const sessionId = crypto.randomUUID();
  return new Response(JSON.stringify({ sessionId }), {
    headers: { "Content-Type": "application/json" },
  });
};

/**
 * Fetches the latest logs from a container, appends them to R2 storage,
 * and returns only the new logs to the client
 */
const handleGetLogs = async (request: Request, env: Env): Promise<Response> => {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("session");

  if (!sessionId) {
    return new Response("Session is required", { status: 400 })
  }

  const containerInstance = getContainer(env, sessionId)
  const containerRequest = createRequest("get-output", "GET")
  const containerResponse = await containerInstance.fetch(containerRequest)

  if (!containerResponse.ok) {
    return new Response(`Failed to fetch logs from container (status: ${containerResponse.status}).`, { status: 502 })
  }
  const newLogs = await containerResponse.text()

  if (newLogs) {
    const logKey = `logs/${sessionId}.log`
    const existingLogObject = await env.LOG_BUCKET.get(logKey)

    let newBody = newLogs
    if (existingLogObject) {
      const existingLogs = await existingLogObject.text()
      newBody = existingLogs + "\n" + newLogs
    }

    await env.LOG_BUCKET.put(logKey, newBody)
  }

  return new Response(newLogs, { headers: { "Content-Type": "text/plain" } })
};

/**
 * Retrieves the entire log history for a session from R2
 */
const handleGetHistory = async (request: Request, env: Env): Promise<Response> => {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("session");

  if (!sessionId) {
    return new Response("Session is required", { status: 400 });
  }

  const logKey = `logs/${sessionId}.log`;
  const logObject = await env.LOG_BUCKET.get(logKey);

  if (!logObject) {
    return new Response("", { status: 200 }); // No history exists yet.
  }

  return new Response(logObject.body, { headers: { "Content-Type": "text/plain" } });
};

/**
 * Forwards a command from the client to the specified container
 */
const handleSendCommand = async (request: Request, env: Env): Promise<Response> => {
  const { searchParams } = new URL(request.url)
  const sessionId = searchParams.get("session")

  if (!sessionId) {
    return new Response("Session is required", { status: 400 })
  }

  const command = await request.text();
  if (!command) {
    return new Response("Request body with command is required.", { status: 400 })
  }

  const container = getContainer(env, sessionId)
  const containerRequest = createRequest("command", "POST", command)

  const containerResponse = await container.fetch(containerRequest)
  return new Response(null, { status: containerResponse.status })
};

const handleHealthCheck = async (request: Request, env: Env): Promise<Response> => {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("session");

  if (!sessionId) {
    return new Response("Session is required", { status: 400 });
  }

  const container = getContainer(env, sessionId);
  const containerRequest = createRequest("healthcheck.sh");

  const containerResponse = await container.fetch(containerRequest);
  return new Response(null, { status: containerResponse.status });
}

// The main fetch handler for the Worker
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};


