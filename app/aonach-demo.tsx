'use client';

import * as React from 'react';
import * as duckdb from '@duckdb/duckdb-wasm';
import { getDuck, dataUrl } from '@/lib/duckdb';

// Two corpora, same schema — the toggle just swaps the files. `sample` is the
// hand-built 10-asset teaching slice; `full` is the city-scale synthesis
// (60,000 assets, ~2.8 MB, 44 row groups) that duckdb-wasm range-fetches from the
// CDN, pulling only the row groups a query's zone-map admits — never the whole file.
const SETS = {
  sample: { tiles: 'tiles_aonach.parquet', edges: 'edges_aonach.parquet', ovUrl: 'overlay/tiles_aonach.parquet', ov: 'ov_aonach.parquet', label: 'sample — 10 assets', note: 'A small, readable slice: named assets, the exact traps spelled out.' },
  full: { tiles: 'tiles_aonach_full.parquet', edges: 'edges_aonach_full.parquet', ovUrl: 'overlay/tiles_aonach_full.parquet', ov: 'ov_aonach_full.parquet', label: 'full city — 60,000 assets', note: '2.8 MB · 44 row groups, remote. Only the row groups a filter admits are fetched.' },
};
const CAT = 'concept_catalog_aonach.parquet';
type SetKey = keyof typeof SETS;

// flood extent = two cells; a footprint in the gap (x24–32) is a coarse-only match.
const FLOOD: [number, number, number, number][] = [[12, 40, 12, 12], [32, 40, 12, 12]];
const EXTENT = [12, 40, 44, 52]; // union bbox [minx,miny,maxx,maxy]

const registered = new Set<string>();
async function connect() {
  const db = await getDuck();
  const reg = async (name: string, url: string) => {
    if (registered.has(name)) return;
    await db.registerFileURL(name, dataUrl(url), duckdb.DuckDBDataProtocol.HTTP, false);
    registered.add(name);
  };
  await reg(CAT, CAT);
  for (const k of Object.keys(SETS) as SetKey[]) {
    await reg(SETS[k].tiles, SETS[k].tiles);
    await reg(SETS[k].edges, SETS[k].edges);
    await reg(SETS[k].ov, SETS[k].ovUrl);
  }
  return db.connect();
}
async function rows(sqlText: string): Promise<Record<string, unknown>[]> {
  const c = await connect();
  try {
    const r = await c.query(sqlText);
    return r.toArray().map((x) => {
      const o = x.toJSON() as Record<string, unknown>;
      for (const k of Object.keys(o)) if (typeof o[k] === 'bigint') o[k] = Number(o[k]);
      return o;
    });
  } finally {
    await c.close();
  }
}
const one = async (sqlText: string) => Number(Object.values((await rows(sqlText))[0] ?? { n: 0 })[0]);

// ── shared bits ──────────────────────────────────────────────────────────────
function IR({ children }: { children: React.ReactNode }) {
  return <pre className="am-ir">{children}</pre>;
}
function Count({ n, of, unit }: { n: number | null; of?: number; unit: string }) {
  if (n === null) return <div className="am-count am-muted">running…</div>;
  return <div className="am-count"><b>{n.toLocaleString()}</b>{of != null ? ` of ${of.toLocaleString()}` : ''} {unit}</div>;
}

