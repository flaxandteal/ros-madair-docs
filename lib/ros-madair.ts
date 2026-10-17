// The Rós Madair browser compiler, wired in next to duckdb-wasm.
//
// This is the "one compiler, two consumers" thesis made live in the browser: the
// `ros-madair` npm package is the SAME Rust IR→SQL lowering that `ros-madair-duck`
// runs natively, compiled to wasm. A page builds a typed Query IR, this wrapper
// compiles it to DuckDB SQL, and duckdb-wasm (lib/duckdb.ts) executes it — no
// hand-written SQL, so a demo can't silently drift from what the engine emits.
//
// Two singletons, mirroring lib/duckdb.ts's getDuck and rm-arches-client's
// ensureAlizarin: the wasm module is initialised once, and ONE Compiler is cached
// per model graph (the expensive step is parsing the Arches model + build_indices,
// so re-doing it per query — e.g. per keystroke in a facet UI — is exactly the
// trap to avoid; parse once, compile many).

import { getDuck, dataUrl } from './duckdb';

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// --- 1. one-time wasm init (the .wasm is self-hosted under public/ros-madair, like duckdb) ---
let wasmReady: Promise<typeof import('ros-madair')> | null = null;

function ensureWasm(): Promise<typeof import('ros-madair')> {
  if (wasmReady) return wasmReady;
  wasmReady = (async () => {
    const mod = await import('ros-madair');
    // wasm-pack --target web: the default export is the async init that fetches the
    // module from a URL (no bundler wasm handling needed — matches duckdb's loader).
    await mod.default({ module_or_path: `${BASE_PATH}/ros-madair/ros_madair_wasm_bg.wasm` });
    return mod;
  })();
  return wasmReady;
}

// --- 2. one Compiler per model, cached. The graph JSON is the Arches model doc
//        already on disk under public/rm-example/resource_models (alizarin fetches
//        the same files). The Compiler parses it + build_indices ONCE here. ---
type Compiler = InstanceType<typeof import('ros-madair').Compiler>;
const compilers = new Map<string, Promise<Compiler>>();

export function getCompiler(graphId: string): Promise<Compiler> {
  let c = compilers.get(graphId);
  if (!c) {
    c = (async () => {
      const mod = await ensureWasm();
      const res = await fetch(`${BASE_PATH}/rm-example/resource_models/${graphId}.json`);
      if (!res.ok) throw new Error(`model ${graphId}: HTTP ${res.status}`);
      // The Compiler accepts a single Arches `{graph:[…]}` doc or an array of them;
      // one model is enough unless a query hops across models (OnLink).
      return new mod.Compiler(await res.text());
    })();
    compilers.set(graphId, c);
  }
  return c;
}

// --- 3. register a model's Parquet under the view names the compiler emits ---
// The compiler's SQL is written against logical tables (`tiles`, `concept_index`,
// `concepts`, `ordered_index`, `edges`) — exactly what native `duck` composes as
// views. Here we CREATE those views over the model's melted-store Parquet, and
// return the capability flags the compiler needs (which stores are present).
export type ModelFiles = {
  tiles: string; // tiles_<graph>.parquet                -> view `tiles`
  concepts?: string; // the melted concept store         -> view `concept_index`
  catalog?: string; // concept_catalog(_x).parquet (DFS) -> view `concepts`
  ordered?: string; // ordered_<graph>.parquet           -> view `ordered_index`
  edges?: string; // edges_<graph>.parquet               -> view `edges`
  redges?: string; // redges_<graph>.parquet (reverse)   -> view `edges_rev` (untyped Backlink)
  grid?: string; // grid_<graph>.parquet                 -> view `grid` (GridBox spatial prune)
  resources?: string; // resources_<graph>.parquet       -> view `resources` (entry table)
};

export type Capabilities = {
  has_catalog: boolean;
  has_edges: boolean;
  has_concept_index: boolean;
  has_ordered: boolean;
  has_grid: boolean;
  spatial: boolean;
  // store-name → inline `read_parquet(name)` expression (registerPartitionedModel only).
  // Queries splice these in instead of referencing a SELECT * view, so duckdb-wasm
  // projects + prunes (range reads) rather than fully downloading each store.
  ref?: Record<string, string>;
};

// Views live in the duckdb catalog (global across connections), so registering a
// model once makes its tables available to every subsequent query. Returns the
// capability flags derived from which files were supplied — passed straight to the
// compiler so it knows which predicates it may lower.
export async function registerModel(files: ModelFiles): Promise<Capabilities> {
  const db = await getDuck();
  const duckdb = await import('@duckdb/duckdb-wasm');
  const conn = await db.connect();
  try {
    const view = async (name: string, file: string) => {
      await db.registerFileURL(file, dataUrl(file), duckdb.DuckDBDataProtocol.HTTP, false);
      await conn.query(`CREATE OR REPLACE VIEW ${name} AS SELECT * FROM read_parquet('${file}')`);
    };
    await view('tiles', files.tiles);
    if (files.concepts) await view('concept_index', files.concepts);
    if (files.catalog) await view('concepts', files.catalog);
    if (files.ordered) await view('ordered_index', files.ordered);
    if (files.edges) await view('edges', files.edges);
    if (files.grid) await view('grid', files.grid);
    if (files.resources) await view('resources', files.resources);
  } finally {
    await conn.close();
  }
  return {
    has_concept_index: !!files.concepts,
    has_catalog: !!files.catalog,
    has_ordered: !!files.ordered,
    has_edges: !!files.edges,
    has_grid: !!files.grid,
    spatial: false, // no spatial extension in the browser → coarse bbox-overlap
  };
}

