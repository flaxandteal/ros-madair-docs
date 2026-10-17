'use client';

// Critical facilities near ground zero — over 763k buildings, in your browser.
//
// The Rós Madair thesis, live: a static substrate (763k buildings, 6.98M tiles,
// served as plain Parquet over HTTP Range) answered in-page with no backend — and
// CHEAPLY, because every step prunes on sort order (the only thing Parquet gives
// without bloom filters):
//   • spatial  → the grid-cell edge (grid_<graph>.parquet), sorted by a Z-order
//                cell. `cellsInBox` (the shared wasm contract) → `cell IN (…)`
//                reads only the overlapping cells' row groups. No R-tree download.
//   • role     → the melted concept store, sorted by (node, concept).
//   • render   → the name + ward RIDE the grid's cell-pruned scan (render_summary),
//                so a result renders with NO scattered second fetch.
// The compiler (ros-madair wasm) lowers All[GridBox, Concept] to the SAME SQL the
// native engine runs; duckdb-wasm executes it.

import * as React from 'react';
import { getDuck } from '@/lib/duckdb';
import { registerPartitionedModel, compileQuery, cellsInBox, type Capabilities } from '@/lib/ros-madair';

const BUILDING = '0f366bdd-8e7f-519e-8ebc-ebff8a3e99a9';
const SERVICE_ROLES = 'd0d0c3f3-415f-5d6d-aee0-1c58f669ee7d'; // the service_roles node
const PREFIX = 'aonach763k';
const SHOW = 30; // cap the rendered sample

// A few real ward seeds (lng/lat) to drop "ground zero" on.
const GROUND_ZEROS: Array<{ label: string; lng: number; lat: number }> = [
  { label: 'Trá Bealtaine (coastal)', lng: 80.283, lat: 13.05 },
  { label: 'Cluain Mór (commercial)', lng: 80.241, lat: 13.058 },
  { label: 'Cé an Rí (port)', lng: 80.294, lat: 13.101 },
  { label: 'Seandún (riverine)', lng: 80.227, lat: 13.022 },
];

// The service-role concepts, in approximate rarity order. There is no vocab/catalog
// in this substrate, so emit stored the raw label as the concept id — the Concept
// filter's `value` IS the label. Hospital is sparse (snappy); Shelter is the dense
// case (the concept store does more work, still a fraction of the old cost).
const ROLES = [
  'Hospital',
  'Emergency operations centre',
  'Fire station',
  'Police station',
  'Water / pumping station',
  'School',
  'Muster point',
  'Shelter',
];

async function queryRows(sql: string): Promise<Record<string, unknown>[]> {
  const c = await (await getDuck()).connect();
  try {
    const r = await c.query(sql);
    return r.toArray().map((row: { toJSON: () => Record<string, unknown> }) => row.toJSON());
  } finally {
    await c.close();
  }
}

// Pull the first related title out of a render_summary blob ({nodeId:[{id,title}]}).
function wardOf(renderSummary: unknown): string {
  try {
    const obj = JSON.parse((renderSummary as string) || '{}');
    for (const entries of Object.values(obj) as Array<Array<{ title?: string }>>) {
      for (const e of entries) if (e?.title) return e.title;
    }
  } catch {
    /* ignore */
  }
  return '';
}

type Facility = { id: string; name: string; ward: string };
type Result = {
  total: number; // geo-bearing buildings indexed in the grid
  inBox: number; // buildings near ground zero (grid cells, cell-pruned)
  corpus: number; // facilities of this role in the whole corpus (concept store)
  near: number; // of this role, near ground zero (All[GridBox, Concept], compiled)
  sample: Facility[]; // first SHOW of them, name + ward from render_summary
  ms: number;
};

