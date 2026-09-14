// Measure per-node promotion on the REAL Monument graph, at scale.
// Builds two Parquet variants of the same synthetic tiles for one heavily-merged
// nodegroup, then reports what a facet query fetches (projected column bytes):
//   baseline : one `concept_ids` VARCHAR blob merging ALL the nodegroup's reference
//              values (what ros-madair-emit produces today)
//   promoted : one dict-encoded column per reference node (per-node promotion)
import { readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as duckdb from '@duckdb/node-api';

const HER = '/home/philtweir/Cód/Oscailte/magic/arches-her/arches_her/pkg';
const OUT = '/tmp/claude-1000/-home-philtweir-C-d-Oscailte-magic-RosMadair-sandbox-parquet/74975163-e5ad-4192-a288-dec4582d792f/scratchpad/promo';
const N = 50000;            // tiles
const RG = 10000;           // row group size

rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });

// ── graph + controlled lists ──────────────────────────────────────────────────
let g = JSON.parse(readFileSync(join(HER, 'graphs/resource_models/Monument.json'), 'utf8')).graph;
if (Array.isArray(g)) g = g[0];
const refs = g.nodes.filter((n) => n.datatype === 'reference' && n.config?.controlledList);

const clDir = join(HER, 'reference_data/controlled_lists');
const lists = {};
for (const f of readdirSync(clDir)) {
  if (!f.endsWith('.xml')) continue;
  const xml = readFileSync(join(clDir, f), 'utf8');
  const sm = xml.match(/<skos:ConceptScheme[^>]*rdf:about="[^"]*?([0-9a-f-]{36})"/i); if (!sm) continue;
  const items = []; for (const b of xml.split(/<skos:Concept\b/).slice(1)) { const m = b.match(/rdf:about="[^"]*?([0-9a-f-]{36})"/i); if (m) items.push(m[1]); }
  lists[sm[1]] = items;
}

// pick the nodegroup with the most RESOLVABLE reference nodes
const byNg = {};
for (const n of refs) { if (lists[n.config.controlledList]?.length) (byNg[n.nodegroup_id] ||= []).push(n); }
const [ng, ngRefs] = Object.entries(byNg).sort((a, b) => b[1].length - a[1].length)[0];
console.log(`nodegroup ${ng} — ${ngRefs.length} resolvable reference nodes:`);
console.log('  ' + ngRefs.map((n) => n.alias).slice(0, 12).join(', ') + (ngRefs.length > 12 ? ' …' : ''));
const cols = ngRefs.map((n) => ({ alias: 'ref_' + n.alias.replace(/[^a-z0-9_]/gi, '_').slice(0, 40), items: lists[n.config.controlledList] }));

// ── synthesize N tiles (deterministic) ─────────────────────────────────────────
let s = 42; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const c = await (await duckdb.DuckDBInstance.create(':memory:')).connect();
const rows = async (q) => (await (await c.run(q)).getRowObjects());

// build a staging table with per-node columns, then derive both variants
const colDefs = cols.map((cc) => `${cc.alias} VARCHAR`).join(', ');
await c.run(`CREATE TABLE stage (resource_id VARCHAR, ${colDefs})`);
const app = await c.createAppender('stage');
for (let i = 0; i < N; i++) {
  app.appendVarchar(`m-${i}`);
  for (const cc of cols) app.appendVarchar(pick(cc.items));
  app.endRow();
}
app.closeSync();

// baseline: concept_ids = JSON array merging all the nodegroup's reference values
const jsonArr = `to_json([${cols.map((cc) => cc.alias).join(', ')}])`;
await c.run(`COPY (SELECT resource_id, CAST(${jsonArr} AS VARCHAR) AS concept_ids FROM stage) TO '${join(OUT, 'baseline.parquet')}' (FORMAT PARQUET, ROW_GROUP_SIZE ${RG})`);
// promoted: one column per reference node
await c.run(`COPY (SELECT resource_id, ${cols.map((cc) => cc.alias).join(', ')} FROM stage) TO '${join(OUT, 'promoted.parquet')}' (FORMAT PARQUET, ROW_GROUP_SIZE ${RG})`);
// long: melted store — one ROW per (tile, node, concept), sorted for zone-map pruning
const unpivot = cols.map((cc) => `SELECT resource_id, '${cc.alias}' AS node_id, ${cc.alias} AS concept_id FROM stage`).join('\nUNION ALL\n');
await c.run(`COPY (SELECT * FROM (${unpivot}) ORDER BY node_id, concept_id) TO '${join(OUT, 'long.parquet')}' (FORMAT PARQUET, ROW_GROUP_SIZE ${RG})`);

// ── measure per-column compressed bytes ─────────────────────────────────────────
const colBytes = async (file) => {
  const r = await rows(`SELECT path_in_schema col, sum(total_compressed_size)::BIGINT b FROM parquet_metadata('${file}') GROUP BY 1`);
  const m = {}; let tot = 0; for (const x of r) { m[x.col] = Number(x.b); tot += Number(x.b); } return { m, tot };
};
const B = await colBytes(join(OUT, 'baseline.parquet'));
const P = await colBytes(join(OUT, 'promoted.parquet'));
const target = cols[0].alias; // the facet a query filters on
const kb = (b) => (b / 1e3).toFixed(0) + ' KB';

console.log(`\n${N.toLocaleString()} tiles · row groups of ${RG.toLocaleString()}\n`);
console.log('=== file sizes ===');
console.log(`  baseline (1 concept_ids blob) : ${kb(B.tot)}`);
console.log(`  promoted (${cols.length} dict columns)     : ${kb(P.tot)}`);
console.log('\n=== what a SINGLE-facet query fetches (project just the filtered facet) ===');
console.log(`  baseline: read concept_ids       = ${kb(B.m.concept_ids)}   (LIKE substring scan, no stats)`);
console.log(`  promoted: read ${target.padEnd(22)}= ${kb(P.m[target] || 0)}   (exact dict match)`);
console.log(`  → promotion fetches ${(100 * (P.m[target] || 0) / B.m.concept_ids).toFixed(1)}% of baseline  (${(B.m.concept_ids / (P.m[target] || 1)).toFixed(1)}× less)`);

// multi-facet: query 3 of the nodegroup's reference nodes at once
const three = cols.slice(0, 3).map((cc) => cc.alias);
const p3 = three.reduce((a, k) => a + (P.m[k] || 0), 0);
console.log('\n=== a 3-facet query on this nodegroup ===');
console.log(`  baseline: still one concept_ids  = ${kb(B.m.concept_ids)}`);
console.log(`  promoted: 3 columns              = ${kb(p3)}   (${(100 * p3 / B.m.concept_ids).toFixed(1)}% of baseline)`);

// correctness / expressiveness: the merged blob loses node provenance
const shareLists = {}; for (const cc of cols) { const key = cc.items.length + ':' + cc.items[0]; (shareLists[key] ||= []).push(cc.alias); }
const shared = Object.values(shareLists).filter((a) => a.length > 1).length;
const v = pick(cols[0].items);
const nb = Number((await rows(`SELECT count(*) n FROM read_parquet('${join(OUT, 'baseline.parquet')}') WHERE concept_ids LIKE '%${v}%'`))[0].n);
const np = Number((await rows(`SELECT count(*) n FROM read_parquet('${join(OUT, 'promoted.parquet')}') WHERE ${target}='${v}'`))[0].n);
console.log(`\n=== EXPRESSIVENESS: can you ask "${target.replace('ref_', '')} = X" at all? ===`);
console.log(`  baseline (concept_ids LIKE): ${nb} tiles  — matches the value in ANY of the ${cols.length} reference fields`);
console.log(`  promoted (${target} = X)    : ${np} tiles  — matches ONLY that field`);
console.log(`  → baseline over-matches ${(nb / np).toFixed(1)}× — the merged blob cannot scope to a node.`);
console.log(`     (${cols.length} reference nodes in this tile draw from ${Object.keys(shareLists).length} distinct lists; ${shared} lists are shared by >1 node,`);
console.log(`      so a value in one field is indistinguishable from the same value in another.)`);

// ── long (melted) store: node-scoped facet fetch + the multi-valued case ─────────
const L = await colBytes(join(OUT, 'long.parquet'));
console.log('\n=== LONG (melted) store — one row per (tile,node,concept), sorted by (node_id,concept_id) ===');
console.log(`  total size: ${kb(L.tot)}  (vs blob ${kb(B.tot)}, wide ${kb(P.tot)})`);
const ln = Number((await rows(`SELECT count(DISTINCT resource_id) n FROM read_parquet('${join(OUT, 'long.parquet')}') WHERE node_id='${target}' AND concept_id='${v}'`))[0].n);
console.log(`  node-scoped facet (node_id='${target.replace('ref_', '')}' AND concept_id=X): ${ln} tiles  ${ln === np ? '= wide-column exact ✓ (no conflation)' : '!= '+np}`);
console.log(`  fetch = node_id + concept_id columns (sorted → prunes to the node's block): ${kb((L.m.node_id || 0) + (L.m.concept_id || 0))} for the two columns across the whole store`);

// multi-valued node (concept-list): 1-3 values per tile from a small pool — the case wide columns cannot represent
const MAT = ['brick', 'timber', 'stone', 'concrete', 'thatch'];
await c.run(`CREATE TABLE mv (resource_id VARCHAR, node_id VARCHAR, concept_id VARCHAR)`);
const amv = await c.createAppender('mv');
let bothBT = 0;
for (let i = 0; i < N; i++) {
  const k = 1 + Math.floor(rnd() * 3); const chosen = new Set();
  while (chosen.size < k) chosen.add(pick(MAT));
  for (const m of chosen) { amv.appendVarchar(`m-${i}`); amv.appendVarchar('materials'); amv.appendVarchar(m); amv.endRow(); }
  if (chosen.has('brick') && chosen.has('timber')) bothBT++;
}
amv.closeSync();
const containsBrick = Number((await rows(`SELECT count(DISTINCT resource_id) n FROM mv WHERE node_id='materials' AND concept_id='brick'`))[0].n);
const bothQ = Number((await rows(`SELECT count(*) n FROM (SELECT resource_id FROM mv WHERE node_id='materials' AND concept_id IN ('brick','timber') GROUP BY resource_id HAVING count(DISTINCT concept_id)=2)`))[0].n);
console.log('\n=== MULTI-VALUED node (concept-list "materials", 1-3 values/tile) ===');
console.log(`  contains 'brick'            : ${containsBrick} tiles  (a row match)`);
console.log(`  contains 'brick' AND 'timber' in the SAME list: query=${bothQ}  truth=${bothBT}  ${bothQ === bothBT ? '✓' : '✗'}`);
console.log(`  → wide per-node column CANNOT express this (a scalar holds one value); the blob only via LIKE-AND (which conflates across nodes).`);
console.log(`     The long form handles single- and multi-valued nodes identically — just rows.`);

// ── ADVERSARIAL non-heritage fixture: the FLOOR test ─────────────────────────────
// Sparse, flat, single-concept-per-nodegroup — the shape where melting has NOTHING
// to exploit (no bundling to un-merge, no hierarchy). Per the "heritage is a floor,
// not a peak" rule, the melted store must be NEUTRAL here, never a regression.
const CATS = Array.from({ length: 100 }, (_, i) => `cat-${String(i).padStart(3, '0')}`);
await c.run(`CREATE TABLE adv (resource_id VARCHAR, cat VARCHAR)`);
const aa = await c.createAppender('adv');
for (let i = 0; i < N; i++) { aa.appendVarchar(`a-${i}`); aa.appendVarchar(pick(CATS)); aa.endRow(); }
aa.closeSync();
await c.run(`COPY (SELECT resource_id, CAST(to_json([cat]) AS VARCHAR) AS concept_ids FROM adv) TO '${join(OUT, 'adv_blob.parquet')}' (FORMAT PARQUET, ROW_GROUP_SIZE ${RG})`);
await c.run(`COPY (SELECT resource_id, 'cat' AS node_id, cat AS concept_id FROM adv ORDER BY node_id, concept_id) TO '${join(OUT, 'adv_long.parquet')}' (FORMAT PARQUET, ROW_GROUP_SIZE ${RG})`);
const AB = await colBytes(join(OUT, 'adv_blob.parquet'));
const AL = await colBytes(join(OUT, 'adv_long.parquet'));
const avb = AB.m.concept_ids, avl = (AL.m.node_id || 0) + (AL.m.concept_id || 0);
const cval = pick(CATS);
const ab_n = Number((await rows(`SELECT count(*) n FROM read_parquet('${join(OUT, 'adv_blob.parquet')}') WHERE concept_ids LIKE '%${cval}%'`))[0].n);
const al_n = Number((await rows(`SELECT count(DISTINCT resource_id) n FROM read_parquet('${join(OUT, 'adv_long.parquet')}') WHERE node_id='cat' AND concept_id='${cval}'`))[0].n);
const sizeOk = AL.tot <= AB.tot * 1.1, fetchOk = avl <= avb * 1.1, exactOk = ab_n === al_n;
console.log('\n=== ADVERSARIAL (non-heritage): sparse, flat, 1 concept/nodegroup — FLOOR test ===');
console.log(`  total size:   blob ${kb(AB.tot)}  vs  melted ${kb(AL.tot)}   ${sizeOk ? 'NEUTRAL ✓' : 'REGRESSION ✗'}`);
console.log(`  facet fetch:  blob ${kb(avb)}  vs  melted ${kb(avl)}   ${fetchOk ? 'NEUTRAL ✓' : 'REGRESSION ✗'}`);
console.log(`  correctness:  blob ${ab_n} = melted ${al_n}  ${exactOk ? '✓ (no conflation to fix — 1 node/tile)' : '✗'}`);
console.log(`  → melting gains nothing here (nothing to exploit) but ${sizeOk && fetchOk && exactOk ? 'regresses NOTHING — the win is a floor, not a peak.' : 'REGRESSES — reconsider.'}`);
process.exit(0);
