// Generate the Aonach Mór resilience worked-example snapshot as tile-row Parquet,
// the counterpart of ros-madair-emit's output, built here in JS (via node duckdb)
// so the docs stay a static site. The interactive pages run the SAME query IR the
// Rust `duck` backend compiles — here as hand-written DuckDB SQL over these files,
// pending a WASM/JS path for the compiler.
//
// Output → public/data/:
//   tiles_aonach.parquet            profile + retrofit + substation tiles
//   edges_aonach.parquet            served_by links (building → substation)
//   concept_catalog_aonach.parquet  GEM taxonomy + roles/heritage/method, DFS intervals
//   overlay/tiles_aonach.parquet    live Storm Bealtaine damage layer (sparse)
//
// Every label is fictional; the CRS is a rebranded local grid; Storm Bealtaine
// never happened. See example/aonach_mor in the sandbox for the real vocab this
// mirrors (GEM Building Taxonomy, ServiceRole, HazardType, HeritageStatus).

import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const GRAPH = 'aonach';
const sql = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => (v === null || v === undefined ? 'NULL' : String(v));
const bool = (v) => (v === null || v === undefined ? 'NULL' : v ? 'TRUE' : 'FALSE');

// ── concept catalog: GEM taxonomy (hierarchy) + flat role/heritage/method concepts
// DFS pre-order intervals; a subtree is [enter, leave]. Leaves sit inside a parent.
const CATALOG = [
  // GEM structural classes (the hierarchy DescendantOrSelfOf walks)
  ['CR', 1, 5, 'Reinforced concrete'],
  ['CR/LFM', 2, 2, 'RC — moment frame'],
  ['CR/LFINF', 3, 3, 'RC — infilled frame'],
  ['CR/LWAL', 4, 4, 'RC — shear wall'],
  ['CR/LPB', 5, 5, 'RC — precast'],
  ['MUR', 6, 9, 'Unreinforced masonry'],
  ['MUR+ADO', 7, 7, 'URM — adobe block'],
  ['MUR+CLBRS', 8, 8, 'URM — clay brick'],
  ['MUR+STDRE', 9, 9, 'URM — dressed stone'],
  ['S', 10, 11, 'Steel'],
  ['S/LFM', 11, 11, 'Steel — moment frame'],
  ['W', 12, 13, 'Wood'],
  ['W/LWAL', 13, 13, 'Wood — shear wall'],
  // retrofit method classes (reuse CR/MUR as the strengthening standard)
  // flat concepts — outside every GEM subtree interval, so they never false-match ⊑
  ['Listed', 30, 30, 'Listed'],
  ['Non-listed', 31, 31, 'Non-listed'],
  ['Candidate', 32, 32, 'Candidate'],
  ['Shelter', 40, 40, 'Shelter'],
  ['Hospital', 41, 41, 'Hospital'],
  ['School', 42, 42, 'School'],
  ['Fire station', 43, 43, 'Fire station'],
  ['Muster point', 44, 44, 'Muster point'],
];

// ── substations (edge targets + names)
const SUBS = [
  { id: 'sub-A', name: 'Fo-Stáisiún Ard', operational: true },
  { id: 'sub-B', name: 'Fo-Stáisiún Trá', operational: true },
  { id: 'sub-C', name: 'Fo-Stáisiún Baile Thoir', operational: false },
];

