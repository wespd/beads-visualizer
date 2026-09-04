import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultPublicDirectory = path.join(rootDirectory, "public");
const defaultTimeoutMs = 10_000;
const defaultJournalLimit = 250;

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

function parseCursors(value) {
  if (!value) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    const error = new Error("Journal cursor must be a JSON object");
    error.status = 400;
    throw error;
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    const error = new Error("Journal cursor must be a JSON object");
    error.status = 400;
    throw error;
  }
  const cursors = new Map();
  for (const [stream, sequence] of Object.entries(parsed)) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      const error = new Error(`Invalid journal cursor for ${stream}`);
      error.status = 400;
      throw error;
    }
    cursors.set(stream, sequence);
  }
  return cursors;
}

function commandOutput(command, argumentsList, { timeoutMs, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maximumBytes = 8 * 1024 * 1024;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${path.basename(command)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maximumBytes) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maximumBytes) stderr.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (stdoutBytes > maximumBytes || stderrBytes > maximumBytes) {
        reject(new Error(`${path.basename(command)} produced too much output`));
        return;
      }
      resolve({
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function streamJsonLines(command, argumentsList, { timeoutMs, collect = true, runner } = {}) {
  if (runner) {
    return Promise.resolve(runner(command, argumentsList, { timeoutMs })).then((result) => {
      const events = [];
      let head = 0;
      let structuredError = null;
      for (const line of String(result.stdout || "").split(/\r?\n/)) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.code) structuredError = event;
        if (Number.isSafeInteger(event.seq)) head = Math.max(head, event.seq);
        if (collect) events.push(event);
      }
      return { ...result, events, head, structuredError };
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const events = [];
    const stderr = [];
    let stderrBytes = 0;
    let pending = "";
    let head = 0;
    let parseError = null;
    let structuredError = null;
    const consume = (line) => {
      if (!line.trim() || parseError) return;
      try {
        const event = JSON.parse(line);
        if (event.code) structuredError = event;
        if (Number.isSafeInteger(event.seq)) head = Math.max(head, event.seq);
        if (collect) events.push(event);
      } catch (error) {
        parseError = new Error(`Invalid event journal JSON: ${error.message}`);
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${path.basename(command)} events timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      lines.forEach(consume);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 256 * 1024) stderr.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      consume(pending);
      if (parseError) reject(parseError);
      else resolve({
        code: code ?? 1,
        signal,
        stdout: "",
        stderr: Buffer.concat(stderr).toString("utf8"),
        events,
        head,
        structuredError,
      });
    });
  });
}

function commandFailure(result, command) {
  const detail = String(result.stderr || result.stdout || "").trim();
  return new Error(detail || `${path.basename(command)} exited with status ${result.code}`);
}

function truncatedJournal(result) {
  if (result.structuredError?.code === "events_journal_truncated") return result.structuredError;
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.code === "events_journal_truncated") return parsed;
    } catch {
      // A normal human-readable error may surround the structured refusal.
    }
  }
  return null;
}

