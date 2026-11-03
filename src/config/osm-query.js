// ===================================================================
// osm-query.js -- the OpenStreetMap (Overpass QL) query for a city's
// bounding box. Shared by both sides so they can never disagree:
//   - the server (server/lib/overpass.js) downloads it during a build;
//   - the upload wizard (UploadView.js) links to overpass-turbo.eu with
//     the SAME query pre-filled, so when the server can't reach
//     OpenStreetMap the uploader can run it in their own browser, export
//     one GeoJSON file, and upload that instead.
// ===================================================================

/**
 * One group per request, run one after another -- the road network alone
 * can be tens of MB for an Indian metro, so splitting keeps each request
 * (and the build's peak memory) bounded, and lets one group fail without
 * losing the others. Every statement inherits the query's global [bbox].
 *
 * Areas are fetched broadly (ALL landuse/leisure/natural, which also
 * brings natural=coastline for the sea): which ones count as land use vs
 * vegetation vs water is decided afterwards, in the server's
 * osmSplitter.js classifyArea(), not baked into the query.
 */
export const OSM_QUERY_GROUPS = {
  // Footways/paths/steps/cycleways are skipped: at city scale they're
  // thousands of 2 m slivers that add noise, not legibility. So are
  // parking aisles/driveways (a large share of all `service` ways in a
  // dense Indian city) and ways that don't physically exist yet.
  roads: `
    way["highway"]["highway"!~"^(footway|path|steps|cycleway|bridleway|corridor|proposed|construction|abandoned|disused|platform|raceway|elevator|via_ferrata|escape|bus_stop|services|rest_area)$"]["service"!~"^(parking_aisle|driveway|drive-through)$"];`,
  railway: `
    way["railway"~"^(rail|light_rail|subway|narrow_gauge|tram|monorail|funicular|preserved)$"];`,
  areas: `
    way["landuse"]; relation["landuse"]["type"="multipolygon"];
    way["leisure"]; relation["leisure"]["type"="multipolygon"];
    way["natural"]; relation["natural"]["type"="multipolygon"];
    way["water"]; relation["water"]["type"="multipolygon"];
    way["waterway"="riverbank"]; relation["waterway"="riverbank"]["type"="multipolygon"];
    node["amenity"~"^(hospital|college|university|school|place_of_worship|bus_station|marketplace|police|fire_station|townhall|courthouse|library|cinema|theatre)$"]["name"];
    node["railway"~"^(station|halt)$"]["name"];
    node["place"~"^(city|town|suburb|quarter|neighbourhood)$"]["name"];`,
};

export const OSM_QUERY_TIMEOUT_S = 300;

/**
 * @param {Array<keyof OSM_QUERY_GROUPS>} groups
 * @param {{west:number, south:number, east:number, north:number}} bbox
 */
export function buildOsmQuery(groups, bbox) {
  const b = [bbox.south, bbox.west, bbox.north, bbox.east].map((v) => Number(v).toFixed(6)).join(',');
  return `[out:json][timeout:${OSM_QUERY_TIMEOUT_S}][bbox:${b}];(${groups.map((g) => OSM_QUERY_GROUPS[g]).join('')}\n);out geom;`;
}
