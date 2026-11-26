# NYC 3D

A high-resolution, real-time 3D map of New York City that you can fly around in the browser. It is built region by region from authoritative open data.

**Current coverage:** Lower Manhattan (everything south of Houston Street, including Battery Park City, the Financial District, Tribeca, SoHo, Chinatown and the Lower East Side, plus Governors, Liberty and Ellis Islands). The other boroughs and nearby New Jersey are drawn as context land, with a procedural street grid by day and glowing streets by night.

- **5,500+ buildings** from NYC Building Footprints, using surveyed roof heights and construction years.
- **Streets, sidewalks (with curbs), parks, plazas, piers and fountains** from the NYC Planimetric Database.
- **~10k street trees** from NYC Forestry Tree Points, sized by trunk diameter and coloured by genus. Parks get procedural trees.
- **Day / Evening / Night**, plus a continuous time-of-day slider and a time-lapse mode. The sun follows a real solar path for NYC, so at golden hour it sets down the Hudson.
- Procedural facades: brick, limestone, post-war concrete and glass curtain wall, chosen from building age and height. Glass reflects the sky (PBR). At night individual windows light up floor by floor, with crown lighting on towers.
- Night city: street-lamp pools, lamp heads, blinking aviation beacons, an orange light dome over the skyline, and stars and a moon.
- Harbour water with real-time planar reflections, waves and sun glint.
- Cascaded-style shadow map that follows the camera, ACES tone mapping and bloom.
- A hand-modelled **One World Trade Center** (tapered octagonal shaft and spire), aligned to its real footprint.

## Running

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:5173. The processed data for Lower Manhattan is committed under `public/data`, so no data build is needed to run it.

Production build (static files in `dist/`, which can be hosted anywhere, e.g. GitHub Pages):

```bash
npm run build
```

## Controls

| | Map mode (default) | Fly mode |
|---|---|---|
| Mouse | Left-drag pan · Right-drag orbit/tilt · Wheel zoom to cursor | Click to capture the mouse, then move it to look · Wheel changes speed |
| Keys | `W A S D` / arrows move · `Q E` rotate · `R F` tilt · `Z X` zoom · `Shift` faster | `W A S D` fly · `E`/`Space` up · `Q`/`C` down · `Shift` boost · `Esc` release mouse |
| Other | Double-click to fly to a point · Click a building for its details | |

Global keys: `Tab` (or `G`) switches between map and fly mode. `1` `2` `3` select day, evening and night. `N` faces north and `H` toggles the help panel. You can also jump to a curated viewpoint from the **Places** list.

## Architecture

```
config/            world.json (projection origin, tile size) · regions.json (region boundaries)
pipeline/          Node/TypeScript data pipeline (npm run data)
  providers/       one provider per jurisdiction/data source (nyc.ts = NYC Open Data)
  build.ts         fetch → project → clean → clip to region → tile → write NY3D binaries + manifest
public/data/       pipeline output: manifest.json, tiles/<region>/<layer>/<ix>_<iz>.bin, context/land.bin
src/core/          code shared by pipeline and viewer: projection, tile format, manifest types
src/workers/       meshWorker: turns tiles into GPU geometry off the main thread
src/data/          TileManager (streams tiles around the camera) + worker pool
src/render/        materials/shaders, sky, water, time of day, lights, trees, landmarks, layer registry
src/controls/      CameraController (map + fly modes, animated fly-to, ground collision)
src/ui/            DOM overlay, places list
```

Key design choices that make the map easy to extend:

- **One global coordinate system.** A spherical Transverse Mercator is centred on a fixed origin (`config/world.json`). Every region ever built lands in the same metric scene space, with no seams.
- **Global tile grid** (1 km). Tiles stream in and out by distance from the camera, so the viewer scales from one neighbourhood to the whole city.
- **Compact source geometry, meshed on the client.** Tiles store 2D footprints and attributes (≈1 MB for all of Lower Manhattan), not triangles. Extrusion, facades and lights are generated in Web Workers, so you can change the look without rebuilding data.
- **Providers + a layer registry.** A provider produces the standard layers (`buildings`, `roads`, `sidewalks`, `parks`, `plazas`, `piers`, `water`, `trees`) for a jurisdiction. `src/render/layers.ts` says how each layer is meshed and shaded.
- **Landmarks** (`src/render/Landmarks.ts`) replace specific footprints with hand-built models, positioned from the footprint itself.

### NY3D tile format

This is a tiny versioned binary container: the magic `NY3D`, a version, a JSON header, then 4-byte-aligned typed arrays. Polygon layers store `featRings`, `ringVerts` and `coords` (x, z float pairs relative to the tile origin) plus one array per attribute. Point layers store `coords` plus attributes. See `src/core/tileFormat.ts`.

## Adding more of the city

### More of Manhattan or another NYC borough

These use the same NYC Open Data provider.

1. Add a region to `config/regions.json` with a `boundary` polygon (lon/lat) that **does not overlap** existing regions. Set `"provider": "nyc"`, the `"borough"` (Manhattan, Brooklyn, Queens, Bronx or Staten Island) and an optional start `camera`. Features belong to a region when their centroid falls inside the boundary and the nearest borough is the one named, so boundaries can run down the middle of rivers.
2. Run `npm run data -- <region-id>`. Raw downloads are cached in `data-cache/`; add `--refresh` to re-download.
3. Reload the viewer. The manifest now lists the new region and its tiles stream in automatically.

For example, a Midtown region would start its boundary on the same Houston St line that closes Lower Manhattan's northern edge. A Brooklyn region would use `"borough": "Brooklyn"` and a boundary covering the borough.

### Jersey City / Hoboken (outside NYC)

NYC Open Data stops at the state line, so write a new provider in `pipeline/providers/` (e.g. `osm.ts` using Overpass, or Hudson County / NJGIN GIS footprints) that implements the `Provider` interface in `pipeline/providers/types.ts`. It must return the same layer names and props (`buildings` needs `height` in metres, plus `year`, `bin` and `kind`, where `0` = building). Register it in `PROVIDERS` in `pipeline/build.ts` and reference it from a region with `"provider": "<id>"` and no `borough`.

### Context land

`npm run data -- --context` rebuilds `context/land.bin`: all five boroughs (NYC Borough Boundaries) plus the surrounding counties (TIGER/Line, with water areas removed). The list is `CONTEXT_COUNTIES` in `pipeline/build.ts`.

## Data sources & licences

- NYC Open Data: Building Footprints (`5zhs-2jue`), Planimetric Roadbed (`i36f-5ih7`), Sidewalk (`52n9-sdep`), Open Space Parks (`y6ja-fw4f`) and Other (`b7j8-z8a7`), Hydrography (`pjs3-c3z5`), Hydrography Structures (`6hbv-tek4`), Forestry Tree Points (`hn5i-inap`) and Borough Boundaries (`gthc-hcne`). These are published under the [NYC Open Data terms of use](https://opendata.cityofnewyork.us/overview/#termsofuse).
- US Census Bureau TIGER/Line 2023: counties and area water (public domain).

## Known limitations / ideas

- Terrain is flat (Lower Manhattan's ground varies by only a few metres). Ground elevation is available in the footprint data if needed.
- Bridges are not modelled yet. The Brooklyn and Manhattan Bridges would make good next landmarks.
- Facades are procedural, not photographic.
