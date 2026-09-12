// Ground-truth performance suite for the chunked full-corpus substrate.
//
// Measures what a query ACTUALLY pulls over the wire — the same methodology as the
// browser network tab, minus the browser. A local Range-capable HTTP server counts
// the bytes and requests it serves; node-duckdb (httpfs, the same engine family as
// duckdb-wasm) runs each demo tab's REAL statement sequence against it. Because it
// executes the actual SQL, it can't drift from a model, and it captures the full
// cost: multiple statements per tab, every projected column, footer reads, and
// row-group pruning by the zone-map.
//
// Each scenario is measured COLD (fresh connection → footers fetched once), mirroring
// a fresh tab click. Geo scenarios get the manifest chunk-prune first (only
// overlapping chunk URLs are handed to read_parquet), exactly like the demo.
//
//   node scripts/perf-suite.mjs [--threshold=10] [--port=8899]

import { createServer } from 'node:http';
import { createReadStream, statSync, readFileSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as duckdb from '@duckdb/node-api';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'data');
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1] || 8899);
const THRESH = Number((process.argv.find((a) => a.startsWith('--threshold=')) || '').split('=')[1] || 10);

const manifest = JSON.parse(readFileSync(join(OUT, 'aonach_full_manifest.json'), 'utf8'));
const CORPUS = manifest.files.reduce((a, f) => a + f.bytes, 0);

