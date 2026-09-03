// Turn the copied Arches business_data (example-data/business_data/*.json) into
// tile-row Parquet — one file per resource model — so the live "RM as an alizarin
// tile store" demo can serve tiles straight from Parquet. The tile `data` is the
// REAL Arches tile payload (real node UUIDs, multilingual strings, concept value
// ids, resource-instance links), stored verbatim so alizarin hydrates it exactly
// as it would from the JSON business_data.
//
// Output → public/data/:
//   tiles_<graphid>.parquet   one row per tile, `data` = the tile's JSON payload
//   resource_graph.json       resource_id -> { graph_id, name } (getResource routing)
//
// The layout mirrors ros-madair-emit's one-Parquet-per-model; the browser client
// (lib/rm-arches-client.ts) range-reads these with duckdb-wasm.

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'example-data', 'business_data');
const OUT = join(__dirname, '..', 'public', 'data');

const GRAPHS = join(__dirname, '..', 'public', 'rm-example', 'resource_models');

// The example business data leaves the one HIERARCHICAL controlled list
// (ServiceRole) unused, so the roundtrip demo has no hierarchy to query. We
// synthesise one `service_roles` value per Organisation, spread across the tree
// (the Hospital subtree gets three, so DescendantOrSelfOf('Hospital') is
// non-trivial). These are injected as real tile rows in the Organisation Parquet
// — the client hydrates from Parquet, so this covers both query and hydration.
const ORG_GRAPH = 'aacd4ba3-8395-5092-870d-727143cd489a';
const SERVICE_ROLES_NODE = 'db3609b1-9002-527a-947a-ff8dcfdd10e9'; // concept-list, ServiceRole
const SERVICE_ROLE_ASSIGNMENTS = [
  { v: '079d431f-644d-52f7-a42c-9524b1b389d2', l: 'Hospital' },
  { v: 'c424285b-32b5-54de-8639-8419e542a888', l: 'Hospital liaison' },   // child of Hospital
  { v: 'a19b80c9-47a2-52e5-af3d-2fccdf140c39', l: 'Triage lead' },        // child of Hospital
  { v: '8ec68acd-a295-5512-a388-f0a014726c3b', l: 'Fire station' },
  { v: '46d92e35-c63e-5edc-8590-c79c23e913f4', l: 'Fire chief' },         // child of Fire station
  { v: 'a968328a-6281-53e9-a501-f3a1da1b7d0e', l: 'School' },
  { v: '083fb7b6-a5c2-5531-bf9a-d42372b62cb5', l: 'School principal' },   // child of School
  { v: 'a63400b5-5b91-5c46-87f8-3e0e05b7a526', l: 'Emergency operations centre' },
  { v: 'e43afaa7-92a7-5a7a-ab74-33acea0bab75', l: 'EOC duty officer' },   // child of EOC
  { v: '3ca4233f-2a5e-54b9-8b2c-1e62bed44680', l: 'Police station' },
  { v: 'bea7fcac-128c-5bc8-b77a-6998571ffd8d', l: 'Water / pumping station' },
];

const sql = (v) =>
  v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;

// node UUID -> datatype, so we can spot concept-like nodes in a tile.
function datatypesFor(graphId) {
  const g = JSON.parse(readFileSync(join(GRAPHS, `${graphId}.json`), 'utf8'));
  const G = Array.isArray(g.graph) ? g.graph[0] : g.graph ?? g;
  const m = {};
  for (const n of G.nodes ?? []) m[n.nodeid] = n.datatype;
  return m;
}