// ── buildings (the 10-asset slice). fp = [x,y,w,h] in a 100×60 local grid.
const B = [
  { id: 'bldg-001', name: 'Halla an Chósta', gem: 'MUR+STDRE', heritage: 'Listed', roles: ['Shelter'], year: 1890, sub: 'sub-A', fp: [14, 42, 7, 6],
    retro: [{ method: 'CR', year: 1995, acc: true }] },
  { id: 'bldg-002', name: 'Ospidéal Trá Bealtaine', gem: 'CR/LFM', heritage: 'Non-listed', roles: ['Hospital'], year: 1990, sub: 'sub-B', fp: [34, 42, 7, 6],
    retro: [] },
  { id: 'bldg-003', name: 'Ionad Éigeandála Cuain', gem: 'CR/LFINF', heritage: 'Non-listed', roles: ['Shelter', 'Hospital'], year: 1998, sub: 'sub-B', fp: [16, 53, 7, 5],
    retro: [] },
  { id: 'bldg-004', name: 'Áras Cuain', gem: 'MUR+CLBRS', heritage: 'Candidate', roles: ['School'], year: 1935, sub: 'sub-A', fp: [60, 20, 7, 6],
    retro: [{ method: 'CR', year: 1994, acc: false }, { method: 'MUR', year: 1996, acc: true }] },
  { id: 'bldg-005', name: 'Séipéal na Seanchrainn', gem: 'MUR+ADO', heritage: 'Listed', roles: ['Muster point'], year: 1905, sub: 'sub-C', fp: [80, 30, 7, 6],
    retro: [{ method: 'MUR', year: 1965, acc: true }] },
  { id: 'bldg-006', name: 'Scoil Bhaile an Iarthair', gem: 'W/LWAL', heritage: 'Non-listed', roles: ['Shelter', 'School'], year: 1972, sub: 'sub-A', fp: [70, 10, 8, 6],
    retro: [] },
  { id: 'bldg-007', name: 'Stáisiún Dóiteáin Thoir', gem: 'S/LFM', heritage: 'Non-listed', roles: ['Fire station'], year: 2005, sub: 'sub-C', fp: [86, 50, 7, 6],
    retro: [] },
  { id: 'bldg-008', name: 'Halla Baile na Cíoraí', gem: 'MUR+CLBRS', heritage: 'Listed', roles: ['Shelter'], year: 1928, sub: 'sub-B', fp: [26, 42, 6, 6],
    retro: [{ method: 'CR', year: 1999, acc: true }] },
  { id: 'bldg-009', name: 'Ospidéal an Aird', gem: 'CR/LWAL', heritage: 'Non-listed', roles: ['Hospital'], year: 2010, sub: 'sub-A', fp: [58, 14, 7, 6],
    retro: [] },
  { id: 'bldg-010', name: 'Muster Trá Theas', gem: 'CR/LFINF', heritage: 'Non-listed', roles: ['Shelter', 'Muster point'], year: 2001, sub: 'sub-B', fp: [36, 42, 7, 6],
    retro: [] },
];

// live Storm Bealtaine damage overlay (sparse — only what changed)
const DAMAGE = [
  { rid: 'bldg-002', report: 'structural — cracked column' },
  { rid: 'bldg-009', report: 'cladding loss' },
];

const TILE_COLS = ['resource_id', 'descriptor_name', 'graph_id', 'nodegroup_id', 'tileid', 'parenttile_id',
  'sortorder', 'concept_id', 'concept_ids', 'q_ordered', 'acc', 'geo_min_lng', 'geo_min_lat', 'geo_max_lng', 'geo_max_lat', 'data', 'cluster_key'];

function tileRow(o) {
  return `(${sql(o.resource_id)},${sql(o.descriptor_name)},${sql(GRAPH)},${sql(o.nodegroup_id)},${sql(o.tileid)},${sql(o.parenttile_id)},` +
    `${num(o.sortorder ?? 0)},${sql(o.concept_id)},${sql(o.concept_ids)},${num(o.q_ordered)},${bool(o.acc)},` +
    `${num(o.geo?.[0])},${num(o.geo?.[1])},${num(o.geo?.[2])},${num(o.geo?.[3])},${sql(o.data)},${num(o.cluster_key)})`;
}

// Morton (Z-order) key over 6-bit-quantised geo cells — the RM locality thesis: a
// row group of consecutive keys is a compact 2D region, so a spatial query's
// zone-map prunes to a handful of row groups.
const spread6 = (v) => `((${v}&1)|((${v}&2)<<1)|((${v}&4)<<2)|((${v}&8)<<3)|((${v}&16)<<4)|((${v}&32)<<5))`;
const MORTON = `(${spread6('gx6')} | (${spread6('gy6')}<<1))`;

