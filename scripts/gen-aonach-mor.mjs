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

import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync, readdirSync, appendFileSync } from 'node:fs';
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
  // publish the committed basemap (seed) into public/data for the client to fetch
  writeFileSync(join(OUT, 'aonach_basemap.json'), readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'seed', 'basemap.json'), 'utf8'));
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

// ---------------------------------------------------------------------------
// Full corpus — realism pass: real footprints + zoning + correlated heavy tiles
// ---------------------------------------------------------------------------
// Reads scripts/seed/footprints.csv (real OSM centroids + levels + ward + zone) and
// the LLM-authored skeleton.json (per-zone conditional attribute distributions). Each
// building's typology/attributes are SAMPLED from its zone's distributions, so the
// joints are realistic (URM in low-income/coastal, steel in the industrial belt, RC
// high-rise + listed heritage in the core, retrofits skewed to money). Heavy nested
// tiles; real WGS84 coords; Morton-clustered; geo-partitioned into chunks + a manifest
// carrying each chunk's geo zone and dominant land-use. AONACH_REPLICAS clones each
// footprint with jitter to push toward GB. Idempotent (AONACH_REGEN=1).
async function genFull(conn) {
  const chunkDir = join(OUT, 'tiles_aonach_full');
  const manifestPath = join(OUT, 'aonach_full_manifest.json');
  if (existsSync(manifestPath) && !process.env.AONACH_REGEN) {
    console.log('full corpus present — skipping (AONACH_REGEN=1 to regenerate)');
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  }
  const REPLICAS = Math.max(1, Number(process.env.AONACH_REPLICAS || 1));
  const CHUNKS = 8, SHIFT = 9;
  const seedDir = join(dirname(fileURLToPath(import.meta.url)), 'seed');
  const skel = JSON.parse(readFileSync(join(seedDir, 'skeleton.json'), 'utf8'));
  const lines = readFileSync(join(seedDir, 'footprints.csv'), 'utf8').trim().split('\n');
  lines.shift();
  const foot = lines.map((l) => { const m = l.match(/^([^,]+),([^,]+),([^,]+),"([^"]*)",(.+)$/); return { lng: +m[1], lat: +m[2], levels: +m[3], ward: m[4], zone: m[5] }; });

  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const b of foot) { x0 = Math.min(x0, b.lng); y0 = Math.min(y0, b.lat); x1 = Math.max(x1, b.lng); y1 = Math.max(y1, b.lat); }
  const spread = (v) => { v &= 63; let r = 0; for (let i = 0; i < 6; i++) r |= ((v >> i) & 1) << (2 * i); return r; };
  const morton = (lng, lat) => { const gx = Math.min(63, Math.floor(((lng - x0) / (x1 - x0)) * 64)); const gy = Math.min(63, Math.floor(((lat - y0) / (y1 - y0)) * 64)); return spread(gx) | (spread(gy) << 1); };
  const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const pick = (weights, r) => { const es = Object.entries(weights); let s = es.reduce((a, [, w]) => a + w, 0) * r(); for (const [k, w] of es) { s -= w; if (s <= 0) return k; } return es[es.length - 1][0]; };
  const hstr = (s) => { let x = 0; for (let i = 0; i < s.length; i++) x = (Math.imul(x, 31) + s.charCodeAt(i)) | 0; return x >>> 0; };

  // stream NDJSON to disk so a large REPLICAS never accumulates rows in memory
  const tf = join(OUT, '_tiles.ndjson'), ef = join(OUT, '_edges.ndjson'), df = join(OUT, '_dmg.ndjson');
  writeFileSync(tf, ''); writeFileSync(ef, ''); writeFileSync(df, '');
  const bufT = [], bufE = [], bufD = [];
  const flush = (buf, file) => { if (buf.length) { appendFileSync(file, buf.join('\n') + '\n'); buf.length = 0; } };
  const emitT = (o) => { bufT.push(JSON.stringify(o)); if (bufT.length >= 20000) flush(bufT, tf); };
  const emitE = (o) => { bufE.push(JSON.stringify(o)); if (bufE.length >= 20000) flush(bufE, ef); };
  const emitD = (o) => { bufD.push(JSON.stringify(o)); if (bufD.length >= 5000) flush(bufD, df); };
  const retro = (rid, ev, method, year, acc, ck, chunk) => ({ resource_id: rid, descriptor_name: null, graph_id: GRAPH, nodegroup_id: 'retrofit', tileid: `${rid}-r${ev}`, parenttile_id: `${rid}-p`, sortorder: ev, concept_id: method, concept_ids: `["${method}"]`, q_ordered: year, acc, geo_min_lng: null, geo_min_lat: null, geo_max_lng: null, geo_max_lat: null, data: '{}', cluster_key: null, chunk });
  let idx = 0;
  for (const b of foot) {
    for (let rep = 0; rep < REPLICAS; rep++) {
      idx++;
      const rid = `am-${idx}`;
      const jl = rep === 0 ? b.lng : b.lng + ((hstr(rid + 'x') % 1000) / 1e6 - 5e-4);
      const jt = rep === 0 ? b.lat : b.lat + ((hstr(rid + 'y') % 1000) / 1e6 - 5e-4);
      const z = skel.zones[b.zone] || skel.zones.residential_mixed;
      const r = rng(hstr(rid));
      const gem = pick(z.gem, r);
      const ageBand = pick(z.age_band, r);
      const [ya, yb] = skel.age_years[ageBand];
      const year = ya + Math.floor(r() * (yb - ya + 1));
      const heritage = pick(z.heritage, r);
      const roles = [];
      const role = pick(z.roles, r); if (role !== '_none') roles.push(role);
      if (roles.length && r() < 0.08) { const r2 = pick(z.roles, r); if (r2 !== '_none' && r2 !== roles[0]) roles.push(r2); }
      const surge = z.surge_exposure;
      const storeys = z.storeys[0] + Math.floor(r() * (z.storeys[1] - z.storeys[0] + 1));
      const ck = morton(jl, jt), chunk = ck >> SHIFT;
      const concept_ids = JSON.stringify([gem, heritage, ...roles, `zone:${b.zone}`, `surge:${surge}`]);
      const d = 8e-5;
      const data = JSON.stringify({
        identity: { resource_id: rid, ward: b.ward, zone: b.zone, zone_label: z.label },
        structure: { gem_taxonomy: gem, gem_label: skel.gem_labels[gem] || gem, storeys, height_m: +(storeys * 3.2).toFixed(1), year_built: year, age_band: ageBand },
        heritage: { status: heritage },
        service_roles: roles,
        hazard: { surge_exposure: surge, seismic_vulnerability: gem.startsWith('MUR') ? 'high' : gem.startsWith('CR') ? 'moderate' : 'low' },
        geometry: { centroid: [+jl.toFixed(6), +jt.toFixed(6)], source: 'OSM footprint' },
        provenance: { source: 'real footprint + zone-conditioned synthesis', confidence: 'demonstration' },
        descriptors: { en: `${z.label} building in ${b.ward}`, ga: `Foirgneamh i ${b.ward}` },
      });
      emitT({ resource_id: rid, descriptor_name: `${b.ward} · ${skel.gem_labels[gem] || gem}`, graph_id: GRAPH, nodegroup_id: 'profile', tileid: `${rid}-p`, parenttile_id: null, sortorder: 0, concept_id: gem, concept_ids, q_ordered: year, acc: null, geo_min_lng: +(jl - d).toFixed(6), geo_min_lat: +(jt - d).toFixed(6), geo_max_lng: +(jl + d).toFixed(6), geo_max_lat: +(jt + d).toFixed(6), data, cluster_key: ck, chunk });
      emitE({ src_resource: rid, src_node: 'served_by', src_nodegroup: 'profile', src_tile: `${rid}-p`, target_resource: `sub-${hstr(b.ward) % 80}` });
      if (r() < z.retrofit_rate) {
        if (r() < 0.35) { emitT(retro(rid, 0, 'CR', 1994, false, ck, chunk)); emitT(retro(rid, 1, 'MUR', 1996, true, ck, chunk)); }
        else { const my = 1990 + Math.floor(r() * 20); emitT(retro(rid, 0, r() < 0.6 ? 'CR' : 'MUR', my, r() < 0.7, ck, chunk)); }
      }
      if (roles.includes('Hospital') && r() < 0.25) emitD({ resource_id: rid, descriptor_name: `${b.ward} hospital`, graph_id: GRAPH, nodegroup_id: 'damage', tileid: `${rid}-dmg`, parenttile_id: null, sortorder: 0, concept_id: null, concept_ids: '["damaged"]', q_ordered: null, acc: null, geo_min_lng: null, geo_min_lat: null, geo_max_lng: null, geo_max_lat: null, data: '{"damage":"structural — reported","reported":"now"}', cluster_key: null, chunk });
    }
  }

  flush(bufT, tf); flush(bufE, ef); flush(bufD, df);

  rmSync(chunkDir, { recursive: true, force: true }); mkdirSync(chunkDir, { recursive: true });
  await conn.run(`SET memory_limit='2GB'; SET preserve_insertion_order=false; SET temp_directory='${join(OUT, '_tmp')}';`);
  const cols = "{resource_id:'VARCHAR',descriptor_name:'VARCHAR',graph_id:'VARCHAR',nodegroup_id:'VARCHAR',tileid:'VARCHAR',parenttile_id:'VARCHAR',sortorder:'INTEGER',concept_id:'VARCHAR',concept_ids:'VARCHAR',q_ordered:'BIGINT',acc:'BOOLEAN',geo_min_lng:'DOUBLE',geo_min_lat:'DOUBLE',geo_max_lng:'DOUBLE',geo_max_lat:'DOUBLE',data:'VARCHAR',cluster_key:'UBIGINT',chunk:'INTEGER'}";
  const loadFile = async (name, file, colspec) => { await conn.run(`CREATE OR REPLACE TABLE ${name} AS SELECT * FROM read_json('${file}', columns=${colspec}, format='newline_delimited');`); rmSync(file, { force: true }); };
  await loadFile('all_tiles', tf, cols);
  await loadFile('ov', df, cols);
  await loadFile('eg', ef, "{src_resource:'VARCHAR',src_node:'VARCHAR',src_nodegroup:'VARCHAR',src_tile:'VARCHAR',target_resource:'VARCHAR'}");

  const files = [];
  for (let c = 0; c < CHUNKS; c++) {
    const rel = `tiles_aonach_full/chunk-${c}.parquet`, abs = join(OUT, rel);
    await conn.run(`COPY (SELECT ${TILE_COLS.join(', ')} FROM all_tiles WHERE chunk=${c} ORDER BY (geo_min_lng IS NULL), cluster_key) TO '${abs}' (FORMAT PARQUET, ROW_GROUP_SIZE 4096);`);
    const z = (await conn.runAndReadAll(`SELECT min(CASE WHEN path_in_schema='geo_min_lng' THEN stats_min::DOUBLE END) w, max(CASE WHEN path_in_schema='geo_max_lng' THEN stats_max::DOUBLE END) e, min(CASE WHEN path_in_schema='geo_min_lat' THEN stats_min::DOUBLE END) s, max(CASE WHEN path_in_schema='geo_max_lat' THEN stats_max::DOUBLE END) n, (max(row_group_id)+1) rgs FROM parquet_metadata('${abs}') WHERE path_in_schema LIKE 'geo_%'`)).getRowObjects()[0];
    const bcount = Number(Object.values((await conn.runAndReadAll(`SELECT count(*) FROM read_parquet('${abs}') WHERE nodegroup_id='profile'`)).getRowObjects()[0])[0]);
    const zmix = (await conn.runAndReadAll(`SELECT regexp_extract(concept_ids, 'zone:([a-z_]+)', 1) z, count(*) n FROM read_parquet('${abs}') WHERE nodegroup_id='profile' GROUP BY 1 ORDER BY n DESC LIMIT 1`)).getRowObjects()[0];
    // per-column compressed bytes (summed over row groups) — lets the reader account
    // projected-column fetch, not whole-file: a concept scan pulls concept_id, not `data`.
    const cb = (await conn.runAndReadAll(`SELECT path_in_schema col, sum(total_compressed_size)::BIGINT b FROM parquet_metadata('${abs}') GROUP BY 1`)).getRowObjects();
    const col_bytes = {}; for (const r of cb) col_bytes[r.col] = Number(r.b);
    files.push({ file: rel, bytes: statSync(abs).size, row_groups: z.rgs == null ? 0 : Number(z.rgs), geo: z.w == null ? null : { w: +z.w, e: +z.e, s: +z.s, n: +z.n }, buildings: bcount, zone: zmix ? zmix.z : null, col_bytes });
  }
  await conn.run(`COPY (SELECT * FROM eg ORDER BY src_node, target_resource) TO '${join(OUT, 'edges_aonach_full.parquet')}' (FORMAT PARQUET, ROW_GROUP_SIZE 8192);`);
  await conn.run(`COPY (SELECT ${TILE_COLS.join(', ')} FROM ov) TO '${join(OUT, 'overlay', 'tiles_aonach_full.parquet')}' (FORMAT PARQUET);`);

  const total = files.reduce((a, f) => a + f.bytes, 0);
  const buildings = files.reduce((a, f) => a + f.buildings, 0);
  const manifest = { graph: GRAPH, partition: 'geo (Morton cell)', chunks: files.length, buildings, total_bytes: total, row_group_size: 4096, edges: 'edges_aonach_full.parquet', overlay: 'overlay/tiles_aonach_full.parquet', files };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log(`aonach_full_manifest.json  ${files.length} chunks / ${buildings} buildings / ${(total / 1e6).toFixed(1)} MB · zones: ${files.map((f) => f.zone).join(',')}`);
  return { buildings, chunks: files.length, total_bytes: total };
}

main().catch((e) => { console.error(e); process.exit(1); });
