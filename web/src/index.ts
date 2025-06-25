import { getContainer, Container } from "@cloudflare/containers";

// Define the interface for environment variables and bindings from wrangler.toml
export interface Env {
  GMOD_PUBLIC: Container;
  GMOD_SIXTYFOUR: Container;
  GMOD_PRERELEASE: Container;
  GMOD_DEV: Container;
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

const verifySessionId = (sessionId: string | null): void => {
  if (!sessionId || sessionId.length !== 36) {
    throw new Error("Invalid session ID. It must be a valid UUID.");
  }
}

const verifyBranch = (branch: string | null): void => {
  const validBranches = ["public", "sixty-four", "prerelease", "dev"];
  if (!branch || !validBranches.includes(branch)) {
    throw new Error(`Invalid branch type. Must be one of: ${validBranches.join(", ")}`);
  }
}

const findContainer = (env: Env, sessionId: string, branch: string): DurableObjectStub<Container> => {
  let containerType: any;
  switch (branch) {
    case "public":
      containerType = env.GMOD_PUBLIC
      break;
    case "sixty-four":
      containerType = env.GMOD_SIXTYFOUR
      break;
    case "prerelease":
      containerType = env.GMOD_PRERELEASE
      break;
    case "dev":
      containerType = env.GMOD_DEV
      break;
    default:
      containerType = env.GMOD_PUBLIC;
  }

  console.log(`Fetching container for session ID: ${sessionId}, branch: ${branch}`);
  const container = getContainer(containerType, sessionId);
  console.log(`Container fetched: ${container}`);

  if (!container) {
    throw new Error(`Container with session ID ${sessionId} not found.`)
  }

  return container
}

const createRequest = (endpoint: string, method: string = "GET", body?: string): Request => {
  const url = `http://127.0.0.1:8080/cgi-bin/${endpoint}`;
  console.log(`Creating request for endpoint: ${url}, method: ${method}, body: ${body}`);
  return new Request(url, { method, body });
}

/**
 * Request router
 * @param request The incoming request
 * @param env The environment bindings
 * @returns A response promise
 */
const handleApiRequest = async (request: Request, env: Env): Promise<Response> => {
  const { pathname } = new URL(request.url);

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("session");
  const branch = searchParams.get("type");


  try {
    if (pathname === "/api/start" && request.method === "POST") {
      return await handleStartSession(env, branch);
    }
    if (pathname === "/api/logs" && request.method === "GET") {
      verifyBranch(branch);
      verifySessionId(sessionId);
      return await handleGetLogs(env, sessionId!, branch!);
    }
    if (pathname === "/api/history" && request.method === "GET") {
      verifySessionId(sessionId);
      return await handleGetHistory(env, sessionId!);
    }
    if (pathname === "/api/command" && request.method === "POST") {
      verifyBranch(branch);
      verifySessionId(sessionId);
      return await handleSendCommand(request, env, sessionId!, branch!);
    }
    if (pathname === "/api/health" && request.method === "GET") {
      console.log("Health check endpoint hit");
      verifyBranch(branch);
      verifySessionId(sessionId);
      return await handleHealthCheck(env, sessionId!, branch!);
    }

    return new Response("Not Found", { status: 404 });
  } catch (error) {
    console.error("API Error:", error);
    const errorResponse = { error: "An internal server error occurred.", details: error instanceof Error ? error.message : "Unknown error" };

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
const handleStartSession = async (env: Env, branch: string | null): Promise<Response> => {
  if (!branch) {
    return new Response("Branch type is required", { status: 400 });
  }

  const sessionId = crypto.randomUUID();
  findContainer(env, sessionId, branch);

  return new Response(JSON.stringify({ sessionId }), {
    headers: { "Content-Type": "application/json" },
  });
};

/**
 * Fetches the latest logs from a container, appends them to R2 storage,
 * and returns only the new logs to the client
 */
const handleGetLogs = async (env: Env, sessionId: string, branch: string): Promise<Response> => {
  const containerInstance = findContainer(env, sessionId, branch)
  const containerRequest = createRequest("get-output.sh", "GET")
  const containerResponse = await containerInstance.containerFetch(containerRequest)

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
const handleGetHistory = async (env: Env, sessionId: string): Promise<Response> => {
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
const handleSendCommand = async (request: Request, env: Env, sessionId: string, branch: string): Promise<Response> => {
  const command = await request.text();
  if (!command) {
    return new Response("Request body with command is required.", { status: 400 })
  }

  const container = findContainer(env, sessionId, branch);
  const containerRequest = createRequest("send-command.sh", "POST", command)

  const containerResponse = await container.containerFetch(containerRequest)
  return new Response(null, { status: containerResponse.status })
};

const handleHealthCheck = async (env: Env, sessionId: string, branch: string): Promise<Response> => {
  const container = findContainer(env, sessionId, branch);
  const containerRequest = createRequest("healthcheck.sh");

  const containerResponse = await container.containerFetch(containerRequest);
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


