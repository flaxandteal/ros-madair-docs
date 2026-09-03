// Generate the live-demo Parquet corpus with REAL DuckDB, using the exact frozen
// tile-row schema that `ros-madair-emit`'s `parquet` module writes
// (crates/ros-madair-emit/src/parquet.rs). The browser demo then queries these
// files with duckdb-wasm over HTTP range reads — the same engine that wrote them.
//
// Output (committed to public/data/, served same-origin by the static site):
//   tiles_place.parquet      one row per tile, clustered by the Z-order key
//   concept_catalog.parquet  DFS-interval concept catalog (DescendantOrSelfOf)
//
// The corpus is a small fictional heritage-place set around Chennai geography,
// echoing the example/aonach_mor demo. Deterministic (seeded) so rebuilds are
// byte-stable.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'public', 'data');

// ---- concept hierarchy (matches parquet.rs build_concept_catalog: pre-order,
// children sorted by id) --------------------------------------------------
// heritage-place ┬ monument ┬ church
//                │          └ megalith
//                └ settlement ┬ town
//                             └ village
const CATALOG = [
  { concept_id: 'heritage-place', dfs_enter: 0, dfs_leave: 6, label: 'Heritage Place' },
  { concept_id: 'monument',       dfs_enter: 1, dfs_leave: 3, label: 'Monument' },
  { concept_id: 'church',         dfs_enter: 2, dfs_leave: 2, label: 'Church' },
  { concept_id: 'megalith',       dfs_enter: 3, dfs_leave: 3, label: 'Megalith' },
  { concept_id: 'settlement',     dfs_enter: 4, dfs_leave: 6, label: 'Settlement' },
  { concept_id: 'town',           dfs_enter: 5, dfs_leave: 5, label: 'Town' },
  { concept_id: 'village',        dfs_enter: 6, dfs_leave: 6, label: 'Village' },
];
const LEAVES = ['church', 'megalith', 'town', 'village'];
const LABEL = Object.fromEntries(CATALOG.map((c) => [c.concept_id, c.label]));

// ---- Z-order cluster key — a faithful port of parquet.rs -----------------
function spread32(x) {
  let v = BigInt(x >>> 0) & 0xffffffffn;
  v = (v | (v << 16n)) & 0x0000ffff0000ffffn;
  v = (v | (v << 8n)) & 0x00ff00ff00ff00ffn;
  v = (v | (v << 4n)) & 0x0f0f0f0f0f0f0f0fn;
  v = (v | (v << 2n)) & 0x3333333333333333n;
  v = (v | (v << 1n)) & 0x5555555555555555n;
  return v;
}
const morton2 = (a, b) => spread32(a) | (spread32(b) << 1n);
function geoCell(cx, cy) {
  const nx = Math.min(1, Math.max(0, (cx + 180) / 360));
  const ny = Math.min(1, Math.max(0, (cy + 90) / 180));
  const gx = Math.round(nx * 65535);
  const gy = Math.round(ny * 65535);
  return Number(morton2(gx, gy) & 0xffffffffn);
}
function nameCode(name) {
  const norm = [...name.trim().toLowerCase()].filter((ch) => /[a-z0-9 ]/.test(ch));
  let code = 0;
  for (let i = 0; i < 4; i++) code = ((code << 8) | (norm[i]?.charCodeAt(0) ?? 0)) >>> 0;
  return code;
}
const clusterKey = (cx, cy, name) => morton2(geoCell(cx, cy), nameCode(name)); // BigInt (UBIGINT)

// ---- deterministic PRNG --------------------------------------------------
let seed = 0x9e3779b9;
function rand() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const NAME_A = ['Kesar', 'Vellai', 'Aran', 'Muthu', 'Tharai', 'Neela', 'Poovar', 'Kadal', 'Marai', 'Ceann'];
const NAME_B = ['kottai', 'malai', 'theru', 'nagar', 'kulam', 'palli', 'medu', 'karai', 'thurai', 'garan'];
const EPOCH = Date.UTC(1970, 0, 1);
const dayNum = (y, m, d) => Math.floor((Date.UTC(y, m - 1, d) - EPOCH) / 86400000);

