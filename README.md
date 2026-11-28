# OSM Transit Editor

A web editor for OpenStreetMap public transport (PTv2) relations, starting with subways. It runs entirely in the browser, with no server of its own, and is published on GitHub Pages.

> Provisional name. Nothing is written to OSM yet; the editor is read-only.

## Running locally

Requires Node 24 (LTS) or newer.

```sh
npm install
npm run dev
```

| Script | What it does |
| --- | --- |
| `npm run dev` | development server |
| `npm run build` | type-checks and builds `dist/` |
| `npm run preview` | serves the build locally |
| `npm run typecheck` | strict TypeScript |
| `npm run lint` | oxlint |
| `npm test` | Vitest tests |
| `npm run test:coverage` | tests with coverage of `src/core` (85% lines and branches) |

## Configuration

Copy `.env.example` to `.env` to change the base path or the OSM API and Nominatim endpoints. The Content Security Policy only allows the endpoints configured there, so changing one means rebuilding.

## Structure

- `src/core`: plain TypeScript (data, model, rules). It must not import React; the linter enforces this.
- `src/ui`: React components and the map (MapLibre GL).
- `src/app`: app entry point and routing.
- `tests/unit`: unit tests for `src/core`.

## Deployment

Every push to `main` runs CI (`.github/workflows/ci.yml`) and deploys to GitHub Pages (`.github/workflows/deploy.yml`). In the repository settings, set **Pages > Source** to **GitHub Actions**.

## Privacy

The text you search for is sent to Nominatim. The visible map area is sent to the OpenStreetMap API as tile requests. Map tiles come from OpenFreeMap. There is no telemetry.

## Data loading

Subway routes are read from the OpenStreetMap API. The visible area is split into zoom 14 tiles, and each tile is requested with the `map` call. Each route found is then loaded in full with `relation/{id}/full`. At most two requests run at once, and loaded tiles and routes are kept in memory.

The amount of data per tile has not been measured yet.

## Data and license

Map data © OpenStreetMap contributors, available under the ODbL. Basemap by OpenFreeMap.

The code is released under the MIT license. See [LICENSE](LICENSE).