async function createTiles(conn, table) {
  await conn.run(`CREATE OR REPLACE TABLE ${table} (
    resource_id VARCHAR, descriptor_name VARCHAR, graph_id VARCHAR, nodegroup_id VARCHAR,
    tileid VARCHAR, parenttile_id VARCHAR, sortorder INTEGER, concept_id VARCHAR, concept_ids VARCHAR,
    q_ordered BIGINT, acc BOOLEAN, geo_min_lng DOUBLE, geo_min_lat DOUBLE, geo_max_lng DOUBLE, geo_max_lat DOUBLE, data VARCHAR, cluster_key UBIGINT);`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join(OUT, 'overlay'), { recursive: true });
  const conn = await (await DuckDBInstance.create(':memory:')).connect();

  // ---- tiles ----
  const rows = [];
  const edges = [];
  for (const b of B) {
    const profileTile = `${b.id}-profile`;
    const geo = [b.fp[0], b.fp[1], b.fp[0] + b.fp[2], b.fp[1] + b.fp[3]];
    // profile tile: gem + heritage + roles promoted into concept_ids; year → q_ordered; footprint → bbox
    rows.push({
      resource_id: b.id, descriptor_name: b.name, nodegroup_id: 'profile', tileid: profileTile, sortorder: 0,
      concept_id: b.gem, concept_ids: JSON.stringify([b.gem, b.heritage, ...b.roles]),
      q_ordered: b.year, geo,
      data: JSON.stringify({ gem: b.gem, heritage: b.heritage, roles: b.roles, year: b.year, footprint: b.fp, served_by: b.sub }),
    });
    // served_by edge (building → substation)
    edges.push({ src_resource: b.id, src_node: 'served_by', src_nodegroup: 'profile', src_tile: profileTile, target_resource: b.sub });
    // retrofit tiles (n-cardinality): method class + year + accredited, all on one tile
    b.retro.forEach((e, i) => {
      rows.push({
        resource_id: b.id, descriptor_name: b.name, nodegroup_id: 'retrofit', tileid: `${b.id}-retro-${i}`,
        parenttile_id: profileTile, sortorder: i, concept_id: e.method, concept_ids: JSON.stringify([e.method]),
        q_ordered: e.year, acc: e.acc, data: JSON.stringify({ method: e.method, year: e.year, accredited: e.acc }),
      });
    });
  }
  // substation tiles (names + status, for the cascade view)
  for (const s of SUBS) {
    rows.push({
      resource_id: s.id, descriptor_name: s.name, nodegroup_id: 'sub', tileid: `${s.id}-t`, sortorder: 0,
      concept_id: s.operational ? 'operational' : 'down', concept_ids: JSON.stringify([s.operational ? 'operational' : 'down']),
      data: JSON.stringify({ name: s.name, operational: s.operational }),
    });
  }

  await createTiles(conn, 'stage');
  await conn.run(`INSERT INTO stage VALUES\n${rows.map(tileRow).join(',\n')};`);
  await conn.run(`COPY (SELECT ${TILE_COLS.join(', ')} FROM stage ORDER BY resource_id, nodegroup_id, sortorder)
    TO '${join(OUT, 'tiles_aonach.parquet')}' (FORMAT PARQUET);`);
  console.log(`tiles_aonach.parquet  ${rows.length} tiles`);

  // ---- edges ----
  await conn.run(`CREATE OR REPLACE TABLE edges (src_resource VARCHAR, src_node VARCHAR, src_nodegroup VARCHAR, src_tile VARCHAR, target_resource VARCHAR);`);
  await conn.run(`INSERT INTO edges VALUES\n${edges.map((e) => `(${sql(e.src_resource)},${sql(e.src_node)},${sql(e.src_nodegroup)},${sql(e.src_tile)},${sql(e.target_resource)})`).join(',\n')};`);
  await conn.run(`COPY (SELECT * FROM edges ORDER BY src_node, target_resource) TO '${join(OUT, 'edges_aonach.parquet')}' (FORMAT PARQUET);`);
  console.log(`edges_aonach.parquet  ${edges.length} links`);

  // ---- concept catalog ----
  await conn.run(`CREATE OR REPLACE TABLE cat (concept_id VARCHAR, dfs_enter BIGINT, dfs_leave BIGINT, label VARCHAR);`);
  await conn.run(`INSERT INTO cat VALUES\n${CATALOG.map((c) => `(${sql(c[0])},${num(c[1])},${num(c[2])},${sql(c[3])})`).join(',\n')};`);
  await conn.run(`COPY (SELECT * FROM cat ORDER BY dfs_enter) TO '${join(OUT, 'concept_catalog_aonach.parquet')}' (FORMAT PARQUET);`);
  console.log(`concept_catalog_aonach.parquet  ${CATALOG.length} concepts`);

  // ---- overlay (live damage) ----
  await createTiles(conn, 'ov');
  const ovRows = DAMAGE.map((d) => {
    const b = B.find((x) => x.id === d.rid);
    return tileRow({ resource_id: d.rid, descriptor_name: b.name, nodegroup_id: 'damage', tileid: `${d.rid}-damage`, sortorder: 0,
      concept_ids: JSON.stringify(['damaged']), data: JSON.stringify({ damage: d.report, reported: 'now' }) });
  });
  await conn.run(`INSERT INTO ov VALUES\n${ovRows.join(',\n')};`);
  await conn.run(`COPY (SELECT ${TILE_COLS.join(', ')} FROM ov) TO '${join(OUT, 'overlay', 'tiles_aonach.parquet')}' (FORMAT PARQUET);`);
  console.log(`overlay/tiles_aonach.parquet  ${ovRows.length} damage tiles`);

  const full = await genFull(conn);

  writeFileSync(join(OUT, 'aonach_meta.json'), JSON.stringify({ graph: GRAPH, buildings: B.length, subs: SUBS.length, full }, null, 0));
}

