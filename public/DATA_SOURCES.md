# Where to get city data

Everything below is free. Only one route, Google Earth Engine, needs an
account. This is a companion to the "Upload a city" form: each upload slot
in that form links here.

## Buildings (3D footprints + height): required

The city needs each building's footprint and its height in metres. The
best free source for India, and for Africa, South and Southeast Asia, Latin
America and the Caribbean, is **Google Open Buildings**: its footprints
(version 3), each given the average height under it from Google's "2.5D
Temporal" heights. Kanpur's own buildings were made exactly this way, with
2023's heights.

**Usually there is nothing to do.** In step 2 of the upload form, keep
**"Get them for me from Google Open Buildings"** (the default): when you
press Build, the server downloads every building in the area you drew,
with its height. The Review & build page shows the download's progress.

The routes below are for when that isn't possible: the city is outside
Google's coverage, the server can't reach Google's storage, or you want a
file to check or edit first. Each makes a GeoJSON file to attach under
**"Upload my own buildings file"**. Use them in this order.

### 1. The fetch script (no account)

For whoever has the DigiTwin Generator project folder and Node.js 24, such
as the person who runs the server. Draw the area in step 1 of the upload
form, then give the script its four numbers:

```
node scripts/fetch-open-buildings.mjs --bbox <West>,<South>,<East>,<North> --name <City>
```

It writes `<City>_OpenBuildings_2_5D.geojson`. Attach that as the buildings
file and choose **`mean`** as the height property. For Kanpur it downloads
about 0.7 GB from Google's public storage and takes about 6 minutes. Its
heights match Kanpur's own file to within 0.2 m for a typical building, and
within 1 m for 96 in 100. Behind an office proxy, set `NODE_USE_ENV_PROXY=1`
and `HTTPS_PROXY` first (see HOSTING.md). The top of the script lists its
other options, such as `--year` for an earlier year's heights.

### 2. Google Earth Engine (needs a Google account)

The same data, made in Google's cloud and saved to your Google Drive. Use it
if the script can't reach Google's storage, or you don't have the project
folder.

1. Draw the area in step 1 of the upload form and note West, South, East
   and North.
2. Open **code.earthengine.google.com** and sign in with a Google account.
   It asks you to register a Cloud project. Noncommercial projects are free,
   within a monthly compute allowance. Commercial use needs a paid plan, and
   the sign-up questionnaire decides which applies to you.
3. Paste the script below into the middle panel, set the four numbers and
   the file name, and click **Run**. Red footprints over your city mean the
   area is right.
4. In the **Tasks** tab on the right, click **Run** next to the task, then
   **Run** in the dialog. It runs on Google's servers, so you can close the
   browser. The file appears in your Google Drive as `<NAME>.geojson`.
5. Attach it as the buildings file and choose **`mean`** as the height
   property.

```js
// Google Open Buildings for DigiTwin Generator: every building's footprint
// (Open Buildings v3) with its average height in metres (Open Buildings
// 2.5D Temporal), saved to Google Drive as GeoJSON. One property, `mean`,
// the same as Kanpur_OpenBuildings_2_5D.geojson.

// 1. The area from the app's upload form, step 1. These are Kanpur's.
var WEST = 80.178, SOUTH = 26.315, EAST = 80.493, NORTH = 26.553;
// 2. The file's name: letters, digits and _ only.
var NAME = 'Kanpur_OpenBuildings_2_5D';
// 3. Heights as of 30 June of this year: 2016 to 2023.
var YEAR = 2023;
// 4. Google keeps detections from 0.65 up; 0.75 drops the doubtful ones.
var MIN_CONFIDENCE = 0.65;

var area = ee.Geometry.Rectangle([WEST, SOUTH, EAST, NORTH]);

var footprints = ee.FeatureCollection('GOOGLE/Research/open-buildings/v3/polygons')
  .filterBounds(area)
  .filter('confidence >= ' + MIN_CONFIDENCE);

var height = ee.ImageCollection('GOOGLE/Research/open-buildings-temporal/v1')
  .filterBounds(area)
  .filterDate(YEAR + '-01-01', (YEAR + 1) + '-01-01')
  .mosaic()
  .select('building_height');

// The average height under each footprint. A mosaic has no pixel size of
// its own, so `scale` must be given; 1 m is plenty for heights that are
// 4 m sharp. tileScale trades speed for memory on dense cities.
var buildings = height.reduceRegions({
  collection: footprints,
  reducer: ee.Reducer.mean(),
  scale: 1,
  tileScale: 4
}).select(['mean']);

Map.centerObject(area, 12);
Map.addLayer(height, {min: 0, max: 30}, 'Height ' + YEAR + ' (m)');
Map.addLayer(footprints, {color: 'FF0000'}, 'Footprints');

Export.table.toDrive({
  collection: buildings,
  description: NAME,
  fileFormat: 'GeoJSON'
});
```

