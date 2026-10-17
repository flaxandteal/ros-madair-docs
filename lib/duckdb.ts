import * as React from 'react';
import type { AsyncDuckDB } from '@duckdb/duckdb-wasm';

// GitHub Pages serves under a project path; assets (the self-hosted duckdb-wasm
// bundles and the demo Parquet) are addressed with the same basePath.
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// Large substrates (the 763k city, ~2.4 GB) blow the 1 GB GitHub Pages site limit, so
// they live on an object-store CDN (Cloudflare R2) addressed by NEXT_PUBLIC_DATA_HOST —
// which MUST serve HTTP range requests with CORS (Access-Control-Allow-Origin for the
// Pages origin, and Range in Access-Control-Allow-Headers). The small, CI-generated
// corpora stay local under /data. When NEXT_PUBLIC_DATA_HOST is unset (local dev), the
// big substrate is served locally too.
const DATA_HOST = (process.env.NEXT_PUBLIC_DATA_HOST ?? '').replace(/\/$/, '');
const REMOTE_PREFIXES = ['aonach763k/'];

// Absolute URL to a file under public/data — duckdb-wasm registers it as an HTTP
// source and range-reads it (footer + only the row groups/columns a query needs).
export function dataUrl(name: string): string {
  if (DATA_HOST && REMOTE_PREFIXES.some((p) => name.startsWith(p))) {
    return `${DATA_HOST}/${name}`; // e.g. the R2 public bucket URL
  }
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}${BASE_PATH}/data/${name}`;
}

// One shared duckdb-wasm instance, built lazily on the first run and reused
// across every snippet (mirrors the alizarin setup singleton). The wasm + worker
// are self-hosted under public/duckdb — no CDN at runtime.
let dbPromise: Promise<AsyncDuckDB> | null = null;

export function getDuck(): Promise<AsyncDuckDB> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const duckdb = await import('@duckdb/duckdb-wasm');
    // eh = WebAssembly exception handling (the common fast path); mvp is the
    // fallback for older engines. coi/pthreads is skipped — it needs COOP/COEP
    // headers a plain static host can't set.
    const bundles = {
      mvp: {
        mainModule: `${BASE_PATH}/duckdb/duckdb-mvp.wasm`,
        mainWorker: `${BASE_PATH}/duckdb/duckdb-browser-mvp.worker.js`,
      },
      eh: {
        mainModule: `${BASE_PATH}/duckdb/duckdb-eh.wasm`,
        mainWorker: `${BASE_PATH}/duckdb/duckdb-browser-eh.worker.js`,
      },
    };
    const bundle = await duckdb.selectBundle(bundles);
    const worker = new Worker(bundle.mainWorker!);
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    return db;
  })();
  return dbPromise;
}

// Kick off duckdb-wasm instantiation ahead of the first query (the ~8 MB gzipped
// module download + compile is the bulk of a cold run). Fire-and-forget on mount so
// the engine is warm by the time a reader clicks ▶. Shares the getDuck() singleton —
// calling it early just moves the one-time cost off the interaction's critical path.
export function warmDuck(): Promise<unknown> {
  return getDuck();
}

// Runnable examples live at content/docs/examples/<name>.tsx, each a default-
// exported `{ run }` whose marked body is the code block shown on the page. The
// template-literal import code-splits each into its own lazy chunk, fetched only
// when its ▶ button is clicked. Mirrors lib/alizarin.ts `testAlizarin`.
type RunnableExample = { default: { run: (sql?: string) => Promise<React.ReactNode> } };

function examplePath(module: string): string {
  return module.replace(/^\//, '').replace(/\.tsx?$/, '');
}

// Load the example module (lazy chunk) and run it with the caller's (edited) SQL.
export function runDuckExample(
  module: string = '/examples/query-tiles.tsx',
  sql?: string,
): Promise<React.ReactNode> {
  const path = examplePath(module);
  if (!/(^|\/)examples\/[^/]+$/.test(path)) {
    return Promise.resolve(
      React.createElement(
        'div',
        { className: 'alizarin-error' },
        `Not a runnable example: "${module}" (expected …/examples/<name>.tsx).`,
      ),
    );
  }
  return (
    import(
      /* webpackInclude: /examples\/[^/]+\.tsx$/ */
      `../content/docs/${path}`
    ) as Promise<RunnableExample>
  ).then((mod) => mod.default.run(sql));
}