// City-scale synthesis, written CHUNKED: the corpus is partitioned into geo cells
// (the top Morton bits), each its own Parquet file under any host's per-file cap,
// plus a MANIFEST summarising every chunk's geo zone. A query reads the manifest
// (KB), prunes to the chunks it needs, and range-fetches only their row groups — so
// total corpus size is unbounded while each file stays small (the RM manifest+chunk
// design). Same schema as the sample, so every worked example runs unchanged.
//   Size via AONACH_ROWS (default modest, so a build here is quick). For a genuine
//   ~1 GB set AONACH_ROWS≈20000000 and run once (heavier box / CI). Idempotent:
//   skips if the manifest exists unless AONACH_REGEN=1.
async function genFull(conn) {
  const N = Number(process.env.AONACH_ROWS || 1_000_000);
  const CHUNKS = 8, SHIFT = 9; // 12-bit Morton >> 9 → top 3 bits → 8 geo-contiguous chunks
  const chunkDir = join(OUT, 'tiles_aonach_full');
  const manifestPath = join(OUT, 'aonach_full_manifest.json');
  if (existsSync(manifestPath) && !process.env.AONACH_REGEN) {
    console.log('full corpus present — skipping (set AONACH_REGEN=1 to regenerate)');
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  }
  rmSync(chunkDir, { recursive: true, force: true });
  mkdirSync(chunkDir, { recursive: true });
  await conn.run(`SET memory_limit='1GB'; SET preserve_insertion_order=false; SET temp_directory='${join(OUT, '_tmp')}';`);

  const gems = ['CR/LFM', 'CR/LFINF', 'CR/LWAL', 'CR/LPB', 'MUR+ADO', 'MUR+CLBRS', 'MUR+STDRE', 'S/LFM', 'W/LWAL'];
  const wards = ['Baile Thoir', 'Baile an Iarthair', 'Baile na Cíoraí', 'Abhainn Chaol', 'Abhainn Rua',
    'Abhainn Thuaidh', 'Ceannkarai', 'Kesarnagar', 'Muthugaran', 'Tharainagar', 'Vellaimedu', 'Aranmedu',
    'Trá Bealtaine', 'An tArd', 'Cé an Rí', 'Ceantar Theas', 'Cuan Thoir', 'Machaire Fada'];
  const lit = (a) => `(${JSON.stringify(a).replace(/"/g, "'")})`;
  const role1 = `CASE (hash(i*13)%14) WHEN 0 THEN 'Shelter' WHEN 1 THEN 'Hospital' WHEN 2 THEN 'School' WHEN 3 THEN 'Fire station' WHEN 4 THEN 'Muster point' WHEN 5 THEN 'Shelter' ELSE NULL END`;
  await conn.run(`CREATE OR REPLACE TABLE bldgs AS
    WITH base AS (
      SELECT i,
        ${lit(gems)}[((hash(i*2654435761)%9)+1)::INT] AS gem,
        (['Listed','Non-listed','Non-listed','Non-listed','Non-listed','Candidate'])[((hash(i*40503)%6)+1)::INT] AS heritage,
        CAST(1850 + (hash(i*97)%171) AS BIGINT) AS yr,
        ${role1} AS role1,
        ${lit(wards)}[((hash(i*19)%${wards.length})+1)::INT] AS ward,
        CAST(hash(i*31)%100 AS DOUBLE) AS gx, CAST(hash(i*57)%60 AS DOUBLE) AS gy,
        LEAST(63, ((hash(i*31)%100)*64/100)::INT) AS gx6, LEAST(63, ((hash(i*57)%60)*64/60)::INT) AS gy6,
        'sub-'|| CAST(hash(i*71)%80 AS INT) AS sub
      FROM range(${N}) t(i)),
    r AS (
      SELECT *, CASE WHEN role1 IS NOT NULL AND hash(i*23)%18=0
                     THEN (CASE WHEN role1='Shelter' THEN 'Hospital' ELSE 'Shelter' END) END AS role2
      FROM base)
    SELECT 'bldg-f'||i AS resource_id, ward||' Asset '||i AS descriptor_name, 'aonach' AS graph_id,
      'profile' AS nodegroup_id, 'bldg-f'||i||'-profile' AS tileid, NULL AS parenttile_id, 0 AS sortorder,
      gem AS concept_id,
      '["'||gem||'","'||heritage||'"'||coalesce(',"'||role1||'"','')||coalesce(',"'||role2||'"','')||']' AS concept_ids,
      yr AS q_ordered, NULL::BOOLEAN AS acc,
      gx AS geo_min_lng, gy AS geo_min_lat, gx+1.2 AS geo_max_lng, gy+1.0 AS geo_max_lat,
      '{"gem":"'||gem||'","heritage":"'||heritage||'","year":'||yr||',"ward":"'||ward||'","served_by":"'||sub||'"}' AS data,
      ${MORTON} AS cluster_key, (${MORTON} >> ${SHIFT})::INT AS chunk, sub
    FROM r;`);
  // ~30% carry one retrofit event; the two-event "paper retrofit" trap on a disjoint
  // 10% slice (OnTile excludes, All keeps). Both inherit their building's chunk.
  await conn.run(`CREATE OR REPLACE TABLE bldgs_retro AS
    SELECT resource_id, descriptor_name, 'aonach' AS graph_id, 'retrofit' AS nodegroup_id,
      resource_id||'-retro-0' AS tileid, resource_id||'-profile' AS parenttile_id, 0 AS sortorder,
      CASE WHEN hash(resource_id||'m')%2=0 THEN 'CR' ELSE 'MUR' END AS concept_id,
      '["'||(CASE WHEN hash(resource_id||'m')%2=0 THEN 'CR' ELSE 'MUR' END)||'"]' AS concept_ids,
      CAST(1970 + (hash(resource_id||'y')%50) AS BIGINT) AS q_ordered, (hash(resource_id||'a')%2=0) AS acc,
      NULL::DOUBLE AS geo_min_lng, NULL::DOUBLE AS geo_min_lat, NULL::DOUBLE AS geo_max_lng, NULL::DOUBLE AS geo_max_lat, '{}' AS data, NULL::UBIGINT AS cluster_key, chunk
    FROM bldgs WHERE hash(resource_id||'r')%10 < 3;`);
  await conn.run(`CREATE OR REPLACE TABLE bldgs_trap AS
    SELECT resource_id, descriptor_name, 'aonach' AS graph_id, 'retrofit' AS nodegroup_id,
      resource_id||'-retro-'||ev AS tileid, resource_id||'-profile' AS parenttile_id, ev AS sortorder,
      CASE WHEN ev=0 THEN 'CR' ELSE 'MUR' END AS concept_id,
      CASE WHEN ev=0 THEN '["CR"]' ELSE '["MUR"]' END AS concept_ids,
      (CASE WHEN ev=0 THEN 1994 ELSE 1996 END)::BIGINT AS q_ordered, (ev=1) AS acc,
      NULL::DOUBLE AS geo_min_lng, NULL::DOUBLE AS geo_min_lat, NULL::DOUBLE AS geo_max_lng, NULL::DOUBLE AS geo_max_lat, '{}' AS data, NULL::UBIGINT AS cluster_key, chunk
    FROM bldgs, (SELECT 0 AS ev UNION ALL SELECT 1) WHERE hash(resource_id||'r')%10 = 7;`);
  await conn.run(`CREATE OR REPLACE TABLE all_tiles AS
    SELECT ${TILE_COLS.join(', ')}, chunk FROM bldgs
    UNION ALL SELECT ${TILE_COLS.join(', ')}, chunk FROM bldgs_retro
    UNION ALL SELECT ${TILE_COLS.join(', ')}, chunk FROM bldgs_trap;`);

  // one Parquet per geo chunk + a manifest of each chunk's geo zone (the file-level zone-map)
  const files = [];
  for (let c = 0; c < CHUNKS; c++) {
    const rel = `tiles_aonach_full/chunk-${c}.parquet`;
    const abs = join(OUT, rel);
    await conn.run(`COPY (SELECT ${TILE_COLS.join(', ')} FROM all_tiles WHERE chunk=${c} ORDER BY (geo_min_lng IS NULL), cluster_key)
      TO '${abs}' (FORMAT PARQUET, ROW_GROUP_SIZE 2048);`);
    const z = (await conn.runAndReadAll(`SELECT
        min(CASE WHEN path_in_schema='geo_min_lng' THEN stats_min::DOUBLE END) w,
        max(CASE WHEN path_in_schema='geo_max_lng' THEN stats_max::DOUBLE END) e,
        min(CASE WHEN path_in_schema='geo_min_lat' THEN stats_min::DOUBLE END) s,
        max(CASE WHEN path_in_schema='geo_max_lat' THEN stats_max::DOUBLE END) n,
        (max(row_group_id)+1) rgs FROM parquet_metadata('${abs}') WHERE path_in_schema LIKE 'geo_%'`)).getRowObjects()[0];
    const buildings = Number(Object.values((await conn.runAndReadAll(`SELECT count(*) FROM read_parquet('${abs}') WHERE nodegroup_id='profile'`)).getRowObjects()[0])[0]);
    files.push({ file: rel, bytes: statSync(abs).size, row_groups: z.rgs == null ? 0 : Number(z.rgs),
      geo: z.w == null ? null : { w: +z.w, e: +z.e, s: +z.s, n: +z.n }, buildings });
  }
  // edges + overlay stay single files (small at this scale)
  await conn.run(`COPY (SELECT resource_id AS src_resource, 'served_by' AS src_node, 'profile' AS src_nodegroup,
      resource_id||'-profile' AS src_tile, sub AS target_resource FROM bldgs ORDER BY src_node, target_resource)
    TO '${join(OUT, 'edges_aonach_full.parquet')}' (FORMAT PARQUET, ROW_GROUP_SIZE 8192);`);
  await conn.run(`COPY (SELECT resource_id, descriptor_name, 'aonach' AS graph_id, 'damage' AS nodegroup_id,
      resource_id||'-damage' AS tileid, NULL AS parenttile_id, 0 AS sortorder, NULL AS concept_id,
      '["damaged"]' AS concept_ids, NULL::BIGINT AS q_ordered, NULL::BOOLEAN AS acc,
      NULL::DOUBLE AS geo_min_lng, NULL::DOUBLE AS geo_min_lat, NULL::DOUBLE AS geo_max_lng, NULL::DOUBLE AS geo_max_lat, '{"damage":"reported","reported":"now"}' AS data, NULL::UBIGINT AS cluster_key
      FROM bldgs WHERE concept_ids LIKE '%"Hospital"%' AND hash(resource_id||'d')%4=0)
    TO '${join(OUT, 'overlay', 'tiles_aonach_full.parquet')}' (FORMAT PARQUET);`);

  const total = files.reduce((a, f) => a + f.bytes, 0);
  const buildings = files.reduce((a, f) => a + f.buildings, 0);
  const manifest = { graph: GRAPH, partition: 'geo (Morton cell)', chunks: files.length, buildings,
    total_bytes: total, row_group_size: 2048, edges: 'edges_aonach_full.parquet',
    overlay: 'overlay/tiles_aonach_full.parquet', files };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log(`aonach_full_manifest.json  ${files.length} chunks / ${buildings} buildings / ${(total / 1e6).toFixed(1)} MB total`);
  return { buildings, chunks: files.length, total_bytes: total };
}

main().catch((e) => { console.error(e); process.exit(1); });
