import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultPublicDirectory = path.join(rootDirectory, "public");
const defaultTimeoutMs = 10_000;

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function encodeSegment(value) {
  return encodeURIComponent(String(value).trim());
}

function requiredCity(url, defaultCity) {
  const city = url.searchParams.get("city")?.trim() || defaultCity;
  if (!city) {
    const error = new Error("A city is required. Select one or start with --city <name>.");
    error.status = 400;
    throw error;
  }
  return city;
}

function copyAllowedParameters(source, destination, names) {
  for (const name of names) {
    const value = source.get(name);
    if (value !== null && value !== "") destination.set(name, value);
  }
}

async function proxyUpstream(response, upstreamUrl, timeoutMs) {
  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      "cache-control": "no-store",
      "content-length": body.length,
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  } catch (error) {
    sendJson(response, 502, {
      error: "Gas City API is unavailable",
      detail: error instanceof Error ? error.message : String(error),
      upstream: upstreamUrl.origin,
    });
  }
}

async function serveStatic(request, response, publicDirectory, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(requestedPath);
  } catch {
    sendJson(response, 400, { error: "Invalid URL encoding" });
    return;
  }

  const resolved = path.resolve(publicDirectory, `.${decoded}`);
  const publicRoot = `${path.resolve(publicDirectory)}${path.sep}`;
  if (!resolved.startsWith(publicRoot)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(resolved);
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-length": body.length,
      "content-type": contentTypes.get(path.extname(resolved)) || "application/octet-stream",
      "x-content-type-options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

export function createViewerServer(options = {}) {
  const apiUrl = new URL(options.apiUrl || "http://127.0.0.1:8372");
  const defaultCity = options.defaultCity || "";
  const publicDirectory = options.publicDirectory || defaultPublicDirectory;
  const timeoutMs = options.timeoutMs || defaultTimeoutMs;

  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://viewer.local");

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Read-only viewer: method not allowed" });
      return;
    }

    if (url.pathname === "/api/config") {
      sendJson(response, 200, { defaultCity, upstream: apiUrl.origin });
      return;
    }

    if (url.pathname === "/api/cities") {
      await proxyUpstream(response, new URL("/v0/cities", apiUrl), timeoutMs);
      return;
    }

    if (url.pathname === "/api/agents") {
      try {
        const city = requiredCity(url, defaultCity);
        const upstream = new URL(`/v0/city/${encodeSegment(city)}/agents`, apiUrl);
        copyAllowedParameters(url.searchParams, upstream.searchParams, ["peek", "pool", "rig", "running"]);
        await proxyUpstream(response, upstream, timeoutMs);
      } catch (error) {
        sendJson(response, error.status || 500, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/beads") {
      try {
        const city = requiredCity(url, defaultCity);
        const upstream = new URL(`/v0/city/${encodeSegment(city)}/beads`, apiUrl);
        copyAllowedParameters(url.searchParams, upstream.searchParams, [
          "all",
          "assignee",
          "cursor",
          "label",
          "limit",
          "rig",
          "status",
          "type",
        ]);
        await proxyUpstream(response, upstream, timeoutMs);
      } catch (error) {
        sendJson(response, error.status || 500, { error: error.message });
      }
      return;
    }

    const detailMatch = url.pathname.match(/^\/api\/bead\/([^/]+)(?:\/(deps|graph))?$/);
    if (detailMatch) {
      try {
        const city = requiredCity(url, defaultCity);
        const beadId = encodeSegment(decodeURIComponent(detailMatch[1]));
        const view = detailMatch[2];
        const upstreamPath =
          view === "graph"
            ? `/v0/city/${encodeSegment(city)}/beads/graph/${beadId}`
            : `/v0/city/${encodeSegment(city)}/bead/${beadId}${view === "deps" ? "/deps" : ""}`;
        await proxyUpstream(response, new URL(upstreamPath, apiUrl), timeoutMs);
      } catch (error) {
        sendJson(response, error.status || 400, { error: error.message });
      }
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "Unknown read endpoint" });
      return;
    }

    await serveStatic(request, response, publicDirectory, url.pathname);
  });
}

export function parseArguments(argumentsList, environment = process.env) {
  const settings = {
    apiUrl: environment.GC_API_URL || "http://127.0.0.1:8372",
    defaultCity: environment.GC_CITY_NAME || "",
    host: environment.HOST || "127.0.0.1",
    port: Number(environment.PORT || 4173),
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--api") settings.apiUrl = argumentsList[++index];
    else if (argument === "--city") settings.defaultCity = argumentsList[++index];
    else if (argument === "--host") settings.host = argumentsList[++index];
    else if (argument === "--port") settings.port = Number(argumentsList[++index]);
    else if (argument === "--help" || argument === "-h") settings.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (!Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65_535) {
    throw new Error("Port must be an integer from 0 to 65535");
  }
  new URL(settings.apiUrl);
  return settings;
}

export async function listen(server, { host, port }) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server.address();
}

async function main() {
  let settings;
  try {
    settings = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (settings.help) {
    console.log(`Usage: npm start -- [options]\n\nOptions:\n  --api <url>    Gas City supervisor API (default http://127.0.0.1:8372)\n  --city <name>  Default city to display\n  --host <host>  Viewer bind host (default 127.0.0.1)\n  --port <port>  Viewer port (default 4173)`);
    return;
  }

  const server = createViewerServer(settings);
  const address = await listen(server, settings);
  const printableHost = address.address === "::" ? "localhost" : address.address;
  console.log(`Beads Visualizer: http://${printableHost}:${address.port}`);
  console.log(`Gas City API: ${settings.apiUrl}${settings.defaultCity ? ` (city: ${settings.defaultCity})` : ""}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