### 3. Microsoft (Bing Maps) footprints (worldwide, but flat in India)

Microsoft's Global ML Building Footprints cover the whole world. They have a
height only where Microsoft estimated one, and none of Kanpur's footprints
has one. They are also sparser: in central Kanpur, 4,713 buildings against
Google's 16,700 in the same 2 km square. Use this route only where Google has
no data, or if neither route above works.

- **With the fetch script:**
  `node scripts/fetch-open-buildings.mjs --source microsoft --bbox <West>,<South>,<East>,<North> --name <City> --flat-height 6`
  writes `<City>_MicrosoftBuildings.geojson`. Choose **`height`** as the
  height property. `--flat-height 6` gives every building without a height
  6 m, about two storeys. Without it, those buildings are left out of the
  3D city.
- **By hand:** Microsoft's notebook
  `examples/example_building_footprints.ipynb` in
  github.com/microsoft/GlobalMLBuildingFootprints downloads the footprints
  for an area into one GeoJSON file. It runs in Google Colab or any Python
  setup. Its `height` is -1 where there is no estimate. In QGIS, set those
  to a flat value with the Field Calculator, for example
  `CASE WHEN "height" < 0 THEN 6 ELSE "height" END`. Then save as GeoJSON
  in EPSG:4326. The notebook reads an older copy of Microsoft's index. The
  current one is linked at the top of the repository's README.

### Other sources

- **OpenStreetMap `building=*` tags**: export footprints for your area as
  GeoJSON with **Overpass Turbo** (overpass-turbo.eu) or the **HOT Export
  Tool** (export.hotosm.org). Height tagging (`height`, `building:levels`)
  is inconsistent and city-dependent, so treat this as a fallback, not a
  first choice.
- **Your municipal corporation's building survey**, if it has heights or
  floor counts, may beat all of the above for your city.

Credit the source where the city is shown: Google Open Buildings is CC BY
4.0 or ODbL, and Microsoft's footprints are CDLA Permissive 2.0.

Whichever source you use, the upload form asks which property holds each
building's height in metres (e.g. `height`, `mean`). Once you attach the
file it lists the file's own number properties for you to pick from. A
building with no valid height value at or above the minimum render height
(step 3, under "Advanced settings") is left out of the 3D city, not given
a made-up height. The "What's on this map" panel of your finished city
tells you exactly how many buildings that affected.

**How large can the file be?** Up to 4 GB unless whoever runs the server
has changed it. That covers the largest metros: Kanpur's file is 283 MB
(7.3 lakh buildings), Delhi's about 1.4 GB (36 lakh), and Delhi with
Gurgaon, Noida, Ghaziabad and Faridabad about 2.1 GB (54 lakh). Every other
file you attach can be at most 500 MB. The form tells you straight away if
a file is too large.

## Roads, railway, stations, neighbourhoods, land use, parks, water: automatic

Nothing to upload. All of these come from **OpenStreetMap**, and the server
downloads them for the exact area you drew while it builds your city (via
the Overpass API). Along the way:

- road centre-lines are widened into road surfaces: by the road's own
  `width` or `lanes` tag where an OpenStreetMap mapper recorded one,
  otherwise by the Indian Roads Congress standard carriageway widths for
  its class (single lane 3.75 m, two-lane 7.0-7.5 m, 3.5 m per lane on
  bigger roads). For exact widths, upload your city's own road survey
  (below);
- the **sea** is built from OpenStreetMap's coastline for coastal cities
  (OSM maps the coast as a line, never the sea as an area);
- mangroves, parks, forests and orchards get trees; farmland, grass and
  other green cover are drawn green; beaches, cantonments, temple
  complexes, ports and the like are kept as land use.

