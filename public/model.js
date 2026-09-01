export const lanes = [
  { id: "ready", label: "Ready", description: "Open and actionable" },
  { id: "progress", label: "In progress", description: "Claimed work" },
  { id: "blocked", label: "Blocked", description: "Waiting on dependencies" },
  { id: "deferred", label: "Deferred", description: "Scheduled for later" },
  { id: "closed", label: "Closed", description: "Completed or stopped" },
];

export function laneForBead(bead, now = new Date()) {
  if (bead.status === "closed") return "closed";
  if (bead.defer_until && new Date(bead.defer_until) > now) return "deferred";
  if (bead.status === "in_progress") return "progress";
  if (bead.is_blocked === true) return "blocked";
  return "ready";
}

export function hashString(value) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function layoutBeads(beads, now = new Date()) {
  const groups = new Map(lanes.map((lane) => [lane.id, []]));
  for (const bead of beads) groups.get(laneForBead(bead, now)).push(bead);
  for (const group of groups.values()) {
    group.sort((left, right) => hashString(left.id) - hashString(right.id));
  }

  const largestLane = Math.max(0, ...[...groups.values()].map((group) => group.length));
  const columns = largestLane > 80 ? 6 : largestLane > 40 ? 5 : largestLane > 20 ? 4 : 3;
  const nodeSize = largestLane > 80 ? 14 : largestLane > 40 ? 18 : largestLane > 20 ? 25 : 38;
  const positions = [];

  lanes.forEach((lane, laneIndex) => {
    const group = groups.get(lane.id);
    const laneColumns = Math.min(columns, Math.max(1, group.length));
    const rows = Math.max(1, Math.ceil(group.length / laneColumns));
    group.forEach((bead, index) => {
      const column = index % laneColumns;
      const row = Math.floor(index / laneColumns);
      const jitter = ((hashString(`${bead.id}:jitter`) % 1_000) / 1_000 - 0.5) * 0.6;
      positions.push({
        bead,
        lane: lane.id,
        nodeSize,
        x: laneIndex * 20 + 2.2 + ((column + 0.5) / laneColumns) * 15.6 + jitter,
        y: 20 + ((row + 0.5) / rows) * 73,
      });
    });
  });

  return positions;
}

export function countsByLane(beads, now = new Date()) {
  const counts = Object.fromEntries(lanes.map((lane) => [lane.id, 0]));
  for (const bead of beads) counts[laneForBead(bead, now)] += 1;
  return counts;
}

export function dependencyTarget(dependency) {
  return dependency.depends_on_id || dependency.depends_on || dependency.to || "";
}

export function shortId(id) {
  if (id.length <= 11) return id;
  const pieces = id.split("-");
  return pieces.at(-1) || id.slice(-6);
}

export function tooltipLines(bead) {
  const priority = bead.priority === undefined || bead.priority === null ? "—" : `P${bead.priority}`;
  return [
    `${bead.id} · ${bead.issue_type || "task"} · ${priority}`,
    bead.title || "Untitled bead",
    `${bead.status || "unknown"}${bead.assignee ? ` · ${bead.assignee}` : ""}`,
  ];
}
