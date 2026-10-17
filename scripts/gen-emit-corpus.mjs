// Generate the example-model Parquet corpus with the REAL `ros-madair-emit`,
// replacing the old hand-rolled gen-example-parquet.mjs (which approximated emit's
// output in JS and had since diverged from the engine's schema — pre-melt concept_id
// column, no concepts_/ordered_ stores). Now the demos query the exact bytes the
// engine produces, so their SQL cannot drift from what ros-madair-duck/-wasm emit.
//
// Pipeline:
//   1. obtain the emit binary (local override $ROS_MADAIR_EMIT, else download the
//      pinned GitHub release asset, cached under scripts/.cache),
//   2. assemble a data_dir from the committed source (resource models + business
//      data + controlled-list collections),
//   3. run emit → public/data/ (tiles_/concepts_/edges_/ordered_<graphid>.parquet
//      + concept_catalog.parquet + manifest.json, all keyed by graph id),
//   4. derive resource_graph.json (resourceinstanceid → {graph_id, name}) that the
//      alizarin tile-store client (lib/rm-arches-client.ts) reads.

import { execSync } from 'node:child_process';
import {
  mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, existsSync, chmodSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const OUT = join(ROOT, 'public', 'data');
const SRC_MODELS = join(ROOT, 'public', 'rm-example', 'resource_models');
const SRC_BUSINESS = join(ROOT, 'example-data', 'business_data');
const SRC_COLLECTIONS = join(ROOT, 'public', 'rm-example', 'collections');

// The emit release the docs are pinned to. Kept in lockstep with the ros-madair
// release the demos were authored against; bump when adopting a newer engine.
const EMIT_VERSION = 'v0.1.0-alpha.25';
const EMIT_ASSET = 'ros-madair-emit-linux-amd64';
const EMIT_URL = `https://github.com/flaxandteal/ros-madair/releases/download/${EMIT_VERSION}/${EMIT_ASSET}`;

function emitBinary() {
  // Local override for development against an unreleased build.
  if (process.env.ROS_MADAIR_EMIT) return process.env.ROS_MADAIR_EMIT;
  const cache = join(HERE, '.cache');
  mkdirSync(cache, { recursive: true });
  const bin = join(cache, `${EMIT_ASSET}-${EMIT_VERSION}`);
  if (!existsSync(bin)) {
    console.log(`↓ downloading ${EMIT_ASSET} ${EMIT_VERSION}`);
    execSync(`curl -fsSL -o '${bin}' '${EMIT_URL}'`, { stdio: 'inherit' });
    chmodSync(bin, 0o755);
  }
  return bin;
}

function assembleDataDir() {
  const dd = join(HERE, '.emit-datadir');
  rmSync(dd, { recursive: true, force: true });
  const graphs = join(dd, 'graphs', 'resource_models');
  const business = join(dd, 'business_data');
  const collections = join(dd, 'reference_data', 'collections');
  for (const d of [graphs, business, collections]) mkdirSync(d, { recursive: true });

  // Graph models (skip the _all.json aggregate index — it is not a graph).
  for (const f of readdirSync(SRC_MODELS)) {
    if (f.endsWith('.json') && f !== '_all.json') copyFileSync(join(SRC_MODELS, f), join(graphs, f));
  }
  // Business data: the bundles are named `_<graphid>.json`; emit SKIPS files whose
  // name starts with `_` (it treats them as non-resource), so strip the underscore.
  for (const f of readdirSync(SRC_BUSINESS)) {
    if (f.endsWith('.json')) copyFileSync(join(SRC_BUSINESS, f), join(business, f.replace(/^_/, '')));
  }
  // Controlled lists → the concept catalog (DFS intervals) for DescendantOrSelfOf.
  for (const f of readdirSync(SRC_COLLECTIONS)) {
    if (f.endsWith('.json')) copyFileSync(join(SRC_COLLECTIONS, f), join(collections, f));
  }
  return dd;
}

// resource_graph.json: resourceinstanceid → {graph_id, name}. The alizarin client
// uses it to resolve a queried id to its model for hydration. Derived from the same
// business-data bundles emit ingests, so it can never disagree with the corpus.
function writeResourceGraph() {
  const map = {};
  for (const f of readdirSync(SRC_BUSINESS)) {
    if (!f.endsWith('.json')) continue;
    const doc = JSON.parse(readFileSync(join(SRC_BUSINESS, f), 'utf8'));
    for (const r of doc.business_data?.resources ?? []) {
      const ri = r.resourceinstance ?? {};
      if (ri.resourceinstanceid) map[ri.resourceinstanceid] = { graph_id: ri.graph_id, name: ri.name ?? null };
    }
  }
  writeFileSync(join(OUT, 'resource_graph.json'), JSON.stringify(map));
  console.log(`resource_graph.json  ${Object.keys(map).length} resources`);
}

const bin = emitBinary();
const dd = assembleDataDir();
mkdirSync(OUT, { recursive: true });

// Emit into a temp dir, then move artifacts into public/data. This keeps emit's
// `concept_catalog.parquet` from clobbering gen-sample-data's (query-tiles' own
// Settlement hierarchy) — the example models' catalog lands as a distinct
// `concept_catalog_models.parquet` for the concept demos to register.
const tmp = join(HERE, '.emit-out');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
console.log(`emit → ${tmp} → ${OUT}`);
execSync(`'${bin}' '${dd}' '${tmp}'`, { stdio: 'inherit' });
for (const f of readdirSync(tmp)) {
  const dest = f === 'concept_catalog.parquet' ? 'concept_catalog_models.parquet' : f;
  renameSync(join(tmp, f), join(OUT, dest));
}
rmSync(tmp, { recursive: true, force: true });
rmSync(dd, { recursive: true, force: true });
writeResourceGraph();
console.log('✓ emit corpus generated');
