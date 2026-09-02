import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
const factoryScript = inlineScripts.find((script) => script.includes("const root = document.getElementById('beads-event-factory')"));
assert.ok(factoryScript, "factory script was not found");

const initialization = "      void initializeLiveViewer();";
const instrumentedScript = factoryScript.replace(
  initialization,
  `      Object.defineProperty(root, '__stressState', {
        value: () => ({
          beadCount: beads.length,
          clawCount: liveWorkClaws.length,
          beads: beads.map((bead) => ({
            ref: bead,
            id: bead.id,
            status: bead.status,
            x: bead.x,
            y: bead.y,
            dynamic: bead.dynamic,
            held: Boolean(bead.heldBy)
          })),
          claws: liveWorkClaws.map((claw) => ({ ref: claw, beadID: claw.beadID, x: claw.x, y: claw.y }))
        })
      });
${initialization}`,
);
assert.notEqual(instrumentedScript, factoryScript, "stress diagnostics were not installed");

const documentMarkup = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
const window = new Window({
  url: "http://127.0.0.1:4173/?city=stress-city&poll=60000",
  settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true },
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
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

let resizeObserver;
window.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    resizeObserver = this;
  }
  observe() {
    this.callback([]);
  }
};
window.MutationObserver = class {
  observe() {}
  disconnect() {}
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordFor(id, index, cycle) {
  const base = {
    id,
    title: `Stress bead ${id} cycle ${cycle}`,
    issue_type: index % 4 === 0 ? "bug" : index % 4 === 1 ? "feature" : "task",
    priority: index % 5,
    labels: [`group-${index % 7}`, "stress"],
    metadata: { cycle, index },
  };
  switch ((index + cycle) % 6) {
    case 0:
      return { ...base, status: "open" };
    case 1:
      return { ...base, status: "in_progress", assignee: `worker-${index % 12}` };
    case 2:
      return { ...base, status: "open", is_blocked: true };
    case 3:
      return { ...base, status: "open", defer_until: "2099-01-01T00:00:00Z" };
    case 4:
      return { ...base, status: "closed", metadata: { ...base.metadata, "gc.work_outcome": "passed" } };
    default:
      return { ...base, status: "closed", metadata: { ...base.metadata, "gc.work_outcome": "failed" } };
  }
}

function recordsFor(cycle) {
  const omitted = cycle % 120;
  const records = [
    {
      id: "stable-progress",
      title: "Stable in-progress bead",
      status: "in_progress",
      issue_type: "task",
      assignee: "steady-worker",
      labels: ["stress", "stable"],
      metadata: { stable: true },
    },
  ];
  for (let index = 0; index < 120; index += 1) {
    if (index === omitted) continue;
    records.push(recordFor(`stress-${String(index).padStart(3, "0")}`, index, cycle));
  }
  records.push(recordFor(`new-${cycle}`, 120 + cycle, cycle));
  return cycle % 2 ? records.reverse() : records;
}

function isLiveClosed(record) {
  return record.status === "closed";
}

function isInProgress(record) {
  return record.status === "in_progress";
}

let records = recordsFor(0);
let beadFetches = 0;
let failNextBeadFetch = false;

window.fetch = async (input) => {
  const url = new URL(String(input), window.location.href);
  if (url.pathname === "/api/config") return response({ defaultCity: "stress-city" });
  if (url.pathname === "/api/cities") return response({ items: [{ name: "stress-city", running: true }], total: 1 });
  if (url.pathname === "/api/beads") {
    beadFetches += 1;
    if (failNextBeadFetch) {
      failNextBeadFetch = false;
      return response({ error: "injected stress failure" }, 503);
    }
    const includeAll = url.searchParams.get("all") === "true";
    const items = includeAll ? records : records.filter((record) => !isLiveClosed(record));
    return response({ items, total: includeAll ? records.length : items.length });
  }
  const match = url.pathname.match(/^\/api\/bead\/([^/]+)(\/deps)?$/);
  if (match) {
    const record = records.find((item) => item.id === decodeURIComponent(match[1]));
    if (!record) return response({ error: "not found" }, 404);
    if (match[2]) return response({ children: [] });
    return response(record);
  }
  return response({ error: "not found" }, 404);
};

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, message, timeout = 3000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  assert.fail(message);
}