// ── tab: concept / range / list filter ───────────────────────────────────────
function FilterTab({ set }: { set: SetKey }) {
  const [f, setF] = React.useState({ mur: true, listed: false, pre: false, shelter: false, hospital: false });
  const [res, setRes] = React.useState<{ n: number; total: number; sample: Record<string, unknown>[] } | null>(null);
  const T = `read_parquet('${SETS[set].tiles}')`, C = `read_parquet('${CAT}')`;
  const parts: string[] = [], ir: string[] = [];
  if (f.mur) { parts.push(`SELECT DISTINCT t.resource_id FROM ${T} t JOIN ${C} c ON c.concept_id=t.concept_id WHERE t.nodegroup_id='profile' AND c.dfs_enter BETWEEN (SELECT dfs_enter FROM ${C} WHERE concept_id='MUR') AND (SELECT dfs_leave FROM ${C} WHERE concept_id='MUR')`); ir.push('Concept{ gem ⊑ "MUR" }'); }
  if (f.listed) { parts.push(`SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='profile' AND concept_ids LIKE '%"Listed"%'`); ir.push('Concept{ heritage is "Listed" }'); }
  if (f.pre) { parts.push(`SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='profile' AND q_ordered<=1970`); ir.push('Range{ year ≤ 1970 }'); }
  if (f.shelter) { parts.push(`SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='profile' AND concept_ids LIKE '%"Shelter"%'`); ir.push('Concept{ roles ∋ "Shelter" }'); }
  if (f.hospital) { parts.push(`SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='profile' AND concept_ids LIKE '%"Hospital"%'`); ir.push('Concept{ roles ∋ "Hospital" }'); }

  React.useEffect(() => {
    let live = true;
    (async () => {
      setRes(null);
      const total = await one(`SELECT count(*) FROM ${T} WHERE nodegroup_id='profile'`);
      if (!parts.length) { if (live) setRes({ n: 0, total, sample: [] }); return; }
      const inner = parts.join('\nINTERSECT\n');
      const n = await one(`SELECT count(*) FROM (${inner})`);
      const sample = await rows(`SELECT t.descriptor_name, t.concept_id AS gem, t.concept_ids, t.q_ordered AS year FROM ${T} t JOIN (${inner}) m ON m.resource_id=t.resource_id WHERE t.nodegroup_id='profile' ORDER BY t.descriptor_name LIMIT 8`);
      if (live) setRes({ n, total, sample });
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, f.mur, f.listed, f.pre, f.shelter, f.hospital]);

  const chk = (k: keyof typeof f, label: string) => (
    <label className="am-chk"><input type="checkbox" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} /> {label}</label>
  );
  return (
    <div>
      <p>Tick conditions to build an <code>All[…]</code> query. The GEM filter walks the concept hierarchy (one DFS-interval range); role filters test list membership; the year filter is an ordered range.</p>
      <div className="am-controls">{chk('mur', 'unreinforced masonry (gem ⊑ MUR)')}{chk('listed', 'Listed')}{chk('pre', 'built ≤ 1970')}{chk('shelter', 'role ∋ Shelter')}{chk('hospital', 'role ∋ Hospital')}</div>
      <IR>{parts.length ? `All[ ${ir.join(',\n     ')} ]` : '# select one or more conditions'}</IR>
      <Count n={res ? res.n : null} of={res?.total} unit="assets match" />
      {res && res.sample.length > 0 && (
        <table><thead><tr><th>Asset</th><th>GEM</th><th>Concepts</th><th>Built</th></tr></thead>
          <tbody>{res.sample.map((r, i) => <tr key={i}><td>{String(r.descriptor_name)}</td><td><code>{String(r.gem)}</code></td><td><code>{String(r.concept_ids)}</code></td><td>{String(r.year)}</td></tr>)}</tbody></table>
      )}
    </div>
  );
}

// ── tab: OnTile vs All ────────────────────────────────────────────────────────
function OnTileTab({ set }: { set: SetKey }) {
  const [mode, setMode] = React.useState<'ontile' | 'all'>('ontile');
  const [n, setN] = React.useState<number | null>(null);
  const [evs, setEvs] = React.useState<Record<string, unknown>[]>([]);
  const T = `read_parquet('${SETS[set].tiles}')`;
  React.useEffect(() => {
    let live = true;
    (async () => {
      setN(null);
      const q = mode === 'ontile'
        ? `SELECT count(DISTINCT resource_id) FROM ${T} WHERE nodegroup_id='retrofit' AND concept_id='CR' AND q_ordered BETWEEN 1990 AND 2000 AND acc=TRUE`
        : `SELECT count(*) FROM (SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='retrofit' AND concept_id='CR' INTERSECT SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='retrofit' AND q_ordered BETWEEN 1990 AND 2000 INTERSECT SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='retrofit' AND acc=TRUE)`;
      const c = await one(q);
      const e = await rows(`SELECT descriptor_name, concept_id AS method, q_ordered AS year, acc FROM ${T} WHERE nodegroup_id='retrofit' ORDER BY resource_id, q_ordered LIMIT ${set === 'sample' ? 12 : 8}`);
      if (live) { setN(c); setEvs(e); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, mode]);
  return (
    <div>
      <p className="am-q">Which assets were structurally retrofitted to reinforced-concrete standard by an accredited contractor, between 1990 and 2000?</p>
      <div className="am-controls">
        <div className="am-seg">
          <button aria-pressed={mode === 'ontile'} onClick={() => setMode('ontile')}>OnTile · same event</button>
          <button aria-pressed={mode === 'all'} onClick={() => setMode('all')}>All · anywhere in the asset</button>
        </div>
      </div>
      <IR>{mode === 'ontile'
        ? 'OnTile[  // ONE retrofit event carries all three\n  Concept{ method ⊑ "CR" }, Range{ year ∈ 1990…2000 }, accredited is true ]'
        : 'All[  // each condition met by SOME event, independently\n  Concept{ method ⊑ "CR" }, Range{ year ∈ 1990…2000 }, accredited is true ]'}</IR>
      <Count n={n} unit={mode === 'ontile' ? 'assets — one real retrofit event' : 'assets — conditions met somewhere'} />
      <p className="am-note">A “paper retrofit” — a CR job that wasn’t accredited plus an accredited job that wasn’t CR — passes <code>All</code> but not <code>OnTile</code>. On the full corpus that gap is {set === 'full' ? 'thousands of assets' : 'Áras Cuain'}: the difference between a real retrofit and one that only looks like it on paper.</p>
      <table><thead><tr><th>Asset</th><th>Method</th><th>Year</th><th>Accredited</th></tr></thead>
        <tbody>{evs.map((r, i) => <tr key={i}><td>{String(r.descriptor_name)}</td><td><code>{String(r.method)}</code></td><td>{String(r.year)}</td><td>{r.acc ? '✓' : '✗'}</td></tr>)}</tbody></table>
    </div>
  );
}

// ── tab: spatial (coarse bbox, per-cell exact, Not-refusal) ──────────────────
function SpatialTab({ set }: { set: SetKey }) {
  const [exact, setExact] = React.useState(true);
  const [spatial, setSpatial] = React.useState(true);
  const [q, setQ] = React.useState<'flood' | 'dry' | null>(null);
  const [out, setOut] = React.useState<{ n: number; refused: boolean; coarse: boolean } | null>(null);
  const [pts, setPts] = React.useState<Record<string, unknown>[]>([]);
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const T = `read_parquet('${SETS[set].tiles}')`;
  const missUnion = `(geo_min_lng>${EXTENT[2]} OR geo_max_lng<${EXTENT[0]} OR geo_min_lat>${EXTENT[3]} OR geo_max_lat<${EXTENT[1]})`;
  const hitCell = (c: number[]) => `NOT (geo_min_lng>${c[0] + c[2]} OR geo_max_lng<${c[0]} OR geo_min_lat>${c[1] + c[3]} OR geo_max_lat<${c[1]})`;
  const exactHit = FLOOD.map(hitCell).join(' OR ');

  React.useEffect(() => {
    let live = true;
    (async () => {
      // sample: fetch footprints for the map
      if (set === 'sample') setPts(await rows(`SELECT resource_id, descriptor_name, concept_ids, geo_min_lng, geo_min_lat, geo_max_lng, geo_max_lat FROM ${T} WHERE nodegroup_id='profile'`));
      if (!q) { if (live) setOut(null); return; }
      setOut(null);
      const eff = spatial ? exact : false; // no spatial ⇒ only the union-bbox coarse
      if (q === 'flood') {
        const where = eff ? `(${exactHit})` : `NOT ${missUnion}`;
        const n = await one(`SELECT count(*) FROM ${T} WHERE nodegroup_id='profile' AND ${where}`);
        if (live) setOut({ n, refused: false, coarse: !eff });
      } else {
        if (!spatial) { if (live) setOut({ n: 0, refused: true, coarse: false }); return; }
        const n = await one(`SELECT count(*) FROM ${T} WHERE nodegroup_id='profile' AND concept_ids LIKE '%"Shelter"%' AND NOT (${exactHit})`);
        if (live) setOut({ n, refused: false, coarse: false });
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, q, exact, spatial]);

  // draw the sample map
  React.useEffect(() => {
    if (set !== 'sample' || !canvas.current) return;
    const cx = canvas.current.getContext('2d'); if (!cx) return;
    const W = canvas.current.width, H = canvas.current.height;
    const tx = (x: number) => 16 + (x / 100) * (W - 32), ty = (y: number) => 12 + (y / 60) * (H - 24);
    const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#888';
    const rect = (r: number[], fill?: string, stroke?: string) => {
      const x = tx(r[0]), y = ty(r[1]), w = tx(r[0] + r[2]) - tx(r[0]), h = ty(r[1] + r[3]) - ty(r[1]);
      if (fill) { cx.fillStyle = fill; cx.fillRect(x, y, w, h); }
      if (stroke) { cx.strokeStyle = stroke; cx.lineWidth = 1.5; cx.strokeRect(x, y, w, h); }
    };
    cx.clearRect(0, 0, W, H);
    cx.globalAlpha = 0.4; FLOOD.forEach((f) => rect(f, css('--am-flood') || '#2a4a7a')); cx.globalAlpha = 1;
    const eff = spatial ? exact : false;
    pts.forEach((p) => {
      const fp = [Number(p.geo_min_lng), Number(p.geo_min_lat), Number(p.geo_max_lng) - Number(p.geo_min_lng), Number(p.geo_max_lat) - Number(p.geo_min_lat)];
      const isShelter = String(p.concept_ids).includes('"Shelter"');
      let hit = false;
      const ov = (a: number[], b: number[]) => a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
      if (q === 'flood') hit = eff ? FLOOD.some((c) => ov(fp, c)) : ov(fp, [EXTENT[0], EXTENT[1], EXTENT[2] - EXTENT[0], EXTENT[3] - EXTENT[1]]);
      else if (q === 'dry' && spatial) hit = isShelter && !FLOOD.some((c) => ov(fp, c));
      rect(fp, hit ? (css('--am-hit') || '#2f7d4f') : (css('--am-asset') || '#889'));
    });
  }, [set, pts, q, exact, spatial]);

  const seg = (label: string, on: boolean, click: () => void, danger = false) => (
    <button className={danger ? 'am-danger' : ''} aria-pressed={on} onClick={click}>{label}</button>
  );
  return (
    <div>
      <p>Footprints over a two-cell flood extent. Because footprints are rectangles, per-cell bbox overlap <em>is</em> the exact test — so “exact” and “coarse (union box)” are both real here, no ST_Intersects needed. There is no spatial extension in the browser, so this <em>is</em> the on-device path.</p>
      <div className="am-controls">
        <span className="am-lab">fine step</span>
        <div className="am-seg">{seg('exact (per cell)', exact, () => setExact(true))}{seg('coarse (union box)', !exact, () => setExact(false))}</div>
        <span className="am-lab">spatial</span>
        <div className="am-seg">{seg('available', spatial, () => setSpatial(true))}{seg('absent (mobile)', !spatial, () => setSpatial(false), true)}</div>
      </div>
      <div className="am-controls">
        <button className="am-run" onClick={() => setQ('flood')}>facilities in the flood extent · Bbox</button>
        <button className="am-run" onClick={() => setQ('dry')}>shelters NOT flooded · Not(Bbox)</button>
      </div>
      {out?.refused && <div className="am-banner am-err"><b>Query refused.</b> Negating a coarse superset would call a flooded shelter dry. <code>Not(Bbox)</code> requires the exact fine step — absent here.</div>}
      {out && !out.refused && out.coarse && <div className="am-banner am-warn">Coarse: a superset — assets inside the extent’s bounding box but between the flood cells are wrongly included.</div>}
      {q && <IR>{q === 'flood' ? 'Bbox{ footprint ∩ flood_extent }' : 'All[ roles ∋ "Shelter", Not(Bbox{ ∩ flood_extent }) ]'}</IR>}
      {out && !out.refused && <Count n={out.n} unit={q === 'flood' ? 'facilities intersect the flood extent' : 'dry shelters'} />}
      {set === 'sample' && <canvas ref={canvas} width={640} height={300} className="am-canvas" />}
      {set === 'full' && <p className="am-note">Run over 60,000 assets: the coarse box admits a superset, the per-cell exact step trims it — the difference is the assets in the gap between flood cells.</p>}
    </div>
  );
}

// ── tab: cascade (cited_by) ───────────────────────────────────────────────────
function CascadeTab({ set }: { set: SetKey }) {
  const [sub, setSub] = React.useState('');
  const [subs, setSubs] = React.useState<string[]>([]);
  const [deps, setDeps] = React.useState<{ n: number; sample: Record<string, unknown>[] } | null>(null);
  const T = `read_parquet('${SETS[set].tiles}')`, E = `read_parquet('${SETS[set].edges}')`;
  React.useEffect(() => {
    (async () => { setSubs((await rows(`SELECT DISTINCT target_resource FROM ${E} WHERE src_node='served_by' ORDER BY target_resource LIMIT 12`)).map((r) => String(r.target_resource))); })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set]);
  React.useEffect(() => {
    let live = true;
    (async () => {
      if (!sub) { setDeps(null); return; }
      const inner = `SELECT DISTINCT src_resource AS resource_id FROM ${E} WHERE src_node='served_by' AND target_resource='${sub}'`;
      const n = await one(`SELECT count(*) FROM (${inner})`);
      const sample = await rows(`SELECT t.descriptor_name, t.concept_ids FROM ${T} t JOIN (${inner}) d ON d.resource_id=t.resource_id WHERE t.nodegroup_id='profile' LIMIT 8`);
      if (live) setDeps({ n, sample });
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, sub]);
  return (
    <div>
      <p className="am-q">If a substation goes down, what goes dark?</p>
      <p>Pick a substation — its dependents (every asset whose <code>served_by</code> points at it) come straight off the edge table, read backwards.</p>
      <div className="am-controls">{subs.map((s) => <button key={s} className="am-run am-sub" aria-pressed={sub === s} onClick={() => setSub(s)}>{s}</button>)}</div>
      {sub && <IR>{`cited_by( served_by, "${sub}" )`}</IR>}
      {deps && <Count n={deps.n} unit={`assets lose power if ${sub} fails`} />}
      {deps && deps.sample.length > 0 && (
        <table><thead><tr><th>Dependent asset</th><th>Roles / concepts</th></tr></thead>
          <tbody>{deps.sample.map((r, i) => <tr key={i}><td>{String(r.descriptor_name)}</td><td><code>{String(r.concept_ids)}</code></td></tr>)}</tbody></table>
      )}
    </div>
  );
}

// ── tab: overlay (base ⊕ live damage) ────────────────────────────────────────
function OverlayTab({ set }: { set: SetKey }) {
  const [storm, setStorm] = React.useState(false);
  const [out, setOut] = React.useState<{ total: number; damaged: number; sample: Record<string, unknown>[] } | null>(null);
  const T = `read_parquet('${SETS[set].tiles}')`, OV = `read_parquet('${SETS[set].ov}')`;
  React.useEffect(() => {
    let live = true;
    (async () => {
      setOut(null);
      const total = await one(`SELECT count(*) FROM ${T} WHERE nodegroup_id='profile' AND concept_ids LIKE '%"Hospital"%'`);
      let damaged = 0; let sample: Record<string, unknown>[] = [];
      if (storm) {
        damaged = await one(`SELECT count(DISTINCT d.resource_id) FROM ${OV} d JOIN ${T} t ON t.resource_id=d.resource_id AND t.nodegroup_id='profile' AND t.concept_ids LIKE '%"Hospital"%' WHERE d.nodegroup_id='damage'`);
        sample = await rows(`SELECT t.descriptor_name, d.data FROM ${OV} d JOIN ${T} t ON t.resource_id=d.resource_id AND t.nodegroup_id='profile' AND t.concept_ids LIKE '%"Hospital"%' WHERE d.nodegroup_id='damage' LIMIT 8`);
      }
      if (live) setOut({ total, damaged, sample });
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, storm]);
  return (
    <div>
      <p className="am-q">Show hospitals reporting structural damage right now.</p>
      <p>The base snapshot is read-only and signed. Field damage reports arrive as a separate overlay layer, composed at query time — the base never changes.</p>
      <div className="am-controls"><label className="am-chk"><input type="checkbox" checked={storm} onChange={(e) => setStorm(e.target.checked)} /> Storm Bealtaine — live damage overlay active</label></div>
      <IR>{storm ? 'All[ roles ∋ "Hospital", damage_reported ∈ now ]   // base ⊕ overlay' : 'All[ roles ∋ "Hospital" ]   // base only'}</IR>
      <Count n={out ? (storm ? out.damaged : out.total) : null} of={storm ? out?.total : undefined} unit={storm ? 'hospitals reporting damage' : 'hospitals (base registry)'} />
      {out && storm && out.sample.length > 0 && (
        <table><thead><tr><th>Hospital</th><th>Live report</th></tr></thead>
          <tbody>{out.sample.map((r, i) => { let rep = '—'; try { rep = (JSON.parse(String(r.data)) as { damage?: string }).damage ?? '—'; } catch { /* */ } return <tr key={i}><td>{String(r.descriptor_name)}</td><td>{rep}</td></tr>; })}</tbody></table>
      )}
    </div>
  );
}

// ── tab: zone map (clustering from the footer, no coords downloaded) ──────────
type Zone = { rg: number; w: number; e: number; s: number; n: number };
function ZonesTab({ set }: { set: SetKey }) {
  const [zones, setZones] = React.useState<Zone[]>([]);
  const [pts, setPts] = React.useState<Record<string, unknown>[]>([]);
  const [box, setBox] = React.useState<[number, number, number, number]>([12, 40, 28, 12]); // x,y,w,h — the flood extent
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const T = SETS[set].tiles;
  React.useEffect(() => {
    let live = true;
    (async () => {
      if (set === 'full') {
        // The zones are precomputed from the footer into a tiny sidecar (a few KB),
        // so the map needs neither the coords nor a range-capable server.
        const resp = await fetch(dataUrl('zones_aonach_full.json'));
        const z = (await resp.json()) as Zone[];
        if (live) setZones(z);
      } else {
        if (live) setPts(await rows(`SELECT descriptor_name, geo_min_lng AS w, geo_min_lat AS s, geo_max_lng AS e, geo_max_lat AS n FROM read_parquet('${T}') WHERE nodegroup_id='profile'`));
      }
    })();
    return () => { live = false; };
  }, [set, T]);

  const bx = React.useMemo<[number, number, number, number]>(() => [box[0], box[1], box[0] + box[2], box[1] + box[3]], [box]); // x0,y0,x1,y1
  const hit = React.useMemo(() => zones.filter((z) => !(z.w > bx[2] || z.e < bx[0] || z.s > bx[3] || z.n < bx[1])), [zones, bx]);

  React.useEffect(() => {
    const cv = canvas.current; if (!cv) return; const cx = cv.getContext('2d'); if (!cx) return;
    const W = cv.width, H = cv.height;
    const tx = (x: number) => 10 + (x / 100) * (W - 20), ty = (y: number) => 8 + (y / 60) * (H - 16);
    const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#888';
    const rect = (x0: number, y0: number, x1: number, y1: number, fill?: string, stroke?: string) => {
      const x = tx(x0), y = ty(y0), w = tx(x1) - tx(x0), h = ty(y1) - ty(y0);
      if (fill) { cx.fillStyle = fill; cx.fillRect(x, y, w, h); }
      if (stroke) { cx.strokeStyle = stroke; cx.lineWidth = 1; cx.strokeRect(x, y, w, h); }
    };
    cx.clearRect(0, 0, W, H);
    if (set === 'full') {
      const hitSet = new Set(hit.map((z) => z.rg));
      zones.forEach((z) => { const on = hitSet.has(z.rg); cx.globalAlpha = on ? 0.5 : 0.12; rect(z.w, z.s, z.e, z.n, on ? css('--am-accent') : css('--am-asset')); cx.globalAlpha = 1; rect(z.w, z.s, z.e, z.n, undefined, on ? css('--am-accent') : css('--am-asset')); });
    } else {
      pts.forEach((p) => { const inb = !((p.w as number) > bx[2] || (p.e as number) < bx[0] || (p.s as number) > bx[3] || (p.n as number) < bx[1]); rect(p.w as number, p.s as number, p.e as number, p.n as number, inb ? css('--am-hit') : css('--am-asset')); });
    }
    cx.strokeStyle = css('--am-flood'); cx.lineWidth = 2; cx.setLineDash([5, 3]); rect(bx[0], bx[1], bx[2], bx[3], undefined, css('--am-flood')); cx.setLineDash([]);
  }, [zones, pts, box, set, hit, bx]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = canvas.current; if (!cv) return; const r = cv.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100, y = ((e.clientY - r.top) / r.height) * 60;
    setBox([Math.max(0, Math.min(72, x - 14)), Math.max(0, Math.min(48, y - 6)), 28, 12]);
  };

  return (
    <div>
      <p className="am-q">Where is the data — and what does a query actually fetch?</p>
      <p>{set === 'full'
        ? 'Each rectangle is a row-group zone, read from the Parquet footer only — the min/max of its geo columns. No coordinates are downloaded. Click the map to move the query box: the lit zones are the only row groups a spatial query fetches; the dim ones are pruned from the footer, never touched.'
        : 'The 10 sample assets, plotted directly (small enough to fetch). Click to move the query box — assets inside turn green. On the full city this becomes a zone map read from the footer, not 60,000 downloaded points.'}</p>
      <canvas ref={canvas} width={640} height={320} className="am-canvas" onClick={onClick} style={{ cursor: 'crosshair' }} />
      {set === 'full' && zones.length > 0 && (
        <>
          <div className="am-count"><b>{hit.length}</b> of {zones.length} geo zones fetched — {Math.round((100 * hit.length) / zones.length)}% of the file, the rest pruned from the footer (~KB)</div>
          <p className="am-note">Only the footer (a few KB) plus the lit row groups are pulled over HTTP range — never the 2.8&nbsp;MB file. A concept filter can’t prune these <em>geo</em> zones (categorical), so it scans the skinny <code>concept_id</code> column across them instead — the clustering tradeoff, and why clustering is an index-time choice.</p>
        </>
      )}
    </div>
  );
}

const TABS = [
  { k: 'filter', label: 'Concept · Range · List', C: FilterTab },
  { k: 'ontile', label: 'OnTile vs All', C: OnTileTab },
  { k: 'spatial', label: 'Spatial + Not', C: SpatialTab },
  { k: 'zones', label: 'Zone map', C: ZonesTab },
  { k: 'cascade', label: 'cited_by cascade', C: CascadeTab },
  { k: 'overlay', label: 'Base ⊕ overlay', C: OverlayTab },
] as const;

export default function AonachDemo() {
  const [set, setSet] = React.useState<SetKey>('sample');
  const [tab, setTab] = React.useState<(typeof TABS)[number]['k']>('filter');
  const Active = TABS.find((t) => t.k === tab)!.C;
  return (
    <div className="am">
      <style>{AM_CSS}</style>
      <div className="am-corpus">
        <span className="am-lab">corpus</span>
        <div className="am-seg">
          <button aria-pressed={set === 'sample'} onClick={() => setSet('sample')}>{SETS.sample.label}</button>
          <button aria-pressed={set === 'full'} onClick={() => setSet('full')}>{SETS.full.label}</button>
        </div>
        <span className="am-corpus-note">{SETS[set].note}</span>
      </div>
      <div className="am-tabs">{TABS.map((t) => <button key={t.k} aria-current={tab === t.k} onClick={() => setTab(t.k)}>{t.label}</button>)}</div>
      <div className="am-body"><Active set={set} /></div>
    </div>
  );
}

const AM_CSS = `
:root{--am-accent:#0d7d84;--am-flood:#2a4a7a;--am-hit:#2f7d4f;--am-asset:#7f97a3;}
@media (prefers-color-scheme:dark){:root{--am-accent:#3fb8be;--am-flood:#6d94d4;--am-hit:#57b97e;--am-asset:#5b7480;}}
.am{--am-accent:#0d7d84;--am-flood:#2a4a7a;--am-hit:#2f7d4f;--am-asset:#8aa;--am-err:#b1521d;--am-warn:#8f3f13;
  border:1px solid var(--color-fd-border,#0002);border-radius:8px;padding:1rem 1.1rem;margin:1.2rem 0;font-size:.92rem;}
@media (prefers-color-scheme:dark){.am{--am-accent:#3fb8be;--am-flood:#6d94d4;--am-hit:#57b97e;--am-asset:#567;}}
.am code{font-size:.86em;}
.am-corpus,.am-controls{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-bottom:.7rem;}
.am-corpus{padding-bottom:.7rem;border-bottom:1px solid var(--color-fd-border,#0001);}
.am-lab{font-family:var(--font-mono,monospace);font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;opacity:.6;}
.am-corpus-note{font-size:.8rem;opacity:.65;}
.am-tabs{display:flex;flex-wrap:wrap;gap:.35rem;margin:.8rem 0;}
.am-tabs button{font-size:.78rem;padding:.35rem .6rem;border-radius:5px;border:1px solid var(--color-fd-border,#0002);background:transparent;cursor:pointer;color:inherit;}
.am-tabs button[aria-current="true"]{background:var(--am-accent);color:#fff;border-color:var(--am-accent);}
.am-seg{display:inline-flex;border:1px solid var(--color-fd-border,#0002);border-radius:5px;overflow:hidden;}
.am-seg button{font-size:.76rem;border:none;background:transparent;color:inherit;padding:.35rem .6rem;cursor:pointer;}
.am-seg button[aria-pressed="true"]{background:var(--am-accent);color:#fff;}
.am-seg button.am-danger[aria-pressed="true"]{background:var(--am-err);}
.am-chk{font-size:.85rem;display:inline-flex;align-items:center;gap:.35rem;cursor:pointer;border:1px solid var(--color-fd-border,#0002);border-radius:5px;padding:.3rem .55rem;}
.am-run{font-size:.78rem;padding:.35rem .65rem;border-radius:5px;border:1px solid var(--am-accent);background:transparent;color:inherit;cursor:pointer;}
.am-run[aria-pressed="true"],.am-sub[aria-pressed="true"]{background:var(--am-accent);color:#fff;}
.am-ir{font-family:var(--font-mono,monospace);font-size:.76rem;line-height:1.5;background:var(--color-fd-muted,#0001);border:1px solid var(--color-fd-border,#0001);border-radius:5px;padding:.6rem .7rem;overflow-x:auto;white-space:pre-wrap;margin:.5rem 0;}
.am-q{font-style:italic;font-size:1.05rem;margin:.2rem 0 .7rem;}
.am-q::before{content:"\\201C";}.am-q::after{content:"\\201D";}
.am-count{font-family:var(--font-mono,monospace);margin:.4rem 0 .6rem;}
.am-count b{color:var(--am-accent);font-size:1.2rem;}
.am-muted{opacity:.6;}
.am-note{font-size:.85rem;opacity:.8;margin:.5rem 0;}
.am-banner{border-radius:5px;padding:.55rem .7rem;margin:.4rem 0;font-size:.85rem;}
.am-banner.am-err{border:1px solid var(--am-err);color:var(--am-err);}
.am-banner.am-warn{border:1px dashed var(--am-warn);color:var(--am-warn);}
.am-canvas{width:100%;max-width:640px;height:auto;border:1px solid var(--color-fd-border,#0002);border-radius:5px;margin-top:.6rem;}
.am table{font-size:.82rem;margin:.5rem 0;}
`;