export default function Aonach763kDemo() {
  const [caps, setCaps] = React.useState<Capabilities | null>(null);
  const [role, setRole] = React.useState('Hospital');
  const [total, setTotal] = React.useState<number | null>(null);
  const [gz, setGz] = React.useState(0);
  const [radius, setRadius] = React.useState(0.02); // ~2 km
  const [res, setRes] = React.useState<Result | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // One-time: register the partitioned 763k Building model (tiles + melted stores +
  // grid + entry table), and read the grid's total count as the "footprints indexed".
  React.useEffect(() => {
    (async () => {
      try {
        const c = await registerPartitionedModel(PREFIX, BUILDING);
        if (!c.has_grid) throw new Error('this substrate has no grid edge — re-emit at FORMAT_VERSION 3');
        setCaps(c);
        // DISTINCT: a footprint spanning >1 cell has >1 grid row (the superset).
        const n = Number((await queryRows('SELECT count(DISTINCT resource_id) AS n FROM grid'))[0]?.n ?? 0);
        setTotal(n);
      } catch (e) {
        console.error('[763k] init error', e);
        setErr(String(e));
      }
    })();
  }, []);

  const run = React.useCallback(async () => {
    if (!caps || total == null) return;
    setBusy(true);
    setErr(null);
    const t0 = performance.now();
    try {
      const z = GROUND_ZEROS[gz];
      const [minLng, minLat, maxLng, maxLat] = [z.lng - radius, z.lat - radius, z.lng + radius, z.lat + radius];

      // 1) The box's grid cells — the shared wasm contract, 0 substrate bytes.
      const cells = await cellsInBox(minLng, minLat, maxLng, maxLat);

      // 2) Buildings near ground zero — a cell-pruned COUNT over the grid edge.
      const inBox = Number(
        (await queryRows(`SELECT count(DISTINCT resource_id) AS n FROM grid WHERE cell IN (${cells})`))[0]?.n ?? 0,
      );

      // 3) Corpus count of this role — node-scoped read of the melted concept store.
      const corpus = Number(
        (await queryRows(
          `SELECT count(*) AS n FROM concept_index \
           WHERE node_id = '${SERVICE_ROLES}' AND concept_id = '${role}'`,
        ))[0]?.n ?? 0,
      );

      // 4) Near AND of this role — the compiler lowers All[GridBox, Concept] to the
      //    SAME INTERSECT the native engine runs; count over it. Both sides prune.
      const nearSql = await compileQuery(
        {
          model: BUILDING,
          where: {
            all: [
              { grid_box: { path: 'footprint', min_lng: minLng, min_lat: minLat, max_lng: maxLng, max_lat: maxLat } },
              { concept: { path: 'service_roles', op: 'is', value: role } },
            ],
          },
        },
        caps,
      );
      const near = Number((await queryRows(`SELECT count(*) AS n FROM (${nearSql})`))[0]?.n ?? 0);

      // 5) The sample, WITH name + ward — a single cell-pruned grid⨝concept scan.
      //    The render columns ride the same cell prune: no scattered second fetch.
      const rows = await queryRows(
        `SELECT DISTINCT g.resource_id AS id, g.descriptor AS name, g.render_summary AS summary \
         FROM grid g JOIN concept_index c ON c.resource_id = g.resource_id \
         WHERE g.cell IN (${cells}) \
           AND c.node_id = '${SERVICE_ROLES}' AND c.concept_id = '${role}' \
         LIMIT ${SHOW}`,
      );
      const sample: Facility[] = rows.map((r) => ({
        id: r.id as string,
        name: (r.name as string) ?? '(unnamed)',
        ward: wardOf(r.summary),
      }));

      setRes({ total, inBox, corpus, near, sample, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      console.error('[763k] run error', e);
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [caps, total, gz, radius, role]);

  const ready = caps && total != null;

  // Auto-run once ready, and whenever a control changes — including the radius
  // slider, debounced so a drag fires one query at the end, not one per tick.
  React.useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => void run(), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, gz, role, radius]);

  return (
    <div style={{ border: '1px solid var(--color-fd-border,#333)', borderRadius: 8, padding: 16, margin: '1rem 0' }}>
      <strong>Critical facilities near ground zero — over 763k buildings, in your browser</strong>
      <p style={{ fontSize: 13, opacity: 0.8, margin: '6px 0 12px' }}>
        A static Parquet substrate (6.98M tiles) over HTTP Range. The grid-cell edge prunes the
        spatial search to a few row groups, the concept store prunes to the role, and each result’s
        name + ward ride that same cell-pruned scan (from <code>render_summary</code>) — no R-tree
        download, no tile scan, no second fetch.
      </p>

      {!ready && !err && <p>Loading the 763k substrate…</p>}
      {err && <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap', fontSize: 12 }}>{err}</pre>}

      {ready && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <label>
              Ground zero:{' '}
              <select value={gz} onChange={(e) => setGz(Number(e.target.value))}>
                {GROUND_ZEROS.map((z, i) => (
                  <option key={i} value={i}>{z.label}</option>
                ))}
              </select>
            </label>
            <label>
              Facility:{' '}
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
            <label>
              Radius: {(radius * 111).toFixed(1)} km{' '}
              <input type="range" min={0.005} max={0.06} step={0.005} value={radius}
                onChange={(e) => setRadius(Number(e.target.value))} />
            </label>
            <button onClick={run} disabled={busy} style={{ padding: '4px 12px' }}>
              {busy ? 'Querying…' : 'Find'}
            </button>
          </div>

          {res && (
            <div style={{ fontSize: 14 }}>
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 10, fontVariantNumeric: 'tabular-nums' }}>
                <span><b>{res.inBox.toLocaleString()}</b> of {res.total.toLocaleString()} buildings near ground zero <span style={{ opacity: 0.6 }}>(grid cells)</span></span>
                <span><b>{res.corpus.toLocaleString()}</b> × “{role}” in the corpus <span style={{ opacity: 0.6 }}>(concept store)</span></span>
                <span><b>{res.near.toLocaleString()}</b> near ground zero <span style={{ opacity: 0.6 }}>(All[GridBox, Concept])</span></span>
                <span style={{ opacity: 0.6 }}>{res.ms} ms</span>
              </div>
              {res.near ? (
                <ul style={{ margin: 0 }}>
                  {res.sample.map((h) => (
                    <li key={h.id}>{h.name}{h.ward ? ` — ${h.ward} ward` : ''}</li>
                  ))}
                  {res.near > res.sample.length && (
                    <li style={{ opacity: 0.6, listStyle: 'none' }}>…and {(res.near - res.sample.length).toLocaleString()} more</li>
                  )}
                </ul>
              ) : (
                <em style={{ opacity: 0.7 }}>No “{role}” within {(radius * 111).toFixed(1)} km — widen the radius or move ground zero.</em>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
