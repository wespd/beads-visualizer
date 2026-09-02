# Beads Event Factory

Wesley Davidson's Beads Event Factory visualizer, extracted from the Gas City blog demo and extended into a live, read-only Beads viewer.

The canvas, factory machinery, bins, claws, physics, visual design, and twelve-event journal playback are the original visualizer. The standalone viewer adds live city data, filters, hover summaries, and click details without replacing that design.

## Provenance

The factory and its visual design were created by Wesley Davidson. Chris Sells adapted it to run inside the Gas City website. `public/index.html` is based on the decoded inner document from that website integration:

```text
gascity/landing-page
sites/blog.gascity.com/public/demos/beads-event-factory.html
website integration commit 84c59bc (Chris Sells, 2026-08-26)
```

The blog wrapper sandboxes that document in an iframe. The standalone repository serves the inner document directly so it can call the local read-only API facade.

## Live viewer

When a Gas City supervisor is available, the factory starts in live mode and:

- discovers running cities;
- places real beads in the original blocked funnel, open bin, work area, closed bin, and deferred/failed floor;
- refreshes every 15 seconds while preserving already-rendered beads and their motion;
- gives newly discovered beads a slight random spawn offset before gravity takes over;
- gives every in-progress bead its own work claw;
- filters by type or text and can include the newest closed records;
- shows ID, title, type, priority, status, and assignee on hover;
- shows the full record, description, labels, relationships, children, and metadata on click.

The **Demo events** button returns to the original twelve-event animation. **Live city** switches back to current data.

## Run

Requirements:

- Node.js 20 or newer.
- Gas City 1.4.1 or newer with its supervisor API running.

```sh
gc status
npm start -- --city my-city
```

Open <http://127.0.0.1:4173>.

For a faster temporary polling interval, pass milliseconds in the viewer URL. The value is clamped between 500 ms and 60 seconds; the default remains 15 seconds:

```text
http://127.0.0.1:4173/?city=my-city&poll=1000
```

The defaults are:

- viewer: `http://127.0.0.1:4173`
- Gas City supervisor API: `http://127.0.0.1:8372`

Override them when necessary:

```sh
npm start -- --city my-city --api http://127.0.0.1:8372 --port 4173
```

The viewer binds to loopback unless `--host` is explicitly supplied.

## Read-only boundary

The local server exposes only:

- `GET /api/config`
- `GET /api/cities`
- `GET /api/beads`
- `GET /api/bead/:id`
- `GET /api/bead/:id/deps`
- `GET /api/bead/:id/graph`

Unknown API routes return `404`; non-read methods return `405`.

## Verify

```sh
npm run verify
npm run test:live -- --city my-city
```

`verify` runs syntax checks, the normal test suite, and the stress harness. The stress harness drives 121 synthetic beads through rapid refreshes, status changes, additions and removals, multiple work claws, filtering, details, resizing, API failure, and recovery. It also asserts that unchanged beads and claws retain object identity across refreshes. The separate live smoke command requires a running Gas City.
