import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";

const argumentsList = process.argv.slice(2);
const cityIndex = argumentsList.indexOf("--city");
const urlIndex = argumentsList.indexOf("--url");
const city = cityIndex >= 0 ? argumentsList[cityIndex + 1] : "";
const baseURL = new URL(urlIndex >= 0 ? argumentsList[urlIndex + 1] : "http://127.0.0.1:4173");
if (city) baseURL.searchParams.set("city", city);

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const factoryScript = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .find((script) => script.includes("const root = document.getElementById('beads-event-factory')"));
const documentMarkup = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");

const window = new Window({
  url: baseURL.href,
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
};
window.fetch = (input, init) => fetch(new URL(String(input), baseURL), init);

window.document.write(documentMarkup);
const stage = window.document.getElementById("bef-stage");
const canvas = window.document.getElementById("bef-canvas");
const rect = { x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 500, width: 900, height: 500, toJSON() {} };
stage.getBoundingClientRect = () => rect;
canvas.getBoundingClientRect = () => rect;
window.eval(factoryScript);

const eventLineElement = window.document.getElementById("bef-event-line");
const liveDeadline = Date.now() + 15_000;
while (!eventLineElement.textContent.startsWith("Live · ") && Date.now() < liveDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const eventLine = eventLineElement.textContent;
assert.match(eventLine, /^Live · /, eventLine);
if (city) assert.match(eventLine, new RegExp(`Live · ${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ·`));
assert.match(window.document.getElementById("bef-motion-note").textContent, /^Gravity on · events journal/);

const tooltip = window.document.getElementById("bef-tooltip");
let hit = null;
for (let y = 270; y <= 390 && hit === null; y += 5) {
  for (let x = 80; x <= 320; x += 5) {
    canvas.dispatchEvent(new window.PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
    if (!tooltip.hidden) {
      hit = { x, y };
      break;
    }
  }
}
assert.ok(hit, "No live bead could be hit in the open bin");
const hoveredID = tooltip.querySelector("span")?.textContent?.split(" · ")[0];
assert.ok(hoveredID, "Hover tooltip did not expose a bead ID");

canvas.dispatchEvent(new window.PointerEvent("click", { clientX: hit.x, clientY: hit.y, bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(window.document.getElementById("bef-details").hidden, false);
assert.equal(window.document.getElementById("bef-details-id").textContent, hoveredID);
assert.ok(window.document.getElementById("bef-details-title").textContent);

console.log(`${eventLine}; hover and click verified for ${hoveredID}.`);
await window.happyDOM.abort();
window.close();
