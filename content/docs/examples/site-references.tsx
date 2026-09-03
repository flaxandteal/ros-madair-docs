import * as React from 'react';
import { ensureAlizarin, queryResourceIds, hydrate } from '@/lib/rm-arches-client';
import { DEFAULT_SQL } from './site-references.default';

async function attr(model: unknown, alias: string): Promise<string> {
  try {
    const v = await (model as Record<string, Promise<unknown>>)[alias];
    return v == null ? '—' : String(v);
  } catch {
    return '—';
  }
}
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

// Select Sites by a reference (heritage_designation) and hydrate each. The
// reference resolves back to its controlled-list label on the typed model — the
// inverse of the id we queried on.
async function run(sql: string = DEFAULT_SQL): Promise<React.ReactNode> {
  await ensureAlizarin();
  const ids = await queryResourceIds(sql);
  if (!ids.length) return <div>0 resources.</div>;

  const rows = await Promise.all(
    ids.map(async (id) => {
      const r = await hydrate(id);
      return {
        name: await attr(r, 'name'),
        designation: await attr(r, 'heritage_designation'),
        parent: await linkName(r, 'parent_site'),
      };
    }),
  );

  return (
    <>
      <table>
        <thead>
          <tr><th>Site (name)</th><th>Heritage designation (reference)</th><th>Parent site →</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.name}</td>
              <td>{r.designation}</td>
              <td>{r.parent}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: '10px', opacity: 0.7 }}>
        selected by reference id · {rows.length} Site(s) · the reference resolves back to its label on the model
      </div>
    </>
  );
}

export default { run };
