import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createViewerServer, listen, parseArguments } from "../server.mjs";

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function fixture() {
  const seen = [];
  const upstream = http.createServer((request, response) => {
    seen.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url === "/v0/cities") response.end(JSON.stringify({ items: [{ name: "demo", running: true }], total: 1 }));
    else if (request.url.startsWith("/v0/city/demo/beads?")) response.end(JSON.stringify({ items: [{ id: "demo-1", title: "One", status: "open" }], total: 1 }));
    else if (request.url === "/v0/city/demo/bead/demo-1") response.end(JSON.stringify({ id: "demo-1", title: "One", status: "open" }));
    else if (request.url === "/v0/city/demo/bead/demo-1/deps") response.end(JSON.stringify({ children: [] }));
    else { response.statusCode = 404; response.end(JSON.stringify({ error: "missing" })); }
  });
  const upstreamAddress = await listen(upstream, { host: "127.0.0.1", port: 0 });
  const viewer = createViewerServer({ apiUrl: `http://127.0.0.1:${upstreamAddress.port}`, defaultCity: "demo", timeoutMs: 1_000 });
  const viewerAddress = await listen(viewer, { host: "127.0.0.1", port: 0 });
  return {
    seen,
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
  assert.deepEqual(parseArguments(["--city", "demo", "--port", "4180"], {}), {
    apiUrl: "http://127.0.0.1:8372",
    defaultCity: "demo",
    host: "127.0.0.1",
    port: 4180,
  });
  assert.throws(() => parseArguments(["--port", "70000"], {}), /Port/);
});
