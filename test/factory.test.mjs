import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("preserves the pre-existing Beads Event Factory", () => {
  assert.match(html, /<h2>Beads event factory<\/h2>/);
  assert.match(html, /id="bef-canvas"/);
  assert.match(html, /Animated Beads factory with a blocked funnel/);
  assert.match(html, /const events = \[/);
  assert.match(html, /dep_add.*gains a blocking dependency/);
  assert.match(html, /DEFERRED \/ FAILED CLOSE/);
  assert.doesNotMatch(html, /The bead floor|lane-grid/);
});

test("extends the factory with live data and bead inspection", () => {
  assert.match(html, /async function loadLiveBeads/);
  assert.match(html, /function applyLiveRecords/);
  assert.match(html, /canvas\.addEventListener\('pointermove'/);
  assert.match(html, /canvas\.addEventListener\('click'/);
  assert.match(html, /async function selectBead/);
  assert.match(html, /id="bef-details"/);
});
