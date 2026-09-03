import * as React from 'react';
import { ensureAlizarin, queryResourceIds, hydrate } from '@/lib/rm-arches-client';
import { DEFAULT_SQL } from './rich-resources.default';

// Best-effort read of an async view-model attribute → display string.
async function attr(model: unknown, alias: string): Promise<string> {
  try {
    const v = await (model as Record<string, Promise<unknown>>)[alias];
    if (v == null) return '—';
    return String(v);
  } catch {
    return '—';
  }
}

// Follow a resource-instance link and read the target's name — the link resolves
// lazily, which is itself another getResource served from Parquet.
async function linkName(model: unknown, alias: string): Promise<string> {
  try {
    const target = await (model as Record<string, Promise<unknown>>)[alias];
    if (!target) return '—';
    const t = Array.isArray(target) ? target[0] : target;
    return t ? await attr(t, 'name') : '—';
  } catch {
    return '—';
  }
}

// Run a query (edited or default) → resource ids → hydrate each into a rich
// alizarin model → render a few of its fields, including links followed live.
async function run(sql: string = DEFAULT_SQL): Promise<React.ReactNode> {
  await ensureAlizarin();
  const ids = await queryResourceIds(sql);
  if (!ids.length) return <div>0 resources.</div>;

  const rows = await Promise.all(
    ids.map(async (id) => {
      // Hydrate into a typed model (tiles not pruned, so attributes populate).
      const r = await hydrate(id);
      return {
        name: await attr(r, 'name'),
        model: await linkName(r, 'produced_by_model'),
        scenario: await linkName(r, 'scenario'),
        notes: (await attr(r, 'notes')).slice(0, 48),
      };
    }),
  );

  return (
    <>
      <table>
        <thead>
          <tr><th>Footprint (name)</th><th>Produced by model →</th><th>Scenario event →</th><th>Notes</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.name}</td>
              <td>{r.model}</td>
              <td>{r.scenario}</td>
              <td>{r.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: '10px', opacity: 0.7 }}>
        {rows.length} alizarin resource(s) hydrated from Parquet · → links followed live (each is another Parquet read)
      </div>
    </>
  );
}

export default { run };
