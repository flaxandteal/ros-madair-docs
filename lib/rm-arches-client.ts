// Rós Madair wired in as an alizarin tile store.
//
// alizarin talks to a tile store through the abstract `ArchesClient`: give it a
// resource id, it wants that resource's tiles back, and it hydrates them into a
// typed model (resolving concepts and following resource-instance links lazily —
// each link is another getResource, so the whole graph traversal is served from
// Parquet). Here we take `ArchesClientRemoteStatic` (which already fetches the
// graph models + concept collections as static JSON) and override just the
// resource/tile methods to answer them from the tile-row Parquet via duckdb-wasm.
//
// This is the "keep hydration, replace the read engine" thesis, live: the graph
// shapes and concept resolution stay alizarin's; the tiles come from Parquet.

import { getDuck, dataUrl } from './duckdb';

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

type ResourceGraphMap = Record<string, { graph_id: string; name: string | null }>;

// duckdb-wasm connection + which tile files we've registered, memoised.
let conn: Awaited<ReturnType<Awaited<ReturnType<typeof getDuck>>['connect']>> | null = null;
const registered = new Set<string>();
let resourceGraph: ResourceGraphMap | null = null;

async function connection() {
  if (!conn) conn = await (await getDuck()).connect();
  return conn;
}

async function ensureRegistered(fileName: string) {
  if (registered.has(fileName)) return;
  const db = await getDuck();
  const duckdb = await import('@duckdb/duckdb-wasm');
  await db.registerFileURL(fileName, dataUrl(fileName), duckdb.DuckDBDataProtocol.HTTP, false);
  registered.add(fileName);
}

async function loadResourceGraph(): Promise<ResourceGraphMap> {
  if (resourceGraph) return resourceGraph;
  const res = await fetch(`${BASE_PATH}/data/resource_graph.json`);
  resourceGraph = (await res.json()) as ResourceGraphMap;
  return resourceGraph;
}

// Register every model's tile Parquet up front, so an ad-hoc query can reference
// `tiles_<graph>.parquet` by bare name (duckdb-wasm needs the name registered
// before the SELECT, not just when getResource lazily touches it).
async function registerAllTileFiles(map: ResourceGraphMap) {
  const graphIds = new Set(Object.values(map).map((v) => v.graph_id));
  await Promise.all([...graphIds].map((g) => ensureRegistered(`tiles_${g}.parquet`)));
}

// Query a single resource's tiles out of its model's Parquet.
async function tilesFor(resourceId: string, graphId: string) {
  const file = `tiles_${graphId}.parquet`;
  await ensureRegistered(file);
  const c = await connection();
  const q = await c.query(
    `SELECT tileid, nodegroup_id, parenttile_id, sortorder, data
       FROM read_parquet('${file}')
      WHERE resource_id = '${resourceId.replace(/'/g, "''")}'
      ORDER BY nodegroup_id, sortorder`,
  );
  return q.toArray().map((r) => {
    const o = r.toJSON() as { tileid: string; nodegroup_id: string; parenttile_id: string | null; sortorder: number; data: string };
    return {
      tileid: o.tileid,
      nodegroup_id: o.nodegroup_id,
      parenttile_id: o.parenttile_id ?? null,
      sortorder: Number(o.sortorder ?? 0),
      resourceinstance_id: resourceId,
      data: JSON.parse(o.data),
    };
  });
}

// Hydrate a resource id into a rich, typed alizarin view model. Uses the
// wrapper's `find` (defaultAllow=true) rather than graphManager.getResource,
// because the latter prunes tiles by default — which un-permits every nodegroup
// and leaves all attributes empty. The model is resolved from the resource's own
// graph (looked up in resource_graph.json), so any queried id hydrates correctly.
export async function hydrate(resourceId: string): Promise<unknown> {
  const alizarin = await ensureAlizarin();
  const map = await loadResourceGraph();
  const entry = map[resourceId];
  const wrapper = await alizarin.graphManager.get(entry ? entry.graph_id : resourceId);
  return wrapper.find(resourceId);
}

// Run an arbitrary query and return its rows as plain objects (BigInt → number).
export async function queryRows(sql: string): Promise<Record<string, unknown>[]> {
  const c = await connection();
  const q = await c.query(sql);
  return q.toArray().map((r) => {
    const o = r.toJSON() as Record<string, unknown>;
    for (const k of Object.keys(o)) if (typeof o[k] === 'bigint') o[k] = Number(o[k]);
    return o;
  });
}

