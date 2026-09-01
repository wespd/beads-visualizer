import test from "node:test";
import assert from "node:assert/strict";
import { countsByLane, dependencyTarget, laneForBead, layoutBeads, shortId, tooltipLines } from "../public/model.js";

const now = new Date("2026-09-01T20:00:00Z");

test("classifies active, blocked, deferred, progress, and closed beads", () => {
  assert.equal(laneForBead({ status: "open" }, now), "ready");
  assert.equal(laneForBead({ status: "open", is_blocked: true }, now), "blocked");
  assert.equal(laneForBead({ status: "in_progress", is_blocked: true }, now), "progress");
  assert.equal(laneForBead({ status: "open", defer_until: "2026-09-02T00:00:00Z" }, now), "deferred");
  assert.equal(laneForBead({ status: "closed" }, now), "closed");
});

test("lays out each bead once in its status lane", () => {
  const beads = [
    { id: "bd-a", status: "open" },
    { id: "bd-b", status: "in_progress" },
    { id: "bd-c", status: "closed" },
  ];
  const first = layoutBeads(beads, now);
  const second = layoutBeads(beads, now);
  assert.deepEqual(first, second);
  assert.equal(first.length, beads.length);
  assert.deepEqual(new Set(first.map((position) => position.bead.id)), new Set(beads.map((bead) => bead.id)));
  for (const position of first) {
    assert.ok(position.x > 0 && position.x < 100);
    assert.ok(position.y > 0 && position.y < 100);
  }
});

test("summaries expose useful hover fields", () => {
  const bead = { id: "gcdr-123", title: "Test viewer", status: "open", issue_type: "task", priority: 1, assignee: "codex" };
  assert.deepEqual(tooltipLines(bead), ["gcdr-123 · task · P1", "Test viewer", "open · codex"]);
  assert.equal(shortId("gcdr-something-long-123"), "123");
  assert.equal(dependencyTarget({ depends_on_id: "gcdr-2" }), "gcdr-2");
  assert.equal(countsByLane([bead], now).ready, 1);
});
