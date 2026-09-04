import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createJournalReader, createViewerServer, listen, parseArguments } from "../server.mjs";

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function fixture() {
  const seen = [];
  const journalCalls = [];
  const upstream = http.createServer((request, response) => {
    seen.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url === "/v0/cities") response.end(JSON.stringify({ items: [{ name: "demo", running: true }], total: 1 }));
    else if (request.url === "/v0/city/demo/agents?peek=true") response.end(JSON.stringify({ items: [{ name: "worker-1", running: true, state: "working", active_bead: "demo-1" }], total: 1 }));
    else if (request.url.startsWith("/v0/city/demo/beads?")) response.end(JSON.stringify({ items: [{ id: "demo-1", title: "One", status: "open" }], total: 1 }));
    else if (request.url === "/v0/city/demo/bead/demo-1") response.end(JSON.stringify({ id: "demo-1", title: "One", status: "open" }));
    else if (request.url === "/v0/city/demo/bead/demo-1/deps") response.end(JSON.stringify({ children: [] }));
    else { response.statusCode = 404; response.end(JSON.stringify({ error: "missing" })); }
  });
  const upstreamAddress = await listen(upstream, { host: "127.0.0.1", port: 0 });
  const viewer = createViewerServer({
    apiUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    defaultCity: "demo",
    timeoutMs: 1_000,
    journalReader: async (request) => {
      journalCalls.push(request);
      return {
        city: request.city,
        prime: request.prime,
        events: request.prime ? [] : [{ stream: "demo", seq: 3, op: "update", issue_id: "demo-1" }],
        cursors: { demo: 3 },
        reset: false,
        streams: [{ id: "demo", name: "demo", hq: true, enabled: true, cursor: 3 }],
        warnings: [],
      };
    },
  });
  const viewerAddress = await listen(viewer, { host: "127.0.0.1", port: 0 });
  return {
    seen,
    journalCalls,
    upstream,
    viewer,
    baseUrl: `http://127.0.0.1:${viewerAddress.port}`,
  };
}

test("proxies only the supported read endpoints", async (context) => {
  const app = await fixture();
  context.after(async () => { await close(app.viewer); await close(app.upstream); });

  const cities = await fetch(`${app.baseUrl}/api/cities`).then((response) => response.json());
  assert.equal(cities.items[0].name, "demo");

  const beadsResponse = await fetch(`${app.baseUrl}/api/beads?all=true&limit=5`);
  assert.equal(beadsResponse.status, 200);
  assert.equal((await beadsResponse.json()).items[0].id, "demo-1");
  assert.match(app.seen.at(-1), /^\/v0\/city\/demo\/beads\?/);
  assert.match(app.seen.at(-1), /all=true/);
  assert.match(app.seen.at(-1), /limit=5/);

  const agentsResponse = await fetch(`${app.baseUrl}/api/agents?peek=true`);
  assert.equal(agentsResponse.status, 200);
  assert.equal((await agentsResponse.json()).items[0].active_bead, "demo-1");
  assert.equal(app.seen.at(-1), "/v0/city/demo/agents?peek=true");

  const eventsResponse = await fetch(`${app.baseUrl}/api/events?cursor=${encodeURIComponent(JSON.stringify({ demo: 2 }))}`);
  assert.equal(eventsResponse.status, 200);
  assert.equal((await eventsResponse.json()).events[0].seq, 3);
  assert.equal(app.journalCalls[0].cursors.get("demo"), 2);
  const invalidCursor = await fetch(`${app.baseUrl}/api/events?cursor=%5B%5D`);
  assert.equal(invalidCursor.status, 400);

  const detail = await fetch(`${app.baseUrl}/api/bead/demo-1`).then((response) => response.json());
  assert.equal(detail.title, "One");

  const rejected = await fetch(`${app.baseUrl}/api/beads`, { method: "POST" });
  assert.equal(rejected.status, 405);
  assert.match((await rejected.json()).error, /Read-only/);
});

test("serves the application shell", async (context) => {
  const app = await fixture();
  context.after(async () => { await close(app.viewer); await close(app.upstream); });
  const response = await fetch(app.baseUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(await response.text(), /Beads Event Factory/);
});

test("parses command line and environment settings", () => {
  assert.deepEqual(parseArguments(["--city", "demo", "--port", "4180", "--bd", "/tmp/bd"], {}), {
    apiUrl: "http://127.0.0.1:8372",
    beadsBinary: "/tmp/bd",
    defaultCity: "demo",
    gcBinary: "gc",
    host: "127.0.0.1",
    port: 4180,
  });
  assert.throws(() => parseArguments(["--port", "70000"], {}), /Port/);
});

test("reads each initialized store with its own journal cursor", async () => {
  const commands = [];
  const reader = createJournalReader({
    apiUrl: "http://city.test",
    gcBinary: "/bin/gc",
    beadsBinary: "/bin/bd",
    fetchImpl: async () => new Response(JSON.stringify({
      items: [{ name: "demo", path: "/cities/demo", running: true }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    commandRunner: async (command, argumentsList) => {
      commands.push([command, argumentsList]);
      if (command === "/bin/gc") {
        return {
          code: 0,
          stdout: JSON.stringify({
            rigs: [
              { name: "demo", path: "/cities/demo", beads: "initialized", hq: true },
              { name: "widget", path: "/repos/widget", beads: "initialized", hq: false },
            ],
          }),
          stderr: "",
        };
      }
      if (argumentsList.includes("config")) {
        const enabled = argumentsList.includes("/cities/demo");
        return { code: 0, stdout: `${enabled}\n`, stderr: "" };
      }
      if (argumentsList[argumentsList.indexOf("--since") + 1] === "99") {
        return {
          code: 1,
          stdout: `${JSON.stringify({ code: "events_journal_truncated", since: 99, floor: 100, head: 120 })}\n`,
          stderr: "",
        };
      }
      return {
        code: 0,
        stdout: `${JSON.stringify({
          seq: 5,
          ts: "2026-09-03T12:00:00Z",
          op: "update",
          issue_id: "demo-1",
          issue: { id: "demo-1", status: "in_progress" },
        })}\n`,
        stderr: "",
      };
    },
  });

  const result = await reader({ city: "demo", cursors: new Map([["demo", 4], ["widget", 2]]) });
  assert.deepEqual(result.cursors, { demo: 5, widget: 2 });
  assert.equal(result.events[0].stream, "demo");
  assert.equal(result.streams[1].enabled, false);
  const eventCommand = commands.find(([, argumentsList]) => argumentsList.includes("events"));
  assert.ok(eventCommand, "the event journal command was not run");
  assert.deepEqual(eventCommand[1].slice(0, 7), [
    "-C", "/cities/demo", "--readonly", "--json", "events", "tail", "--since",
  ]);
  assert.equal(eventCommand[1][7], "4");

  const prime = await reader({ city: "demo", prime: true });
  assert.deepEqual(prime.events, []);
  assert.equal(prime.cursors.demo, 5, "priming should retain only the current head");

  const truncated = await reader({ city: "demo", cursors: new Map([["demo", 99]]) });
  assert.equal(truncated.reset, true);
  assert.equal(truncated.cursors.demo, 120);
  assert.equal(truncated.streams[0].floor, 100);
});
