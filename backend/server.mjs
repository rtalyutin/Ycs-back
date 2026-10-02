import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { startResultsWorker } from "./dota-results-worker.mjs";

// The frontend reads the public S3 object directly. This service has no public
// import trigger, site assets, write API, or credentials in HTTP responses.
export function createResultsServer() {
  return createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("x-content-type-options", "nosniff");
    let url;
    try { url = new URL(request.url, "http://localhost"); }
    catch { response.writeHead(400); response.end('{"error":"bad_request"}'); return; }
    if (url.pathname !== "/healthz") {
      response.writeHead(404);
      response.end(request.method === "HEAD" ? undefined : '{"error":"not_found"}');
    } else if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end('{"error":"method_not_allowed"}');
    } else {
      response.writeHead(200);
      response.end(request.method === "HEAD" ? undefined : '{"status":"ok"}');
    }
  });
}

export async function startResultsBackend({ env = process.env,
  port = Number(env.PORT || 8080), host = "0.0.0.0", logger = console,
  workerOptions = {} } = {}) {
  const server = createResultsServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const worker = startResultsWorker({ ...workerOptions, env, logger });
  logger.log(`YCS results backend listening on ${host}:${server.address().port}; importer ${worker.state.status}`);
  return { server, worker, async stop() {
    await Promise.all([worker.stop(), new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))]);
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startResultsBackend().then((backend) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      backend.stop().catch((error) => { console.error(error.message); process.exitCode = 1; });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
