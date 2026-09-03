import * as React from 'react';
import * as duckdb from '@duckdb/duckdb-wasm';
import { getDuck, dataUrl } from '@/lib/duckdb';
import { DEFAULT_SQL } from './layered-search.default';

const SITE = '64368e71-abbc-53ba-9bd8-87e2500f8e65';

// Register the base + overlay Site Parquet under short names, then run the
// (edited) composition query over both. The base layer is the emitted tiles; the
// overlay is the sparse re-designation layer.
async function run(sql: string = DEFAULT_SQL): Promise<React.ReactNode> {
  const db = await getDuck();
  await db.registerFileURL('base_sites.parquet', dataUrl(`tiles_${SITE}.parquet`), duckdb.DuckDBDataProtocol.HTTP, false);
  await db.registerFileURL('overlay_sites.parquet', dataUrl(`overlay/tiles_${SITE}.parquet`), duckdb.DuckDBDataProtocol.HTTP, false);

  const conn = await db.connect();
  try {
    const res = await conn.query(sql);
    const rows = res.toArray().map((r) => r.toJSON() as Record<string, unknown>);
    if (!rows.length) return <div>0 rows.</div>;
    const cols = Object.keys(rows[0]);

    return (
      <>
        <table>
          <thead>
            <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isOverlay = String(r.layer) === 'overlay';
              return (
                <tr key={i} style={isOverlay ? { color: 'var(--az-red)', fontWeight: 600 } : undefined}>
                  {cols.map((c) => <td key={c}>{r[c] == null ? '—' : String(r[c])}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ marginTop: '10px', opacity: 0.7 }}>
          {rows.length} result(s) across 2 layers · overlay rows in red win over base per resource + nodegroup
        </div>
      </>
    );
  } finally {
    await conn.close();
  }
}

export default { run };