function assertState(root, expectedRecords) {
  const state = root.__stressState();
  assert.equal(state.beadCount, expectedRecords.length, "rendered bead count should match the API records");
  assert.equal(new Set(state.beads.map((bead) => bead.id)).size, state.beadCount, "rendered bead IDs must be unique");
  const expectedClaws = expectedRecords.filter(isInProgress).length;
  assert.equal(state.clawCount, expectedClaws, "every in-progress bead should have a claw");
  assert.equal(state.beads.filter((bead) => bead.status === "in_progress" && bead.held).length, expectedClaws);
  state.beads.forEach((bead) => {
    assert.ok(Number.isFinite(bead.x) && Number.isFinite(bead.y), `${bead.id} has invalid coordinates`);
  });
  state.claws.forEach((claw) => {
    assert.ok(Number.isFinite(claw.x) && Number.isFinite(claw.y), `${claw.beadID} has an invalid claw`);
  });
  return state;
}

window.document.write(documentMarkup);
const root = window.document.getElementById("beads-event-factory");
const stage = window.document.getElementById("bef-stage");
const canvas = window.document.getElementById("bef-canvas");
let rect = { x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON() {} };
stage.getBoundingClientRect = () => rect;
canvas.getBoundingClientRect = () => rect;
window.eval(instrumentedScript);

await waitFor(
  () => window.document.getElementById("bef-event-line").textContent.startsWith("Live · stress-city"),
  "initial live load did not complete",
);

const closedToggle = window.document.getElementById("bef-closed");
closedToggle.checked = true;
closedToggle.dispatchEvent(new window.Event("change", { bubbles: true }));
await waitFor(() => root.__stressState().beadCount === records.length, "closed records did not load");

let state = assertState(root, records);
const stableBeadRef = state.beads.find((bead) => bead.id === "stable-progress").ref;
const stableClawRef = state.claws.find((claw) => claw.beadID === "stable-progress").ref;
const refreshButton = window.document.getElementById("bef-refresh");

let previousFetches = beadFetches;
refreshButton.click();
await waitFor(() => beadFetches >= previousFetches + 2 && !refreshButton.disabled, "identity refresh did not complete");
state = assertState(root, records);
assert.equal(state.beads.find((bead) => bead.id === "stable-progress").ref, stableBeadRef, "refresh respawned a stable bead");
assert.equal(state.claws.find((claw) => claw.beadID === "stable-progress").ref, stableClawRef, "refresh respawned a stable claw");

const churnStarted = performance.now();
let maximumClaws = state.clawCount;
for (let cycle = 1; cycle <= 40; cycle += 1) {
  records = recordsFor(cycle);
  previousFetches = beadFetches;
  refreshButton.click();
  await waitFor(() => beadFetches >= previousFetches + 2 && !refreshButton.disabled, `refresh ${cycle} did not complete`);
  state = assertState(root, records);
  maximumClaws = Math.max(maximumClaws, state.clawCount);
}
const churnElapsed = performance.now() - churnStarted;
assert.ok(churnElapsed < 40000, `refresh churn exceeded the one-second polling budget: ${Math.round(churnElapsed)}ms`);

const search = window.document.getElementById("bef-search");
search.value = "stable-progress";
search.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal(root.__stressState().beadCount, 1, "search should isolate one bead");
search.value = "";
search.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal(root.__stressState().beadCount, records.length, "clearing search should restore all beads");

state = root.__stressState();
const target = state.beads.find((bead) => bead.id === "stable-progress");
canvas.dispatchEvent(new window.PointerEvent("pointermove", { clientX: target.x, clientY: target.y, bubbles: true }));
assert.equal(window.document.getElementById("bef-tooltip").hidden, false, "stress bead hover failed");
canvas.dispatchEvent(new window.PointerEvent("click", { clientX: target.x, clientY: target.y, bubbles: true }));
await waitFor(() => !window.document.getElementById("bef-details").hidden, "stress bead click failed");

const countBeforeFailure = root.__stressState().beadCount;
failNextBeadFetch = true;
refreshButton.click();
await waitFor(
  () => window.document.getElementById("bef-event-line").textContent.includes("injected stress failure"),
  "injected API failure was not reported",
);
assert.equal(root.__stressState().beadCount, countBeforeFailure, "API failure should preserve rendered beads");
previousFetches = beadFetches;
refreshButton.click();
await waitFor(() => beadFetches >= previousFetches + 2 && !refreshButton.disabled, "API recovery did not complete");
assertState(root, records);

rect = { ...rect, right: 760, bottom: 440, width: 760, height: 440 };
resizeObserver.callback([]);
assertState(root, records);

console.log(
  `Stress passed: ${records.length} beads, ${maximumClaws} simultaneous claws, 40 churn refreshes averaged ${Math.round(churnElapsed / 40)}ms, failure recovery verified.`,
);
await window.happyDOM.abort();
window.close();
