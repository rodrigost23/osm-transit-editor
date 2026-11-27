# osm-transit-editor

A web editor for OpenStreetMap public transport (PTv2) relations, starting with subways. It runs entirely in the browser, with no server of its own, and is published on GitHub Pages.

> Provisional name. Nothing is written to OSM before milestone 3; until then the editor is read-only.

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

Copy `.env.example` to `.env` to change the base path or the OSM, Overpass and Nominatim endpoints. The Content Security Policy only allows the endpoints configured there, so changing one means rebuilding.

## Structure

- `src/core`: plain TypeScript (data, model, rules). It must not import React; the linter enforces this.
- `src/ui`: React components and the map (MapLibre GL).
- `src/app`: app entry point and routing.
- `tests/unit`: unit tests for `src/core`.

## Deployment

Every push to `main` runs CI (`.github/workflows/ci.yml`) and deploys to GitHub Pages (`.github/workflows/deploy.yml`). In the repository settings, set **Pages > Source** to **GitHub Actions**.

## Privacy

The text you search for and the visible map area are sent to Nominatim and Overpass. Map tiles come from OpenFreeMap. There is no telemetry.

## Overpass payload

To be measured with Rio de Janeiro at the end of milestone 0 and recorded here.

## Data and license

Map data © OpenStreetMap contributors, available under the ODbL. Basemap by OpenFreeMap.

The code is released under the MIT license. See [LICENSE](LICENSE).
