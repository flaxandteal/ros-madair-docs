import * as React from 'react';
import * as duckdb from '@duckdb/duckdb-wasm';
import { getDuck, dataUrl } from '@/lib/duckdb';
import { DEFAULT_SQL } from './query-tiles.default';

// Format one result cell for display. DuckDB hands back BigInt (counts, day
// numbers), Date (DATE columns), and nested objects (JSON) — none of which React
// renders directly.
function cell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Run a query (the edited SQL, or the default) against the tile-row Parquet and
// render its rows. If a `data` column comes back it is hydrated — parsed from the
// tile-detail JSON and its scalar fields spread into columns (Arches tile-graph
// hydration, in miniature).
async function run(sql: string = DEFAULT_SQL): Promise<React.ReactNode> {
  const db = await getDuck();
  // Register the remote Parquet files as HTTP sources — duckdb range-reads them
  // (footer + only the row groups a query needs), not a full download.
  await db.registerFileURL('tiles_place.parquet', dataUrl('tiles_place.parquet'), duckdb.DuckDBDataProtocol.HTTP, false);
  await db.registerFileURL('concept_catalog.parquet', dataUrl('concept_catalog.parquet'), duckdb.DuckDBDataProtocol.HTTP, false);

  const conn = await db.connect();
  try {
    const res = await conn.query(sql);
    const fields: string[] = res.schema.fields.map((f: { name: string }) => f.name);
    const hasData = fields.includes('data');
    const shown = fields.filter((f) => f !== 'data');

    const rows = res.toArray().map((r) => {
      const o = r.toJSON() as Record<string, unknown>;
      const base: Record<string, string> = {};
      for (const f of shown) base[f] = cell(o[f]);
      if (hasData) {
        try {
          const d = JSON.parse(String(o.data)) as { population?: number; geometry?: { coordinates?: [number, number] } };
          base['population'] = d.population ? d.population.toLocaleString() : '—';
          const c = d.geometry?.coordinates;
          base['lng, lat'] = c ? `${c[0].toFixed(3)}, ${c[1].toFixed(3)}` : '—';
        } catch {
          base['data'] = cell(o.data);
        }
      }
      return base;
    });

    const cols = rows.length ? Object.keys(rows[0]) : shown;
    if (!rows.length) return <div>0 rows.</div>;

    return (
      <>
        <table>
          <thead>
            <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>{cols.map((c) => <td key={c}>{r[c] ?? '—'}</td>)}</tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: '10px', opacity: 0.7 }}>{rows.length} row(s) · hydrated in-browser from tile-row Parquet</div>
      </>
    );
  } finally {
    await conn.close();
  }
}

export default { run };
