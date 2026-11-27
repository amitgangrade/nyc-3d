# NYC 3D

A high-resolution, real-time 3D map of New York City that you can fly around in the browser. It is built region by region from authoritative open data.

**Current coverage:**
- **Lower Manhattan:** everything south of Houston Street, including Battery Park City, the Financial District, Tribeca, SoHo, Chinatown and the Lower East Side, plus Governors, Liberty and Ellis Islands. Built from NYC Open Data.
- **Manhattan from Houston St to Central Park:** the Villages, Chelsea, Flatiron, Gramercy, Midtown, Hell's Kitchen, Hudson Yards, Billionaires' Row and all of Central Park (to 110th St). Built from NYC Open Data, with towers refined by OpenStreetMap 3D parts.
- **Jersey City:** the whole municipality, from Exchange Place and Newport to Journal Square, Liberty State Park and the Heights. Built from OpenStreetMap.

The other boroughs and the rest of New Jersey are drawn as context land, with a procedural street grid by day and glowing streets by night.

- **5,500+ buildings** from NYC Building Footprints, using surveyed roof heights and construction years.
- **Streets, sidewalks (with curbs), parks, plazas, piers and fountains** from the NYC Planimetric Database.
- **~10k street trees** from NYC Forestry Tree Points, sized by trunk diameter and coloured by genus. Parks get procedural trees.
- **Jersey City buildings** come from OpenStreetMap footprints and `building:part` volumes, using the `height` / `min_height` / `building:levels` tags. Buildings without tags fall back to Microsoft Global ML Building Footprints height estimates, then to a default by building type. Roads are drawn as width-by-class ribbons, and bridges are lifted above the ground.
- **Day / Evening / Night**, plus a continuous time-of-day slider and a time-lapse mode. The sun follows a real solar path for NYC, so at golden hour it sets down the Hudson.
- **Full-moon night:** a large moon hangs low over the East River, casting blue moonlight and a glitter path on deep-blue water. Streets, sidewalks and plazas glow, grass stays visible, and park trees twinkle with multicoloured fairy lights. About a third of buildings get coloured architectural uplighting and crown bands.
- **Three illuminated East River bridges:** Brooklyn (stone Gothic towers, stays, rainbow "necklace" lights), Manhattan (blue steel towers) and Williamsburg (magenta lattice towers). Each is modelled from its NYC deck polygon and the shoreline, with colour-cycling tower washes and shimmering cables.
- Procedural facades: brick, limestone, post-war concrete and glass curtain wall, chosen from building age and height. Glass reflects the sky (PBR). At night individual windows light up floor by floor, with crown lighting on towers.
- Night city: street-lamp pools, lamp heads, blinking aviation beacons, an orange light dome over the skyline, and stars and a moon.
- Harbour water with real-time planar reflections, waves and sun glint.
- Cascaded-style shadow map that follows the camera, ACES tone mapping and bloom.
- **Setback towers:** NYC footprints carry a single roof height, so where OpenStreetMap has `building:part` volumes covering a footprint (Empire State, Chrysler, Woolworth and thousands more), the footprint is replaced by those stepped parts. Set `NO_OSM_PARTS=1` to disable this.
- **Signature lighting:** the Empire State crown cycles through colours, the Chrysler crown glows white, and Times Square is wrapped in animated billboards.
- A hand-modelled **One World Trade Center** (tapered octagonal shaft and spire), aligned to its real footprint.
- **Building info** on click: height, year built and source, with links to the OSM object for Jersey City buildings.

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
  providers/       one provider per jurisdiction/data source (nyc.ts = NYC Open Data, osm.ts = OpenStreetMap)
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
- **Providers + a layer registry.** A provider produces the standard layers (`buildings`, `roads`, `sidewalks`, `paths`, `parks`, `plazas`, `piers`, `water`, `trees`) for a jurisdiction. Roads may be polygons (NYC) or polylines with a width (OSM); the worker handles both. `src/render/layers.ts` says how each layer is meshed and shaded.
- **Landmarks** (`src/render/Landmarks.ts`) replace specific footprints with hand-built models, positioned from the footprint itself.