// --- 4. compile a Query IR to SQL. The IR's `model` selects the graph; `measures`
//        is required by the IR (an empty array means "resolve ids"). ---
export type QueryIR = {
  model: string;
  where?: unknown;
  measures?: unknown[];
};

export async function compileQuery(ir: QueryIR, caps: Capabilities): Promise<string> {
  const compiler = await getCompiler(ir.model);
  const json = JSON.stringify({ measures: [], ...ir });
  return compiler.compile(
    json,
    caps.has_catalog,
    caps.has_edges,
    caps.has_concept_index,
    caps.has_ordered,
    caps.has_grid,
    caps.spatial,
  );
}

// --- 4b. the grid cells a box overlaps, as a comma list for `… WHERE cell IN (…)`.
//         Delegates to the wasm `cells_in_box`, the SAME Morton contract emit's
//         `grid_cell` wrote with — so a browser-built grid read (carrying the
//         render columns) hits exactly the cells the compiler's GridBox would. ---
export async function cellsInBox(
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
): Promise<string> {
  const mod = await ensureWasm();
  return mod.cells_in_box(minLng, minLat, maxLng, maxLat);
}

// --- 5. LAYERED composition (base + interactive overlay), the browser twin of
//        ros-madair-duck's `open_layers`. Each store view keeps every row of the
//        HIGHEST-precedence layer that carries a key, via a SHADOW-SET anti-join
//        (`NOT EXISTS` against higher layers' keys) — NOT a `max(_layer) OVER
//        (PARTITION BY key)` window. The window blocks predicate pushdown (a
//        selective cross-layer query would full-scan the base); the anti-join
//        keeps the base's own filters pushable, so a spatial/concept/edge filter
//        still zone-map-prunes across a base+overlay composition. Same semantics,
//        pruning preserved — exactly the fix landed natively this session. ---
function shadowSetUnion(urls: string[], keys: string[], cols: string): string {
  // urls base-first (higher index = higher precedence). Keep each layer's rows
  // EXCEPT keys a higher layer redefines. Overlays are tiny, so the base's
  // anti-join build side is tiny and the base stays pushable.
  return urls
    .map((url, i) => {
      const sel = `SELECT ${cols} FROM read_parquet('${url}') base`;
      const higher = urls.slice(i + 1);
      if (higher.length === 0) return sel;
      const higherKeys = higher
        .map((h) => `SELECT ${keys.join(', ')} FROM read_parquet('${h}')`)
        .join(' UNION ALL ');
      const on = keys.map((k) => `h.${k} = base.${k}`).join(' AND ');
      return `${sel} WHERE NOT EXISTS (SELECT 1 FROM (${higherKeys}) h WHERE ${on})`;
    })
    .join('\nUNION ALL BY NAME\n');
}