// Promote the first concept-like value in a tile to a queryable id (+ label),
// mirroring ros-madair-emit's reference/concept handler: a `reference` value is
// keyed by its `list_item_id` (the CLM list item), a legacy `concept` by its
// value id. This is the promoted column whose row-group stats are the zone-map.
function promoteConcept(data, dtByNode) {
  for (const nid of Object.keys(data).sort()) {
    const dt = dtByNode[nid];
    const v = data[nid];
    if (v == null) continue;
    if (dt === 'reference' && Array.isArray(v) && v[0]?.list_item_id) {
      const labels = v[0].labels ?? [];
      const label = (labels.find((l) => l.valuetype_id === 'prefLabel') ?? labels[0])?.value ?? null;
      return { concept_id: v[0].list_item_id, concept_label: label };
    }
    if ((dt === 'concept' || dt === 'concept-list')) {
      const id = typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null;
      if (id) return { concept_id: id, concept_label: null };
    }
  }
  return { concept_id: null, concept_label: null };
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  const resourceGraph = {};
  let totalTiles = 0;

  for (const file of readdirSync(SRC).filter((f) => f.endsWith('.json'))) {
    const doc = JSON.parse(readFileSync(join(SRC, file), 'utf8'));
    const resources = doc.business_data?.resources ?? [];
    if (!resources.length) continue;

    // graph id from the bundle name (_<graphid>.json) — the RM one-file-per-model key.
    const graphId = file.replace(/^_/, '').replace(/\.json$/, '');
    const dtByNode = datatypesFor(graphId);
    const rows = [];
    for (const r of resources) {
      const ri = r.resourceinstance ?? {};
      const rid = ri.resourceinstanceid;
      const name = ri.name ?? null;
      resourceGraph[rid] = { graph_id: graphId, name };
      for (const t of r.tiles ?? []) {
        const { concept_id, concept_label } = promoteConcept(t.data ?? {}, dtByNode);
        rows.push({
          resource_id: rid,
          descriptor_name: name,
          graph_id: graphId,
          nodegroup_id: t.nodegroup_id ?? null,
          tileid: t.tileid ?? null,
          parenttile_id: t.parenttile_id ?? null,
          sortorder: t.sortorder ?? 0,
          concept_id,
          concept_label,
          data: JSON.stringify(t.data ?? {}),
        });
      }
    }

    // Inject one synthetic service_roles tile per Organisation (see note above).
    if (graphId === ORG_GRAPH) {
      resources.forEach((r, i) => {
        const ri = r.resourceinstance ?? {};
        const rid = ri.resourceinstanceid;
        const role = SERVICE_ROLE_ASSIGNMENTS[i % SERVICE_ROLE_ASSIGNMENTS.length];
        rows.push({
          resource_id: rid,
          descriptor_name: ri.name ?? null,
          graph_id: graphId,
          nodegroup_id: SERVICE_ROLES_NODE,
          tileid: `${rid}-service-role`,
          parenttile_id: null,
          sortorder: 0,
          concept_id: role.v,
          concept_label: role.l,
          data: JSON.stringify({ [SERVICE_ROLES_NODE]: [role.v] }),
        });
      });
    }
    totalTiles += rows.length;

    await conn.run('DROP TABLE IF EXISTS stage;');
    await conn.run(`CREATE TABLE stage (
      resource_id VARCHAR, descriptor_name VARCHAR, graph_id VARCHAR,
      nodegroup_id VARCHAR, tileid VARCHAR, parenttile_id VARCHAR,
      sortorder INTEGER, concept_id VARCHAR, concept_label VARCHAR, data VARCHAR);`);
    const cols = ['resource_id', 'descriptor_name', 'graph_id', 'nodegroup_id', 'tileid', 'parenttile_id', 'sortorder', 'concept_id', 'concept_label', 'data'];
    const values = rows.map((r) => `(${cols.map((c) => sql(r[c])).join(',')})`).join(',\n');
    await conn.run(`INSERT INTO stage VALUES\n${values};`);

    // ORDER BY resource_id so a single resource's tiles are contiguous (one range
    // read), echoing RM's cluster ordering.
    await conn.run(`COPY (SELECT ${cols.join(', ')} FROM stage ORDER BY resource_id, nodegroup_id, sortorder)
      TO '${join(OUT, `tiles_${graphId}.parquet`)}' (FORMAT PARQUET);`);
    console.log(`tiles_${graphId}.parquet  ${rows.length} tiles / ${resources.length} resources`);
  }

  writeFileSync(join(OUT, 'resource_graph.json'), JSON.stringify(resourceGraph));
  console.log(`resource_graph.json  ${Object.keys(resourceGraph).length} resources · ${totalTiles} tiles total`);

  await writeOverlay(conn);
}

// A sparse OVERLAY layer for the base+overlay demo: a second, tiny Parquet that
// re-designates two Sites' `heritage_designation`. It carries ONLY the changed
// tiles (the overlay model is sparse — an overlay says only what differs), same
// schema as the base. Composed with base at query time (overlay wins per
// resource+nodegroup), a single "Scheduled Monument" search then ADDS Cé an Rí
// (was Conservation Area) and DROPS Ceantar Theas (re-designated away).
async function writeOverlay(conn) {
  const SITE = '64368e71-abbc-53ba-9bd8-87e2500f8e65';
  const HD_NODE = '15bc97aa-9bf2-5610-9d4f-fcbcffa8524b'; // heritage_designation node = nodegroup
  const LIST = '2730d609-3a8d-49dc-bf51-6ac34e80294a';    // the controlled list
  const ref = (itemId, label) =>
    JSON.stringify({ [HD_NODE]: [{ list_id: LIST, list_item_id: itemId, labels: [{ value: label, language_id: 'en', valuetype_id: 'prefLabel' }] }] });
  const tiles = [
    // Ceantar Theas: Scheduled Monument (base) → Conservation Area (overlay) — drops from the search
    { rid: '7c36c3f5-bec7-53cc-b5ef-1a140351d602', name: 'Ceantar Theas', cid: '513a85dd-477d-597d-a624-47274b860ba7', label: 'Conservation Area' },
    // Cé an Rí: Conservation Area (base) → Scheduled Monument (overlay) — appears in the search
    { rid: '8e1c27b9-c743-5bcf-83c8-318179bb2edd', name: 'Cé an Rí', cid: 'a7d38e93-1442-590e-b976-70a321a45421', label: 'Scheduled Monument' },
  ];
  const overlayDir = join(OUT, 'overlay');
  mkdirSync(overlayDir, { recursive: true });
  await conn.run('DROP TABLE IF EXISTS overlay;');
  await conn.run(`CREATE TABLE overlay (
    resource_id VARCHAR, descriptor_name VARCHAR, graph_id VARCHAR,
    nodegroup_id VARCHAR, tileid VARCHAR, parenttile_id VARCHAR,
    sortorder INTEGER, concept_id VARCHAR, concept_label VARCHAR, data VARCHAR);`);
  const values = tiles
    .map((t) => `(${[t.rid, t.name, SITE, HD_NODE, `${t.rid}-overlay-hd`, null, 0, t.cid, t.label, ref(t.cid, t.label)].map(sql).join(',')})`)
    .join(',\n');
  await conn.run(`INSERT INTO overlay VALUES\n${values};`);
  await conn.run(`COPY (SELECT resource_id, descriptor_name, graph_id, nodegroup_id, tileid, parenttile_id, sortorder, concept_id, concept_label, data FROM overlay)
    TO '${join(overlayDir, `tiles_${SITE}.parquet`)}' (FORMAT PARQUET);`);
  console.log(`overlay/tiles_${SITE}.parquet  ${tiles.length} amended heritage_designation tiles`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
