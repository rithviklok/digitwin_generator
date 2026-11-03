// ===================================================================
// extract-building-labels.mjs — LabelLayer.js's BUILDING_LABELS role
// only ever turns into the top LABEL_BUDGET.building (400) named
// building footprints. Fetching + JSON.parsing the WHOLE buildings.geojson
// (2.4MB, every named building in the city) on the main thread, just to
// throw away everything past the top 400, would be waste: this script
// does that filtering ONCE, offline, and writes out a
// building_labels.geojson containing only the features that would ever
// actually become a label -- the browser then fetches that instead.
//
// Imports the SAME selection logic LabelLayer.js runs at runtime
// (buildingImportance, HALL_CLUSTER_RE, LABEL_BUDGET, normalizeLabelName)
// rather than re-implementing it here, so this script can't quietly
// drift out of sync with what the browser actually does with the data.
// Because of that, LabelLayer.js's own _addBuildingNameLabels() running
// AGAIN at runtime against this already-filtered file is a harmless
// no-op: same importance sort, same dedupe, same budget cut, same
// features already sitting at the front of the list -- see the comment
// on LABEL_BUDGET's export in LabelLayer.js.
//
// Kanpur is the only city with such a file (an uploaded city has no
// building-name labels), so this script imports kanpurConfig statically
// rather than resolving a city id to a config module.
//
// Usage:
//   node scripts/extract-building-labels.mjs [dataDir]
//     dataDir - defaults to public/data/kanpur;
//               pass an explicit path if your data lives elsewhere
//               (e.g. dist/data/kanpur).
// Re-run whenever buildings.geojson's names/footprints/heights change.
// ===================================================================
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeProjector } from '../src/workers/geo-utils.js';
import { normalizeLabelName } from '../src/config/constants.js';
import { buildingImportance, HALL_CLUSTER_RE, LABEL_BUDGET } from '../src/layers/LabelLayer.js';
import { kanpurConfig } from '../src/config/cities/kanpur.config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function main() {
  const dataDir = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.join(repoRoot, 'public', 'data', 'kanpur');

  const inputPath = path.join(dataDir, 'buildings.geojson');
  const outputPath = path.join(dataDir, 'building_labels.geojson');

  console.log(`[extract-building-labels] reading ${inputPath}`);
  const raw = await readFile(inputPath, 'utf8');
  const fc = JSON.parse(raw);

  const project = makeProjector(kanpurConfig.origin);

  // Exactly LabelLayer.js's own _addBuildingNameLabels() selection: name
  // filter -> importance score -> sort desc -> dedupe by normalized name
  // (keeping the highest-importance occurrence) -> budget cut.
  const named = fc.features.filter((f) => f.properties?.name && !HALL_CLUSTER_RE.test(f.properties.name));
  const scoredAll = named
    .map((f) => ({ f, s: buildingImportance(f, project) }))
    .filter((e) => e.s > 0)
    .sort((a, b) => b.s - a.s);

  const seen = new Set();
  const kept = [];
  let dupesDropped = 0;
  for (const e of scoredAll) {
    const key = normalizeLabelName(e.f.properties.name);
    if (key && seen.has(key)) { dupesDropped++; continue; }
    if (key) seen.add(key);
    kept.push(e.f);
    if (kept.length >= LABEL_BUDGET.building) break;
  }

  const out = { type: 'FeatureCollection', features: kept };
  await writeFile(outputPath, JSON.stringify(out));

  console.log(`[extract-building-labels] ${fc.features.length} input features, ${named.length} named, ${dupesDropped} same-name dupes dropped`);
  console.log(`[extract-building-labels] kept ${kept.length} of budget ${LABEL_BUDGET.building}`);
  console.log(`[extract-building-labels] wrote ${outputPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