### NY3D tile format

This is a tiny versioned binary container: the magic `NY3D`, a version, a JSON header, then 4-byte-aligned typed arrays. Polygon layers store `featRings`, `ringVerts` and `coords` (x, z float pairs relative to the tile origin) plus one array per attribute. Line layers reuse the same arrays with one open polyline per feature. Point layers store `coords` plus attributes. See `src/core/tileFormat.ts`.

## Adding more of the city

### More of Manhattan or another NYC borough

These use the same NYC Open Data provider.

1. Add a region to `config/regions.json` with a `boundary` polygon (lon/lat) that **does not overlap** existing regions. Set `"provider": "nyc"`, the `"borough"` (Manhattan, Brooklyn, Queens, Bronx or Staten Island) and an optional start `camera`. Features belong to a region when their centroid falls inside the boundary and the nearest borough is the one named, so boundaries can run down the middle of rivers.
2. Run `npm run data -- <region-id>`. Raw downloads are cached in `data-cache/`; add `--refresh` to re-download.
3. Reload the viewer. The manifest now lists the new region and its tiles stream in automatically.

For example, a Midtown region would start its boundary on the same Houston St line that closes Lower Manhattan's northern edge. A Brooklyn region would use `"borough": "Brooklyn"` and a boundary covering the borough.

### Hoboken, Bayonne and the rest of New Jersey (OpenStreetMap)

Jersey City uses the `osm` provider (`pipeline/providers/osm.ts`). Adding another NJ town is just a new region in `config/regions.json` with:
- `"provider": "osm"`
- `"excludeNYC": true`, which drops anything lying on NYC borough land
- a non-overlapping `boundary`. The Jersey City boundary is the US Census TIGER/Line place outline, simplified.

Then run `npm run data -- <region-id>`. The provider queries an Overpass mirror (`OVERPASS_URL` overrides it) in a grid of small chunks with retries, caching every chunk in `data-cache/`. If a run is interrupted, rerunning it resumes. It also downloads the Microsoft building-height tile covering the area once.

Other jurisdictions can get their own provider implementing the `Provider` interface in `pipeline/providers/types.ts`, returning the same layer names and props. Register it in `PROVIDERS` in `pipeline/build.ts`.

### Context land

`npm run data -- --context` rebuilds `context/land.bin`: all five boroughs (NYC Borough Boundaries) plus the surrounding counties (TIGER/Line, with water areas removed). The list is `CONTEXT_COUNTIES` in `pipeline/build.ts`.

## Data sources & licences

- NYC Open Data: Building Footprints (`5zhs-2jue`), Planimetric Roadbed (`i36f-5ih7`), Sidewalk (`52n9-sdep`), Open Space Parks (`y6ja-fw4f`) and Other (`b7j8-z8a7`), Hydrography (`pjs3-c3z5`), Hydrography Structures (`6hbv-tek4`), Forestry Tree Points (`hn5i-inap`) and Borough Boundaries (`gthc-hcne`). These are published under the [NYC Open Data terms of use](https://opendata.cityofnewyork.us/overview/#termsofuse).
- US Census Bureau TIGER/Line 2023: counties, area water and the Jersey City place boundary (public domain).
- © OpenStreetMap contributors (Jersey City buildings, streets, parks, piers and trees, and Manhattan 3D building parts), licensed under the [ODbL](https://www.openstreetmap.org/copyright).
- Microsoft Global ML Building Footprints (height estimates for untagged Jersey City buildings), licensed under the [ODbL](https://github.com/microsoft/GlobalMLBuildingFootprints).

## Known limitations / ideas

- Terrain is flat (Lower Manhattan's ground varies by only a few metres). Ground elevation is available in the footprint data if needed.
- Only the three East River bridges are modelled. Other OSM bridges are lifted road ribbons without supports.
- Jersey City building heights are only as good as OSM tagging. Untagged mid-rises use ML estimates, which top out around 40 m.
- Facades are procedural, not photographic.
