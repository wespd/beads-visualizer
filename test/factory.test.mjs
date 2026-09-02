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

test("enables gravity for loose live beads", () => {
  assert.match(html, /function enableLiveGravity\(beadsToActivate\)/);
  assert.match(html, /bead\.status === 'in_progress'/);
  assert.match(html, /bead\.dynamic = true/);
  assert.match(html, /enableLiveGravity\(gravityBeads\);/);
  assert.match(html, /Gravity on · live city · \$\{livePollLabel\} refresh/);
});

test("gives every in-progress bead its own live claw", () => {
  assert.match(html, /const liveWorkClaws = \[\]/);
  assert.match(html, /function createLiveWorkClaw\(beadID, x, y\)/);
  assert.match(html, /progressRecords\.forEach\(\(record, index\)/);
  assert.match(html, /liveWorkClaws\.push\(claw\)/);
  assert.match(html, /viewMode === 'live' \|\| viewMode === 'showcase'/);
  assert.match(html, /liveWorkClaws\.forEach\(drawClaw\)/);
});

test("animates honest worker activity without changing bead status", () => {
  assert.match(html, /fetchJSON\(`\/api\/agents\?\$\{agentQuery\}`\)/);
  assert.match(html, /agent\.state === 'working' && agent\.active_bead/);
  assert.match(html, /bead\.activityPulse = 1/);
  assert.match(html, /bead\.commentPulse = 1/);
  assert.match(html, /bead\.heldBy\.working = true/);
  assert.match(html, /ACTIVE · \$\{activity\.name\}/);
});

test("jitters new spawns and reconciles rendered beads by ID", () => {
  assert.match(html, /function randomSpawnOffset\(radius\)/);
  assert.match(html, /Math\.random\(\)/);
  assert.match(html, /const previousLiveBeads = new Map/);
  assert.match(html, /const existing = previousLiveBeads\.get\(record\.id\)/);
});

test("supports a bounded fast polling interval", () => {
  assert.match(html, /get\('poll'\)/);
  assert.match(html, /Math\.min\(60000, Math\.max\(500, requestedPollMs\)\)/);
  assert.match(html, /window\.setInterval\(loadLiveBeads, livePollMs\)/);
});

test("offers an explicitly synthetic showcase for every factory category", () => {
  assert.match(html, /id="bef-showcase"/);
  assert.match(html, /function showcaseRecords\(step\)/);
  assert.match(html, /Showcase · synthetic category exercise/);
  assert.match(html, /this is not city data/);
  assert.match(html, /async function animateShowcaseTransition\(nextRecords, nextStep, epoch\)/);
  assert.match(html, /Promise\.all\(changes\.map/);
  assert.match(html, /concurrent claw transfers/);
  assert.match(html, /moveShowcaseBead/);
  assert.doesNotMatch(html, /setInterval\(\(\) => \{\s+showcaseStep/);
  assert.match(html, /allQuery\.set\('limit', '40'\)/);
  assert.match(html, /function countClosed\(\) \{\s+return beads\.filter\(\(bead\) => bead\.visible && bead\.status === 'closed'\)\.length;/);
});