export async function registerLayers(layers: ModelFiles[]): Promise<Capabilities> {
  const db = await getDuck();
  const duckdb = await import('@duckdb/duckdb-wasm');
  const conn = await db.connect();
  try {
    // Register every layer file URL with duckdb-wasm first.
    const reg = async (f?: string) => {
      if (f) await db.registerFileURL(f, dataUrl(f), duckdb.DuckDBDataProtocol.HTTP, false);
    };
    for (const L of layers) {
      await reg(L.tiles);
      await reg(L.concepts);
      await reg(L.catalog);
      await reg(L.ordered);
      await reg(L.edges);
      await reg(L.redges);
      await reg(L.grid);
      await reg(L.resources);
    }
    const urlsOf = (k: keyof ModelFiles) =>
      layers.map((L) => L[k]).filter((u): u is string => !!u);
    const compose = async (name: string, urls: string[], keys: string[], cols: string) => {
      if (urls.length)
        await conn.query(`CREATE OR REPLACE VIEW ${name} AS ${shadowSetUnion(urls, keys, cols)}`);
    };
    const RK = ['resource_id', 'nodegroup_id'];
    const EK = ['src_resource', 'src_nodegroup'];
    const EC = 'src_resource, src_node, src_nodegroup, src_tile, target_resource';
    await compose('tiles', urlsOf('tiles'), RK, '*');
    await compose('concept_index', urlsOf('concepts'), RK,
      'resource_id, tile_id, nodegroup_id, node_id, concept_id');
    await compose('ordered_index', urlsOf('ordered'), RK,
      'resource_id, tile_id, nodegroup_id, node_id, q_ordered');
    await compose('edges', urlsOf('edges'), EK, EC);
    await compose('edges_rev', urlsOf('redges'), EK, EC);
    // Grid + entry table: keyed by resource_id alone (a whole-resource fact), so an
    // overlay that moves or re-titles a resource supersedes its base row.
    await compose('grid', urlsOf('grid'), ['resource_id'],
      'cell, resource_id, descriptor, render_summary');
    await compose('resources', urlsOf('resources'), ['resource_id'],
      'resource_id, graph_id, legacyid, descriptor');
    // Catalog is a small vocabulary — topmost-per-concept is cheap as a window.
    const cat = urlsOf('catalog');
    if (cat.length) {
      const u = cat
        .map((c, i) => `SELECT concept_id, dfs_enter, dfs_leave, label, ${i} AS _l FROM read_parquet('${c}')`)
        .join(' UNION ALL BY NAME ');
      await conn.query(
        `CREATE OR REPLACE VIEW concepts AS SELECT concept_id, dfs_enter, dfs_leave, label FROM (${u}) ` +
          `QUALIFY row_number() OVER (PARTITION BY concept_id ORDER BY _l DESC) = 1`,
      );
    }
  } finally {
    await conn.close();
  }
  const any = (k: keyof ModelFiles) => layers.some((L) => !!L[k]);
  return {
    has_catalog: any('catalog'),
    has_edges: any('edges'),
    has_concept_index: any('concepts'),
    has_ordered: any('ordered'),
    has_grid: any('grid'),
    spatial: false,
  };
}

// --- 6. register a model whose `tiles` is Hive-PARTITIONED. When emit runs
//        `--partition-by-nodegroup` (needed at 763k so the per-model sort fits),
//        the tiles land as `tiles_<graph>/nodegroup_id=…/data_0.parquet`. HTTP
//        can't glob a directory, so the browser must enumerate the partition
//        files — which the snapshot's `manifest.json` lists in `artifacts`. We
//        register each partition URL and union them into the `tiles` view via a
//        `read_parquet([...])` list; the melted stores stay single files. ---
type Manifest = { artifacts?: Array<string | { path: string }> };

export async function registerPartitionedModel(
  prefix: string, // the subdir under /data, e.g. "aonach763k"
  graphId: string,
): Promise<Capabilities> {
  const manifest: Manifest = await fetch(dataUrl(`${prefix}/manifest.json`)).then((r) => {
    if (!r.ok) throw new Error(`${prefix}/manifest.json: HTTP ${r.status}`);
    return r.json();
  });
  const arts = (manifest.artifacts ?? []).map((a) => (typeof a === 'string' ? a : a.path));
  const has = (name: string) => arts.includes(name);
  const tilePartitions = arts.filter((a) => a.startsWith(`tiles_${graphId}/`));

  const db = await getDuck();
  const duckdb = await import('@duckdb/duckdb-wasm');
  // Register file URLs only — do NOT create `SELECT *` views. A view makes
  // duckdb-wasm fully download each file at bind time (schema inference reads the
  // whole object, not the footer): registering all 7 stores as views pulled ~470 MB
  // up front, including stores no query touches. Instead hand back an inline
  // `read_parquet(name)` expression per store; a query that uses it inline gets
  // column projection + row-group pruning (range reads) — the same 1–2 MB path the
  // aonach-mor demo already takes. registerFileURL is a pure name→URL mapping, so
  // registering every present store is free; only an inline read in an actual query
  // fetches bytes.
  const ref: Record<string, string> = {};
  const regUrl = async (art: string) => {
    const u = `${prefix}/${art}`;
    await db.registerFileURL(u, dataUrl(u), duckdb.DuckDBDataProtocol.HTTP, false);
    return u; // the registered virtual-file name; read_parquet('<name>') resolves it
  };
  // tiles: a list read over the partition files.
  if (tilePartitions.length) {
    const names = await Promise.all(tilePartitions.map(regUrl));
    ref['tiles'] = `read_parquet([${names.map((u) => `'${u}'`).join(', ')}])`;
  }
  const store = async (name: string, art: string) => {
    if (!has(art)) return false;
    const u = await regUrl(art);
    ref[name] = `read_parquet('${u}')`;
    return true;
  };
  const has_concept_index = await store('concept_index', `concepts_${graphId}.parquet`);
  const has_ordered = await store('ordered_index', `ordered_${graphId}.parquet`);
  const has_edges = await store('edges', `edges_${graphId}.parquet`);
  await store('edges_rev', `redges_${graphId}.parquet`);
  const has_grid = await store('grid', `grid_${graphId}.parquet`);
  await store('resources', `resources_${graphId}.parquet`);
  const has_catalog = await store('concepts', 'concept_catalog.parquet');
  return { has_catalog, has_edges, has_concept_index, has_ordered, has_grid, spatial: false, ref };
}
