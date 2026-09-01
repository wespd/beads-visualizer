import {
  countsByLane,
  dependencyTarget,
  lanes,
  layoutBeads,
  shortId,
  tooltipLines,
} from "./model.js";

const elements = Object.fromEntries(
  [
    "blocked-count",
    "board",
    "city-select",
    "closed-count",
    "closed-toggle",
    "connection",
    "connection-label",
    "dependency-layer",
    "detail-content",
    "detail-empty",
    "empty-state",
    "lane-grid",
    "lane-template",
    "live-toggle",
    "load-more-button",
    "node-layer",
    "page-summary",
    "progress-count",
    "ready-count",
    "refresh-button",
    "search-input",
    "status-select",
    "tooltip",
    "type-select",
    "updated-at",
    "visible-count",
  ].map((id) => [id, document.getElementById(id)]),
);

const state = {
  allBeads: [],
  cities: [],
  loading: false,
  nextCursor: "",
  selectedId: "",
  total: 0,
};

const refreshIntervalMs = 15_000;
let refreshTimer;
let requestGeneration = 0;

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

async function fetchJson(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  let body;
  try {
    body = await response.json();
  } catch {
    body = { error: `${response.status} ${response.statusText}` };
  }
  if (!response.ok) throw new Error(body.detail || body.error || `${response.status} ${response.statusText}`);
  return body;
}

function setConnection(mode, label) {
  elements.connection.dataset.state = mode;
  elements["connection-label"].textContent = label;
}

function selectedCity() {
  return elements["city-select"].value;
}

function beadQuery(cursor = "") {
  const query = new URLSearchParams({ city: selectedCity(), limit: "200" });
  const status = elements["status-select"].value;
  if (status) query.set("status", status);
  if (elements["closed-toggle"].checked || status === "closed") query.set("all", "true");
  if (cursor) query.set("cursor", cursor);
  return query;
}

