import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
const factoryScript = inlineScripts.find((script) => script.includes("const root = document.getElementById('beads-event-factory')"));
const documentMarkup = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");

function response(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("live factory bead supports hover summary and click details", async () => {
  assert.ok(factoryScript, "factory script was not found");
  const window = new Window({
    url: "http://127.0.0.1:4173/?city=demo",
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  });

  const drawingContext = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "createLinearGradient") return () => ({ addColorStop() {} });
        return () => {};
      },
      set() {
        return true;
      },
    },
  );
  window.HTMLCanvasElement.prototype.getContext = () => drawingContext;
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      this.callback([]);
    }
  };
  window.MutationObserver = class {
    observe() {}
    disconnect() {}
  };

  const record = {
    id: "demo-1",
    title: "Inspect the existing factory",
    status: "open",
    issue_type: "task",
    priority: 1,
    assignee: "codex",
    created_at: "2026-09-01T22:00:00Z",
    description: "This is live city data.",
    labels: ["viewer"],
    metadata: { source: "test" },
  };

  window.fetch = async (input) => {
    const url = new URL(String(input), window.location.href);
    if (url.pathname === "/api/config") return response({ defaultCity: "demo" });
    if (url.pathname === "/api/cities") return response({ items: [{ name: "demo", running: true }], total: 1 });
    if (url.pathname === "/api/beads") return response({ items: [record], total: 1 });
    if (url.pathname === "/api/bead/demo-1/deps") return response({ children: [] });
    if (url.pathname === "/api/bead/demo-1") return response(record);
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  window.document.write(documentMarkup);
  const stage = window.document.getElementById("bef-stage");
  const canvas = window.document.getElementById("bef-canvas");
  const rect = { x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 500, width: 900, height: 500, toJSON() {} };
  stage.getBoundingClientRect = () => rect;
  canvas.getBoundingClientRect = () => rect;
  window.eval(factoryScript);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.match(window.document.getElementById("bef-event-line").textContent, /Live · demo · 1 shown of 1/);

  canvas.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 196, clientY: 338, bubbles: true }));
  const tooltip = window.document.getElementById("bef-tooltip");
  assert.equal(tooltip.hidden, false);
  assert.match(tooltip.textContent, /demo-1/);
  assert.match(tooltip.textContent, /Inspect the existing factory/);

  canvas.dispatchEvent(new window.PointerEvent("click", { clientX: 196, clientY: 338, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const details = window.document.getElementById("bef-details");
  assert.equal(details.hidden, false);
  assert.equal(window.document.getElementById("bef-details-title").textContent, record.title);
  assert.match(window.document.getElementById("bef-details-body").textContent, /This is live city data/);
  assert.match(window.document.getElementById("bef-details-body").textContent, /source/);

  await new Promise((resolve) => setTimeout(resolve, 650));
  canvas.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 196, clientY: 338, bubbles: true }));
  assert.equal(tooltip.hidden, true, "gravity should move the bead away from its initial position");
  canvas.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 196, clientY: 384, bubbles: true }));
  assert.equal(tooltip.hidden, false, "the bead should settle at the bottom of the open bin");

  canvas.dispatchEvent(new window.PointerEvent("pointerleave", { bubbles: true }));
  window.document.getElementById("bef-refresh").click();
  await new Promise((resolve) => setTimeout(resolve, 40));
  canvas.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 196, clientY: 384, bubbles: true }));
  assert.equal(tooltip.hidden, false, "refresh should preserve an already-rendered bead's position");

  window.document.getElementById("bef-mode").click();
  const nextEvent = window.document.getElementById("bef-next-event");
  assert.equal(nextEvent.hidden, false);
  assert.equal(window.document.getElementById("bef-toolbar").hidden, true);
  assert.match(window.document.getElementById("bef-event-line").textContent, /Journal ready/);
  nextEvent.click();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.match(window.document.getElementById("bef-event-line").textContent, /Event 1 of 12 — create/);

  await window.happyDOM.abort();
  window.close();
});
