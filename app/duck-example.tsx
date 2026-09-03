'use client';

import * as React from 'react';
import { runDuckExample } from '@/lib/duckdb';
import DuckErrorBoundary from './duck-error-boundary.tsx';

// A live, EDITABLE query card. The textarea is seeded with the example's default
// SQL; Run executes whatever it currently holds against the tile-row Parquet via
// duckdb-wasm (⌘/Ctrl+Enter also runs). Reuses the shared `.alizarin-example*`
// theme classes so it matches the alizarin docs' live cards.
export default function DuckExample({
  module,
  defaultSql,
}: {
  module: string;
  defaultSql: string;
}) {
  const [sql, setSql] = React.useState(defaultSql);
  const [running, setRunning] = React.useState(false);
  const [out, setOut] = React.useState<React.ReactNode>(null);
  const filename = module.split('/').filter(Boolean).pop() ?? 'example';

  const runIt = React.useCallback(() => {
    setRunning(true);
    setOut(<div className="alizarin-scratchspace">Loading duckdb-wasm + range-reading Parquet…</div>);
    Promise.resolve()
      .then(() => runDuckExample(module, sql))
      .then((node: React.ReactNode) => setOut(node ?? <div className="alizarin-scratchspace">(no rows)</div>))
      .catch((e: unknown) =>
        setOut(<div className="alizarin-error">Error: {e instanceof Error ? e.message : String(e)}</div>),
      )
      .finally(() => setRunning(false));
  }, [module, sql]);

  return (
    <div className="alizarin-example not-prose">
      <div className="alizarin-example-head">
        <span className="filename">{filename} · editable</span>
        <span className="alizarin-example-live">
          <span className="dot" />
          duckdb-wasm, live in your browser
        </span>
      </div>
      <div className="alizarin-example-body">
        <div className="alizarin-code">
          <textarea
            className="rm-editor"
            spellCheck={false}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                runIt();
              }
            }}
            rows={Math.min(20, sql.split('\n').length + 1)}
            aria-label="Editable SQL query"
          />
        </div>
        <div className="alizarin-run-box">
          <div className="rm-editor-actions">
            <button type="button" disabled={running} onClick={runIt}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M8 5v14l11-7Z" />
              </svg>
              {running ? 'Running…' : 'Run this query'}
            </button>
            <button
              type="button"
              className="rm-editor-reset"
              disabled={running || sql === defaultSql}
              onClick={() => setSql(defaultSql)}
            >
              Reset
            </button>
            <span className="rm-editor-hint">edit the SQL · ⌘/Ctrl+Enter to run</span>
          </div>
          {out && (
            <div className="alizarin-scratchspace">
              <DuckErrorBoundary resetKey={out}>
                <React.Suspense fallback={<span>Querying…</span>}>{out}</React.Suspense>
              </DuckErrorBoundary>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