// ── instrumented Range server ────────────────────────────────────────────────────
let bytes = 0, requests = 0;
const server = createServer((req, res) => {
  const path = normalize(join(OUT, decodeURIComponent(req.url.split('?')[0])));
  if (!path.startsWith(OUT)) { res.writeHead(403).end(); return; }
  let size; try { size = statSync(path).size; } catch { res.writeHead(404).end(); return; }
  requests++;
  const range = req.headers.range;
  if (req.method === 'HEAD') { res.writeHead(200, { 'Accept-Ranges': 'bytes', 'Content-Length': size }).end(); return; }
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = +m[1], end = m[2] ? +m[2] : size - 1;
    const len = end - start + 1; bytes += len;
    res.writeHead(206, { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': len });
    createReadStream(path, { start, end }).pipe(res);
  } else { bytes += size; res.writeHead(200, { 'Accept-Ranges': 'bytes', 'Content-Length': size }); createReadStream(path).pipe(res); }
});
await new Promise((r) => server.listen(PORT, r));
const BASE = `http://localhost:${PORT}`;

// ── url helpers + tier-1 (manifest) chunk prune ─────────────────────────────────
const CAT = `read_parquet('${BASE}/concept_catalog_aonach.parquet')`;
const OV = `read_parquet('${BASE}/${manifest.overlay}')`;
const EG = `read_parquet('${BASE}/${manifest.edges}')`;
function tiles(box) {
  const hit = (g) => g && (!box || !(g.e < box[0] || g.w > box[2] || g.n < box[1] || g.s > box[3]));
  const kept = manifest.files.filter((f) => !box || hit(f.geo));
  return { sql: `read_parquet([${kept.map((f) => `'${BASE}/${f.file}'`).join(',')}])`, chunks: kept.length };
}

// flood extent: same 0.28 × 0.30 proportion as the demo, centred on the corpus
const gw = Math.min(...manifest.files.map((f) => f.geo.w)), ge = Math.max(...manifest.files.map((f) => f.geo.e));
const gs = Math.min(...manifest.files.map((f) => f.geo.s)), gn = Math.max(...manifest.files.map((f) => f.geo.n));
const cx = (gw + ge) / 2, cy = (gs + gn) / 2, bw = (ge - gw) * 0.28, bh = (gn - gs) * 0.30;
const EXT = [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2];
const missUnion = `(geo_min_lng>${EXT[2]} OR geo_max_lng<${EXT[0]} OR geo_min_lat>${EXT[3]} OR geo_max_lat<${EXT[1]})`;
const hitExt = `NOT ${missUnion}`;

// ── scenarios: each tab's real statement sequence ───────────────────────────────
// `stmts(T)` returns the statements the tab fires; the first is the "primary" result.
const SCENARIOS = [
  { name: 'Filter · masonry (gem⊑MUR)', box: null, stmts: (T) => [
    `SELECT count(*) FROM (SELECT DISTINCT x.resource_id FROM ${T} x JOIN ${CAT} c ON c.concept_id=x.concept_id WHERE x.nodegroup_id='profile' AND c.dfs_enter BETWEEN (SELECT dfs_enter FROM ${CAT} WHERE concept_id='MUR') AND (SELECT dfs_leave FROM ${CAT} WHERE concept_id='MUR'))`,
    `SELECT count(*) FROM ${T} WHERE nodegroup_id='profile'`,
    `SELECT y.descriptor_name, y.concept_id, y.concept_ids, y.q_ordered FROM ${T} y JOIN (SELECT DISTINCT x.resource_id FROM ${T} x JOIN ${CAT} c ON c.concept_id=x.concept_id WHERE x.nodegroup_id='profile' AND c.dfs_enter BETWEEN (SELECT dfs_enter FROM ${CAT} WHERE concept_id='MUR') AND (SELECT dfs_leave FROM ${CAT} WHERE concept_id='MUR')) m ON m.resource_id=y.resource_id WHERE y.nodegroup_id='profile' ORDER BY y.descriptor_name LIMIT 8` ] },
  { name: 'Filter · masonry+listed+≤1970', box: null, stmts: (T) => {
    const inner = `SELECT DISTINCT x.resource_id FROM ${T} x JOIN ${CAT} c ON c.concept_id=x.concept_id WHERE x.nodegroup_id='profile' AND c.dfs_enter BETWEEN (SELECT dfs_enter FROM ${CAT} WHERE concept_id='MUR') AND (SELECT dfs_leave FROM ${CAT} WHERE concept_id='MUR')\nINTERSECT\nSELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='profile' AND concept_ids LIKE '%"Listed"%'\nINTERSECT\nSELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='profile' AND q_ordered<=1970`;
    return [ `SELECT count(*) FROM (${inner})`, `SELECT count(*) FROM ${T} WHERE nodegroup_id='profile'`,
      `SELECT y.descriptor_name, y.concept_id, y.concept_ids, y.q_ordered FROM ${T} y JOIN (${inner}) m ON m.resource_id=y.resource_id WHERE y.nodegroup_id='profile' ORDER BY y.descriptor_name LIMIT 8` ]; } },
  { name: 'OnTile · retrofit (same event)', box: null, stmts: (T) => [
    `SELECT count(DISTINCT resource_id) FROM ${T} WHERE nodegroup_id='retrofit' AND concept_id='CR' AND q_ordered BETWEEN 1990 AND 2000 AND acc=TRUE`,
    `SELECT descriptor_name, concept_id, q_ordered, acc FROM ${T} WHERE nodegroup_id='retrofit' ORDER BY resource_id, q_ordered LIMIT 8` ] },
  { name: 'All · retrofit (anywhere)', box: null, stmts: (T) => [
    `SELECT count(*) FROM (SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='retrofit' AND concept_id='CR' INTERSECT SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='retrofit' AND q_ordered BETWEEN 1990 AND 2000 INTERSECT SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='retrofit' AND acc=TRUE)`,
    `SELECT descriptor_name, concept_id, q_ordered, acc FROM ${T} WHERE nodegroup_id='retrofit' ORDER BY resource_id, q_ordered LIMIT 8` ] },
  { name: 'Spatial · flood bbox (exact)', box: EXT, stmts: (T) => [
    `SELECT count(*) FROM ${T} WHERE nodegroup_id='profile' AND ${hitExt}` ] },
  { name: 'Spatial · dry shelters Not(Bbox)', box: EXT, stmts: (T) => [
    `SELECT count(*) FROM ${T} WHERE nodegroup_id='profile' AND concept_ids LIKE '%"Shelter"%' AND NOT (${hitExt})` ] },
  { name: 'Cascade · cited_by(substation)', box: null, stmts: (T) => [
    `SELECT DISTINCT target_resource FROM ${EG} WHERE src_node='served_by' ORDER BY target_resource LIMIT 12`,
    `SELECT count(*) FROM (SELECT DISTINCT src_resource FROM ${EG} WHERE src_node='served_by' AND target_resource='sub-1')`,
    `SELECT y.descriptor_name, y.concept_ids FROM ${T} y JOIN (SELECT DISTINCT src_resource AS resource_id FROM ${EG} WHERE src_node='served_by' AND target_resource='sub-1') d ON d.resource_id=y.resource_id WHERE y.nodegroup_id='profile' LIMIT 8` ] },
  { name: 'Overlay · hospitals w/ damage', box: null, stmts: (T) => [
    `SELECT count(*) FROM ${T} WHERE nodegroup_id='profile' AND concept_ids LIKE '%"Hospital"%'`,
    `SELECT count(DISTINCT d.resource_id) FROM ${OV} d JOIN ${T} y ON y.resource_id=d.resource_id AND y.nodegroup_id='profile' AND y.concept_ids LIKE '%"Hospital"%' WHERE d.nodegroup_id='damage'`,
    `SELECT y.descriptor_name, d.data FROM ${OV} d JOIN ${T} y ON y.resource_id=d.resource_id AND y.nodegroup_id='profile' AND y.concept_ids LIKE '%"Hospital"%' WHERE d.nodegroup_id='damage' LIMIT 8` ] },
];

// ── run each scenario cold ──────────────────────────────────────────────────────
const mb = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)}MB` : `${(b / 1e3).toFixed(0)}KB`);
const pad = (v, w) => String(v).padEnd(w);
console.log(`\nCorpus ${(CORPUS / 1e6).toFixed(0)}MB · ${manifest.files.length} chunks · ${manifest.files.reduce((a, f) => a + f.buildings, 0).toLocaleString()} assets  (each scenario measured cold over HTTP Range)\n`);
console.log(pad('scenario', 34) + pad('chunks', 8) + pad('fetch', 9) + pad('% corpus', 10) + pad('reqs', 7) + 'primary result');
console.log('─'.repeat(90));
const flagged = [];
for (const s of SCENARIOS) {
  const inst = await duckdb.DuckDBInstance.create(':memory:'); // fresh → cold cache
  const conn = await inst.connect();
  await conn.run('LOAD httpfs;');
  const { sql: T, chunks } = tiles(s.box);
  bytes = 0; requests = 0;
  let primary = '';
  const stmts = s.stmts(T);
  for (let i = 0; i < stmts.length; i++) {
    const r = await (await conn.run(stmts[i])).getRowObjects();
    if (i === 0) primary = r.length === 1 ? Number(Object.values(r[0])[0]).toLocaleString() : `${r.length} rows`;
  }
  conn.closeSync?.(); inst.closeSync?.();
  const pct = 100 * bytes / CORPUS;
  if (pct >= THRESH) flagged.push({ s, pct, bytes, requests });
  console.log(pad(s.name, 34) + pad(`${chunks}/${manifest.files.length}`, 8) + pad(mb(bytes), 9) +
    pad(`${pct.toFixed(1)}%${pct >= THRESH ? ' ⚠' : ''}`, 10) + pad(requests, 7) + primary);
}
server.close();
console.log('');
if (flagged.length) {
  console.log(`${flagged.length} scenario(s) fetch ≥ ${THRESH}% of the corpus — the non-geo scans that can't prune chunks:`);
  for (const { s, pct } of flagged) console.log(`  • ${s.name} — ${pct.toFixed(1)}%`);
} else console.log(`All scenarios under ${THRESH}%.`);
console.log('');
process.exit(0);