Your city's Review & build page lists which of these layers were found. If
OpenStreetMap's servers were too busy at the time, it says so. Revising
the city downloads them again.

**A large city** (a metro) is downloaded in parts: Delhi with Gurgaon,
Noida, Ghaziabad and Faridabad is 17 requests and took about 7 minutes
when tested. Parts that arrive are kept for a week, so if the servers
were too busy for some, revising the city asks only for those. An area
much larger than any city (more than about 1.5 × 1.5 degrees) is not
downloaded at all; draw the city, not the district or the state.

## Use your own files instead of OpenStreetMap

Optional, per layer: in step 2, under "Optional files", open **"Replace an
OpenStreetMap layer with your own"**. A file there replaces that one layer; every other layer
still comes from OpenStreetMap. Typical case: your municipal corporation's
road survey is better than OSM's estimated road widths. When revising a
city, "Remove, use OpenStreetMap again" undoes a replacement.

Every file must be a GeoJSON `FeatureCollection` in plain longitude /
latitude (**WGS 84, EPSG:4326**). Municipal GIS data in India is often in
UTM (EPSG:32643 / 32644 / 32645). If so, the upload is refused with a
message; re-save it in QGIS via *Export → Save Features As… → CRS EPSG:4326*.
Features entirely outside the area you drew are a sign of the wrong file,
and the layer is skipped with a message.

| Layer | Geometry | Properties used |
|---|---|---|
| Roads | Road-surface polygons (like a municipal survey), or centre-lines | `class` 0 / 1 / 2 (major / secondary / local) if you have it. Centre-lines are widened by their own `width` (metres) or `lanes` attribute, else by OSM `highway` class, else 3.75 m |
| Railways | Lines | `name` (optional) |
| Stations & amenities | Points | `name`; `amenity: "station"` (or OSM `railway=station`) for stations |
| Neighbourhood names | Points | `name` |
| Land use | Polygons | `kind` (e.g. residential, industrial) or OSM `landuse=` |
| Parks & trees | Polygons | `kind`: forest / wood / mangrove / park get trees, orchard gets rows |
| Water | Polygons | `kind` (optional). Replaces OSM water entirely, **sea included** |

## If OpenStreetMap can't be reached

If the server can't reach OpenStreetMap (no internet access, a firewall, or
every public server busy), your city still builds, with its buildings and
any files you gave, and goes live. Its Review & build page shows which
layers are missing. To fill them in, revise the city and attach **one
OpenStreetMap export** under "Server can't reach OpenStreetMap?". Nothing
is downloaded when it's attached. Ways to get the export, as GeoJSON with
OSM tags kept:

- **Overpass Turbo** (overpass-turbo.eu): the upload form's "Open the query
  for your area" button opens it with the exact query this server would
  run, already filled in for your area. Wait for it to finish, then
  *Export → GeoJSON → download*. Easiest; a metro-sized area may take a few
  minutes in the browser.
- **BBBike extracts** (extract.bbbike.org): draw your area, choose the
  "GeoJSON" format; the file arrives by email link. Works even when the
  Overpass servers themselves are down.
- **HOT Export Tool** (export.hotosm.org): pick your area, GeoJSON format,
  and include roads, railways, land use, natural, leisure, water and
  places. Also independent of Overpass.

## Admin boundaries and landmarks (wards, zones, city outline): optional

The genuinely hard one. OpenStreetMap's `boundary=administrative` +
`admin_level` tagging exists, but its granularity and accuracy vary
enormously by country. Kanpur's own ward/zone files come from the
municipal corporation directly, not OSM. Check your local or national
government's open-data portal first, where one exists; OSM is the
free-but-uneven fallback. There's no single universal source for this one.
Same format rules as above: GeoJSON in WGS 84; wards and zones as polygons
(with a `name` / ward number), landmarks as named points.

A few landmarks are easy to make yourself: on **geojson.io**, click to add
points, give each a `name`, and save as GeoJSON.

**Adding them to a city that's already live:** in the city's "What's on
this map" panel, click **Add files to this city**. The same link is **Add
or change files** on its Review & build page, and the ✎ on its tile in My
cities. Attach the files in step 2 and build. The city stays live
meanwhile, and buildings already downloaded for the same area are reused,
so the rebuild is quick.