export function createJournalReader(options = {}) {
  const apiUrl = new URL(options.apiUrl || "http://127.0.0.1:8372");
  const gcBinary = options.gcBinary || process.env.GC_BINARY || "gc";
  const beadsBinary = options.beadsBinary || process.env.BD_BINARY || "bd";
  const timeoutMs = options.timeoutMs || defaultTimeoutMs;
  const fetchImpl = options.fetchImpl || fetch;
  const runner = options.commandRunner;
  const discoveryCache = new Map();
  const enabledCache = new Map();

  async function run(command, argumentsList) {
    const result = runner
      ? await runner(command, argumentsList, { timeoutMs })
      : await commandOutput(command, argumentsList, { timeoutMs });
    if (result.code !== 0) throw commandFailure(result, command);
    return result;
  }

  async function storesFor(city) {
    const cached = discoveryCache.get(city);
    if (cached && cached.expires > Date.now()) return cached.stores;
    const citiesResponse = await fetchImpl(new URL("/v0/cities", apiUrl), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!citiesResponse.ok) throw new Error(`Gas City API returned ${citiesResponse.status} while locating ${city}`);
    const cities = await citiesResponse.json();
    const selected = (cities.items || []).find((candidate) => candidate.name === city);
    if (!selected?.path) throw new Error(`Gas City did not return a path for ${city}`);
    const manifestResult = await run(gcBinary, ["--city", selected.path, "rig", "list", "--json"]);
    const manifest = JSON.parse(manifestResult.stdout);
    const stores = (manifest.rigs || [])
      .filter((rig) => rig.beads === "initialized" && !rig.suspended)
      .map((rig) => ({ id: rig.name, name: rig.name, path: rig.path, hq: rig.hq === true }));
    discoveryCache.set(city, { expires: Date.now() + 30_000, stores });
    return stores;
  }

  async function journalEnabled(store) {
    const cached = enabledCache.get(store.path);
    if (cached && (cached.enabled || cached.expires > Date.now())) return cached.enabled;
    const result = await run(beadsBinary, ["-C", store.path, "--readonly", "config", "get", "events-journal"]);
    const enabled = result.stdout.trim() === "true";
    enabledCache.set(store.path, { enabled, expires: Date.now() + 5_000 });
    return enabled;
  }

  async function readStore(store, since, { prime, limit }) {
    const enabled = await journalEnabled(store);
    if (!enabled) return { store, enabled: false, cursor: since, events: [] };
    const argumentsList = [
      "-C", store.path,
      "--readonly",
      "--json",
      "events", "tail",
      "--since", String(prime ? 0 : since),
    ];
    if (!prime) argumentsList.push("--limit", String(limit));
    const result = await streamJsonLines(beadsBinary, argumentsList, {
      timeoutMs,
      collect: !prime,
      runner,
    });
    if (result.code !== 0) {
      const refusal = truncatedJournal(result);
      if (refusal && Number.isSafeInteger(refusal.head)) {
        return {
          store,
          enabled: true,
          cursor: refusal.head,
          events: [],
          truncated: true,
          floor: refusal.floor,
        };
      }
      throw commandFailure(result, beadsBinary);
    }
    const cursor = result.events.reduce(
      (maximum, event) => Number.isSafeInteger(event.seq) ? Math.max(maximum, event.seq) : maximum,
      Math.max(since, result.head),
    );
    return { store, enabled: true, cursor, events: result.events };
  }

  return async function readJournal({ city, cursors = new Map(), prime = false, limit = defaultJournalLimit }) {
    const stores = await storesFor(city);
    const results = await Promise.all(stores.map(async (store) => {
      const since = cursors.get(store.id) || 0;
      try {
        return await readStore(store, since, { prime, limit });
      } catch (error) {
        return { store, enabled: null, cursor: since, events: [], error: error.message };
      }
    }));
    const nextCursors = Object.fromEntries(results.map((result) => [result.store.id, result.cursor]));
    const events = results.flatMap((result) => result.events.map((event) => ({
      ...event,
      stream: result.store.id,
    })));
    events.sort((left, right) => {
      const timestampOrder = String(left.ts || "").localeCompare(String(right.ts || ""));
      if (timestampOrder) return timestampOrder;
      const streamOrder = String(left.stream).localeCompare(String(right.stream));
      return streamOrder || (left.seq || 0) - (right.seq || 0);
    });
    return {
      city,
      prime,
      events,
      cursors: nextCursors,
      reset: results.some((result) => result.truncated),
      streams: results.map((result) => ({
        id: result.store.id,
        name: result.store.name,
        hq: result.store.hq,
        enabled: result.enabled,
        cursor: result.cursor,
        ...(result.floor === undefined ? {} : { floor: result.floor }),
        ...(result.error ? { error: result.error } : {}),
      })),
      warnings: results.filter((result) => result.error).map((result) => `${result.store.name}: ${result.error}`),
    };
  };
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
  const journalReader = options.journalReader || createJournalReader({ ...options, apiUrl, timeoutMs });

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

    if (url.pathname === "/api/events") {
      try {
        const city = requiredCity(url, defaultCity);
        const cursors = parseCursors(url.searchParams.get("cursor"));
        const prime = url.searchParams.get("prime") === "true";
        const requestedLimit = Number(url.searchParams.get("limit") || defaultJournalLimit);
        const limit = Number.isSafeInteger(requestedLimit)
          ? Math.max(1, Math.min(500, requestedLimit))
          : defaultJournalLimit;
        sendJson(response, 200, await journalReader({ city, cursors, prime, limit }));
      } catch (error) {
        sendJson(response, error.status || 502, { error: error.message });
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
    beadsBinary: environment.BD_BINARY || "bd",
    defaultCity: environment.GC_CITY_NAME || "",
    gcBinary: environment.GC_BINARY || "gc",
    host: environment.HOST || "127.0.0.1",
    port: Number(environment.PORT || 4173),
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--api") settings.apiUrl = argumentsList[++index];
    else if (argument === "--bd") settings.beadsBinary = argumentsList[++index];
    else if (argument === "--city") settings.defaultCity = argumentsList[++index];
    else if (argument === "--gc") settings.gcBinary = argumentsList[++index];
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
    console.log(`Usage: npm start -- [options]\n\nOptions:\n  --api <url>    Gas City supervisor API (default http://127.0.0.1:8372)\n  --bd <path>    Beads binary with events journal support (default: bd)\n  --city <name>  Default city to display\n  --gc <path>    Gas City binary (default: gc)\n  --host <host>  Viewer bind host (default 127.0.0.1)\n  --port <port>  Viewer port (default 4173)`);
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