// Fetch a controlled list / SKOS collection through alizarin's configured client
// (the RDM cache's loader) — the same object alizarin resolves labels from.
export async function getCollection(collectionId: string): Promise<{
  concepts: Record<string, { children?: (string | { id: string })[]; prefLabels?: Record<string, { id: string; value: string }> }>;
}> {
  const alizarin = await ensureAlizarin();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (alizarin.RDM as any).archesClient.getCollection(collectionId);
}

// Run an arbitrary query and return its `resource_id` column (deduped, in order).
export async function queryResourceIds(sql: string): Promise<string[]> {
  const c = await connection();
  const q = await c.query(sql);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of q.toArray()) {
    const o = row.toJSON() as Record<string, unknown>;
    const id = o.resource_id ?? o.resourceinstanceid ?? Object.values(o)[0];
    const s = id == null ? '' : String(id);
    if (s && !seen.has(s)) {
      seen.add(s);
      ids.push(s);
    }
  }
  return ids;
}

// One-time alizarin setup: init WASM, register the CLM `reference` handler, and
// point graphManager / staticStore / RDM at the Parquet-backed tile store. Mirrors
// alizarin-docs' setup singleton, swapping the static-file client for ours.
let setup: Promise<typeof import('alizarin')> | null = null;

export function ensureAlizarin(): Promise<typeof import('alizarin')> {
  if (setup) return setup;
  setup = (async () => {
    const alizarin = await import('alizarin');
    const { client, graphManager, staticStore, RDM, staticTypes, initWasm } = alizarin;
    await initWasm();
    // Out-of-tree datatype handlers self-register on wasmReady (CLM adds the
    // `reference`/concept handler the example graphs use).
    await import('@alizarin/clm');
    await import('@alizarin/filelist');

    const map = await loadResourceGraph();
    await registerAllTileFiles(map);

    const archesClient = new client.ArchesClientRemoteStatic(BASE_PATH || '', {
      allGraphFile: () => 'rm-example/resource_models/_all.json',
      graphIdToGraphFile: (graphId: string) => `rm-example/resource_models/${graphId}.json`,
      collectionIdToFile: (collectionId: string) => `rm-example/collections/${collectionId}.json`,
    });

    // --- the tile-store override: resources + tiles come from Parquet ---
    const buildResource = async (resourceId: string) => {
      const entry = map[resourceId];
      if (!entry) throw new Error(`Unknown resource ${resourceId} (not in resource_graph.json)`);
      const tiles = await tilesFor(resourceId, entry.graph_id);
      return new staticTypes.StaticResource({
        metadata: {},
        resourceinstance: {
          descriptors: {},
          graph_id: entry.graph_id,
          legacyid: null,
          name: entry.name,
          resourceinstanceid: resourceId,
        },
        tiles,
        tiles_loaded: true,
      } as unknown as ConstructorParameters<typeof staticTypes.StaticResource>[0]);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ac = archesClient as any;
    ac.getResource = (resourceId: string) => buildResource(resourceId);
    ac.getResourceTiles = async (resourceId: string) => (await buildResource(resourceId)).tiles || [];
    ac.getResources = async (graphId: string, limit: number) => {
      await ensureRegistered(`tiles_${graphId}.parquet`);
      const c = await connection();
      const q = await c.query(`SELECT DISTINCT resource_id FROM read_parquet('tiles_${graphId}.parquet')`);
      const ids = q.toArray().map((r) => String((r.toJSON() as { resource_id: string }).resource_id));
      const take = limit ? ids.slice(0, limit) : ids;
      return Promise.all(take.map(buildResource));
    };
    ac.getResourceSummaries = async (graphId: string, limit: number) => {
      const resources = await ac.getResources(graphId, limit);
      return resources.map((r: { resourceinstance: unknown }) => r.resourceinstance);
    };

    graphManager.archesClient = archesClient;
    staticStore.archesClient = archesClient;
    RDM.archesClient = archesClient;
    await graphManager.initialize();

    // Warm every model into the registry, unpruned. Resource-instance links
    // resolve their target via staticStore.loadOne, which returns the registry
    // copy when present — so a link (produced_by_model, scenario) only hydrates
    // with attributes if its target graph was loaded permissively first. This is
    // the same warm-up alizarin's own relationship example does; our corpus is
    // tiny, so loading all of it up front is cheap and makes every link resolve.
    const graphIds = new Set(Object.values(map).map((v) => v.graph_id));
    await Promise.all(
      [...graphIds].map(async (g) => {
        const w = await graphManager.get(g); // defaultAllow=true → not pruned
        await w.all();
      }),
    );
    return alizarin;
  })();
  return setup;
}
