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
};

export type Capabilities = {
  has_catalog: boolean;
  has_edges: boolean;
  has_concept_index: boolean;
  has_ordered: boolean;
  spatial: boolean;
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
  } finally {
    await conn.close();
  }
  return {
    has_concept_index: !!files.concepts,
    has_catalog: !!files.catalog,
    has_ordered: !!files.ordered,
    has_edges: !!files.edges,
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
    caps.spatial,
  );
}
