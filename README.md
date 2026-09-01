# Beads Visualizer

A live, read-only viewer for Beads work graphs exposed by a running [Gas City](https://github.com/gastownhall/gascity). It turns the article's Beads factory concept into a reusable application backed by real city data.

## What it does

- Discovers supervisor-managed cities.
- Shows open, in-progress, blocked, deferred, and closed beads in status lanes.
- Draws dependency links when both beads are visible.
- Filters by city, status, type, ID, title, assignee, description, or label.
- Shows a quick summary on hover or keyboard focus.
- Opens full bead details, relationships, children, labels, and metadata on click.
- Polls the city every 15 seconds and supports cursor-based paging.
- Proxies only documented read endpoints; browser requests cannot mutate beads.

## Requirements

- Node.js 20 or newer.
- Gas City 1.4.1 or newer with its supervisor API running.

Check the city first:

```sh
gc status
gc dashboard --no-open
```

The default supervisor API is `http://127.0.0.1:8372`.

## Run

```sh
npm start
```

Then open <http://127.0.0.1:4173>. The viewer discovers running cities and lets you select one.

To pin a city or use a non-default API:

```sh
npm start -- --city my-city --api http://127.0.0.1:8372
```

Environment variables are also supported:

```sh
GC_CITY_NAME=my-city GC_API_URL=http://127.0.0.1:8372 npm start
```

The viewer binds to loopback by default. Use `--host 0.0.0.0` deliberately if other machines must connect; the Gas City API remains behind the viewer's read-only proxy.

## Verify

```sh
npm run check
npm test
```

## API boundary

The server exposes a deliberately small same-origin facade:

- `GET /api/cities`
- `GET /api/beads`
- `GET /api/bead/:id`
- `GET /api/bead/:id/deps`
- `GET /api/bead/:id/graph`

All other `/api/*` routes return `404`, and non-read methods return `405`.