function buildTiles(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const concept = pick(LEAVES);
    const name = `${pick(NAME_A)}${pick(NAME_B)}`;
    // Chennai-ish extent: lng 80.10–80.35, lat 12.85–13.25.
    const cx = 80.1 + rand() * 0.25;
    const cy = 12.85 + rand() * 0.4;
    const half = 0.002 + rand() * 0.004;
    const bbox = [cx - half, cy - half, cx + half, cy + half];
    const year = 1650 + Math.floor(rand() * 375); // 1650–2024
    const month = 1 + Math.floor(rand() * 12);
    const day = 1 + Math.floor(rand() * 28);
    const population = concept === 'town' ? 5000 + Math.floor(rand() * 90000)
      : concept === 'village' ? 200 + Math.floor(rand() * 4000)
      : 0;
    const rid = `r${String(i).padStart(4, '0')}`;
    const data = {
      name,
      place_type: concept,
      established: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      population,
      geometry: { type: 'Point', coordinates: [Number(cx.toFixed(5)), Number(cy.toFixed(5))] },
    };
    rows.push({
      resource_id: rid,
      descriptor_name: name,
      nodegroup_id: 'place_summary',
      tileid: `t${String(i).padStart(4, '0')}`,
      parenttile_id: null,
      sortorder: 0,
      cluster_key: clusterKey(cx, cy, name),
      ng_order: 0,
      q_ordered: dayNum(year, month, day),
      concept_id: concept,
      link_targets: null,
      geo_min_lng: bbox[0], geo_min_lat: bbox[1], geo_max_lng: bbox[2], geo_max_lat: bbox[3],
      data: JSON.stringify(data),
    });
  }
  return rows;
}

const sql = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v));

async function main() {
  mkdirSync(OUT, { recursive: true });

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  // The frozen tile-row schema (parquet.rs `CREATE TABLE stage`, minus the
  // stage-only model_slug routing column that the COPY excludes).
  await conn.run(`CREATE TABLE tiles (
    resource_id VARCHAR, descriptor_name VARCHAR, nodegroup_id VARCHAR,
    tileid VARCHAR, parenttile_id VARCHAR, sortorder INTEGER,
    cluster_key UBIGINT, ng_order BIGINT, q_ordered BIGINT,
    concept_id VARCHAR, link_targets VARCHAR,
    geo_min_lng DOUBLE, geo_min_lat DOUBLE, geo_max_lng DOUBLE, geo_max_lat DOUBLE,
    data VARCHAR);`);

  const rows = buildTiles(6000);
  const cols = ['resource_id','descriptor_name','nodegroup_id','tileid','parenttile_id','sortorder','cluster_key','ng_order','q_ordered','concept_id','link_targets','geo_min_lng','geo_min_lat','geo_max_lng','geo_max_lat','data'];
  const values = rows.map((r) => `(${cols.map((c) => sql(r[c])).join(',')})`).join(',\n');
  await conn.run(`INSERT INTO tiles VALUES\n${values};`);

  // COPY ... ORDER BY cluster_key — the same external sort parquet.rs runs. A
  // small ROW_GROUP_SIZE gives several row groups so the zone-map prune on the
  // geo/cluster columns is real, not a single-group no-op.
  await conn.run(`COPY (SELECT ${cols.join(', ')} FROM tiles ORDER BY cluster_key, resource_id, nodegroup_id, sortorder)
    TO '${join(OUT, 'tiles_place.parquet')}' (FORMAT PARQUET, ROW_GROUP_SIZE 2048);`);

  await conn.run(`CREATE TABLE catalog (concept_id VARCHAR, dfs_enter BIGINT, dfs_leave BIGINT, label VARCHAR);`);
  await conn.run(`INSERT INTO catalog VALUES ${CATALOG.map((c) => `(${sql(c.concept_id)},${c.dfs_enter},${c.dfs_leave},${sql(c.label)})`).join(',')};`);
  await conn.run(`COPY (SELECT concept_id, dfs_enter, dfs_leave, label FROM catalog ORDER BY dfs_enter)
    TO '${join(OUT, 'concept_catalog.parquet')}' (FORMAT PARQUET);`);

  const meta = await conn.runAndReadAll(
    `SELECT num_row_groups FROM parquet_file_metadata('${join(OUT, 'tiles_place.parquet')}');`,
  );
  const rgs = meta.getRows()[0][0];
  console.log(`wrote ${rows.length} tile rows in ${rgs} row groups → public/data/tiles_place.parquet`);
  console.log(`wrote ${CATALOG.length} concept rows → public/data/concept_catalog.parquet`);
  void LABEL;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