function matchesSearch(bead, search) {
  if (!search) return true;
  const haystack = [
    bead.id,
    bead.title,
    bead.assignee,
    bead.issue_type,
    bead.description,
    ...(bead.labels || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  return haystack.includes(search);
}

function visibleBeads() {
  const type = elements["type-select"].value;
  const search = elements["search-input"].value.trim().toLocaleLowerCase();
  return state.allBeads.filter(
    (bead) => (!type || bead.issue_type === type) && matchesSearch(bead, search),
  );
}

function updateTypeOptions() {
  const selected = elements["type-select"].value;
  const types = [...new Set(state.allBeads.map((bead) => bead.issue_type || "task"))].sort();
  elements["type-select"].replaceChildren(new Option("All types", ""));
  for (const type of types) elements["type-select"].append(new Option(type, type));
  if (types.includes(selected)) elements["type-select"].value = selected;
}

function renderLanes(counts) {
  elements["lane-grid"].replaceChildren();
  for (const lane of lanes) {
    const fragment = elements["lane-template"].content.cloneNode(true);
    const laneElement = fragment.querySelector(".lane");
    laneElement.dataset.lane = lane.id;
    laneElement.querySelector("strong").textContent = lane.label;
    laneElement.querySelector("span").textContent = lane.description;
    laneElement.querySelector("b").textContent = counts[lane.id];
    elements["lane-grid"].append(fragment);
  }
}

function renderEdges(positions) {
  elements["dependency-layer"].replaceChildren();
  const positionById = new Map(positions.map((position) => [position.bead.id, position]));
  let edgeCount = 0;
  for (const position of positions) {
    for (const dependency of position.bead.dependencies || []) {
      const target = positionById.get(dependencyTarget(dependency));
      if (!target || edgeCount >= 300) continue;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(position.x * 10));
      line.setAttribute("y1", String(position.y * 7));
      line.setAttribute("x2", String(target.x * 10));
      line.setAttribute("y2", String(target.y * 7));
      if ((dependency.type || dependency.kind) === "blocks") line.classList.add("blocks");
      elements["dependency-layer"].append(line);
      edgeCount += 1;
    }
  }
}

function showTooltip(node, bead) {
  elements.tooltip.replaceChildren(...tooltipLines(bead).map((line) => createElement("span", "", line)));
  elements.tooltip.hidden = false;
  const boardRect = elements.board.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  const left = nodeRect.left - boardRect.left + nodeRect.width / 2;
  const preferAbove = nodeRect.top - boardRect.top > 100;
  elements.tooltip.style.left = `${Math.max(8, Math.min(left, boardRect.width - 300))}px`;
  elements.tooltip.style.top = preferAbove
    ? `${nodeRect.top - boardRect.top - elements.tooltip.offsetHeight - 9}px`
    : `${nodeRect.bottom - boardRect.top + 9}px`;
}

function hideTooltip() {
  elements.tooltip.hidden = true;
}

function renderNodes(beads) {
  const positions = layoutBeads(beads);
  const largest = Math.max(0, ...Object.values(countsByLane(beads)));
  elements.board.dataset.density = largest > 40 ? "high" : "normal";
  elements["node-layer"].replaceChildren();

  for (const position of positions) {
    const node = createElement("button", "bead-node", shortId(position.bead.id));
    node.type = "button";
    node.dataset.id = position.bead.id;
    node.dataset.lane = position.lane;
    node.style.left = `${position.x}%`;
    node.style.top = `${position.y}%`;
    node.style.setProperty("--node-size", position.nodeSize);
    node.setAttribute("aria-label", `${position.bead.id}: ${position.bead.title}`);
    node.setAttribute("aria-pressed", String(position.bead.id === state.selectedId));
    node.addEventListener("pointerenter", () => showTooltip(node, position.bead));
    node.addEventListener("pointerleave", hideTooltip);
    node.addEventListener("focus", () => showTooltip(node, position.bead));
    node.addEventListener("blur", hideTooltip);
    node.addEventListener("click", () => selectBead(position.bead));
    elements["node-layer"].append(node);
  }

  renderEdges(positions);
}

function render() {
  const beads = visibleBeads();
  const counts = countsByLane(beads);
  renderLanes(counts);
  renderNodes(beads);
  elements["empty-state"].hidden = beads.length !== 0;
  elements["visible-count"].textContent = beads.length;
  elements["ready-count"].textContent = counts.ready;
  elements["progress-count"].textContent = counts.progress;
  elements["blocked-count"].textContent = counts.blocked + counts.deferred;
  elements["closed-count"].textContent = counts.closed;
  elements["page-summary"].textContent = `Loaded ${state.allBeads.length.toLocaleString()} of ${state.total.toLocaleString()} bead${state.total === 1 ? "" : "s"}`;
  elements["load-more-button"].hidden = !state.nextCursor;
}

function chip(text, extraClass = "") {
  return createElement("span", `chip ${extraClass}`.trim(), text);
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function addField(list, label, value) {
  list.append(createElement("dt", "", label), createElement("dd", "", value || "—"));
}

function detailSection(title) {
  const section = createElement("section", "detail-section");
  section.append(createElement("h3", "", title));
  return section;
}

function relationList(bead, children) {
  const items = [];
  if (bead.parent) items.push({ label: "parent", id: bead.parent });
  for (const dependency of bead.dependencies || []) {
    items.push({ label: dependency.type || dependency.kind || "depends on", id: dependencyTarget(dependency) });
  }
  for (const child of children || []) items.push({ label: "child", id: child.id, title: child.title });
  if (!items.length) return createElement("p", "", "No relationships returned.");

  const list = createElement("ul", "relation-list");
  for (const item of items) {
    const row = createElement("li");
    row.append(createElement("code", "", item.label), createElement("span", "", item.title ? `${item.id} · ${item.title}` : item.id || "unknown"));
    list.append(row);
  }
  return list;
}

function renderDetails(bead, deps = {}) {
  const content = elements["detail-content"];
  content.replaceChildren();

  const header = createElement("header", "detail-header");
  const headerTop = createElement("div", "detail-header-top");
  headerTop.append(createElement("span", "detail-id", bead.id));
  const closeButton = createElement("button", "detail-close", "×");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Close bead details");
  closeButton.addEventListener("click", closeDetails);
  headerTop.append(closeButton);
  header.append(headerTop, createElement("h2", "", bead.title || "Untitled bead"));
  const chips = createElement("div", "chips");
  chips.append(chip(bead.status || "unknown", "status"), chip(bead.issue_type || "task"));
  if (bead.priority !== undefined && bead.priority !== null) chips.append(chip(`P${bead.priority}`));
  if (bead.ephemeral) chips.append(chip("ephemeral"));
  if (bead.no_history) chips.append(chip("no history"));
  header.append(chips);
  content.append(header);

  const facts = detailSection("Record");
  const fields = createElement("dl", "field-grid");
  addField(fields, "Assignee", bead.assignee);
  addField(fields, "Created", formatTime(bead.created_at));
  addField(fields, "Updated", formatTime(bead.updated_at));
  addField(fields, "Deferred until", formatTime(bead.defer_until));
  addField(fields, "Reference", bead.ref);
  addField(fields, "Blocked", bead.is_blocked === undefined ? "—" : String(bead.is_blocked));
  facts.append(fields);
  content.append(facts);

  if (bead.description) {
    const description = detailSection("Description");
    description.append(createElement("p", "", bead.description));
    content.append(description);
  }

  const labels = detailSection("Labels");
  const labelChips = createElement("div", "chips");
  for (const label of bead.labels || []) labelChips.append(chip(label));
  labels.append(labelChips.childElementCount ? labelChips : createElement("p", "", "No labels."));
  content.append(labels);

  const relationships = detailSection("Relationships");
  relationships.append(relationList(bead, deps.children));
  content.append(relationships);

  const metadataEntries = Object.entries(bead.metadata || {}).sort(([left], [right]) => left.localeCompare(right));
  if (metadataEntries.length) {
    const metadata = detailSection(`Metadata · ${metadataEntries.length}`);
    const table = createElement("table", "metadata-table");
    const body = document.createElement("tbody");
    for (const [key, value] of metadataEntries) {
      const row = document.createElement("tr");
      row.append(createElement("th", "", key), createElement("td", "", value));
      body.append(row);
    }
    table.append(body);
    metadata.append(table);
    content.append(metadata);
  }
}

function closeDetails() {
  state.selectedId = "";
  elements["detail-content"].hidden = true;
  elements["detail-empty"].hidden = false;
  renderNodes(visibleBeads());
}

async function selectBead(seedBead) {
  state.selectedId = seedBead.id;
  renderNodes(visibleBeads());
  elements["detail-empty"].hidden = true;
  elements["detail-content"].hidden = false;
  elements["detail-content"].replaceChildren(createElement("p", "detail-loading", `Loading ${seedBead.id}…`));
  const query = new URLSearchParams({ city: selectedCity() });
  try {
    const [bead, deps] = await Promise.all([
      fetchJson(`/api/bead/${encodeURIComponent(seedBead.id)}?${query}`),
      fetchJson(`/api/bead/${encodeURIComponent(seedBead.id)}/deps?${query}`).catch(() => ({ children: [] })),
    ]);
    if (state.selectedId === seedBead.id) renderDetails(bead, deps);
  } catch (error) {
    if (state.selectedId === seedBead.id) {
      elements["detail-content"].replaceChildren(createElement("div", "error-box", error.message));
    }
  }
}

async function loadBeads({ append = false, quiet = false } = {}) {
  if (!selectedCity() || state.loading) return;
  const generation = ++requestGeneration;
  state.loading = true;
  elements["refresh-button"].disabled = true;
  if (!quiet) setConnection("loading", `Loading ${selectedCity()}`);
  try {
    const cursor = append ? state.nextCursor : "";
    const data = await fetchJson(`/api/beads?${beadQuery(cursor)}`);
    if (generation !== requestGeneration) return;
    state.allBeads = append
      ? [...state.allBeads, ...(data.items || []).filter((candidate) => !state.allBeads.some((bead) => bead.id === candidate.id))]
      : data.items || [];
    state.total = data.total ?? state.allBeads.length;
    state.nextCursor = data.next_cursor || "";
    updateTypeOptions();
    render();
    elements["updated-at"].textContent = `Updated ${new Date().toLocaleTimeString()}${data.partial ? " · partial response" : ""}`;
    setConnection("connected", selectedCity());
  } catch (error) {
    setConnection("error", "City unavailable");
    elements["page-summary"].textContent = error.message;
    if (!quiet) {
      elements["node-layer"].replaceChildren();
      elements["dependency-layer"].replaceChildren();
    }
  } finally {
    state.loading = false;
    elements["refresh-button"].disabled = false;
  }
}

async function loadCities() {
  setConnection("loading", "Discovering cities");
  const [config, response] = await Promise.all([fetchJson("/api/config"), fetchJson("/api/cities")]);
  state.cities = response.items || [];
  elements["city-select"].replaceChildren();
  for (const city of state.cities) {
    const option = new Option(city.name, city.name);
    option.disabled = city.running === false;
    elements["city-select"].append(option);
  }
  const queryCity = new URLSearchParams(location.search).get("city");
  const preferred = queryCity || config.defaultCity;
  if (preferred && state.cities.some((city) => city.name === preferred)) elements["city-select"].value = preferred;
  if (!state.cities.length) throw new Error("No running Gas City instances were returned.");
  await loadBeads();
}

function resetAndLoad() {
  state.nextCursor = "";
  state.total = 0;
  closeDetails();
  void loadBeads();
}

function scheduleRefresh() {
  window.clearInterval(refreshTimer);
  if (elements["live-toggle"].checked) {
    refreshTimer = window.setInterval(() => loadBeads({ quiet: true }), refreshIntervalMs);
  }
}

elements["city-select"].addEventListener("change", () => {
  const url = new URL(location.href);
  url.searchParams.set("city", selectedCity());
  history.replaceState(null, "", url);
  resetAndLoad();
});
elements["status-select"].addEventListener("change", () => {
  if (elements["status-select"].value === "closed") elements["closed-toggle"].checked = true;
  resetAndLoad();
});
elements["closed-toggle"].addEventListener("change", resetAndLoad);
elements["type-select"].addEventListener("change", render);
elements["search-input"].addEventListener("input", render);
elements["refresh-button"].addEventListener("click", () => loadBeads());
elements["load-more-button"].addEventListener("click", () => loadBeads({ append: true }));
elements["live-toggle"].addEventListener("change", scheduleRefresh);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.selectedId) closeDetails();
});

for (const lane of lanes) {
  const fragment = elements["lane-template"].content.cloneNode(true);
  fragment.querySelector("strong").textContent = lane.label;
  fragment.querySelector("span").textContent = lane.description;
  fragment.querySelector("b").textContent = "0";
  elements["lane-grid"].append(fragment);
}

try {
  await loadCities();
  scheduleRefresh();
} catch (error) {
  setConnection("error", "City unavailable");
  elements["page-summary"].textContent = error.message;
  elements["empty-state"].hidden = false;
  elements["empty-state"].replaceChildren(
    createElement("strong", "", "Could not connect to Gas City."),
    createElement("span", "", error.message),
  );
}
