'use client';

import * as React from 'react';
import * as duckdb from '@duckdb/duckdb-wasm';
import { getDuck, dataUrl } from '@/lib/duckdb';

// Sample = single small files. Full = a CHUNKED corpus: geo-partitioned Parquet
// files + a manifest (the file-level zone-map). A query prunes chunks from the
// manifest, registers only the survivors, and range-fetches those — so total
// corpus size is unbounded while each file stays small. edges/overlay are single.
const CAT = 'concept_catalog_aonach.parquet';
const FILES = {
  sample: { single: 'tiles_aonach.parquet', edges: 'edges_aonach.parquet', ov: 'ov_aonach.parquet', ovUrl: 'overlay/tiles_aonach.parquet' },
  full: { edges: 'edges_aonach_full.parquet', ov: 'ov_aonach_full.parquet', ovUrl: 'overlay/tiles_aonach_full.parquet' },
} as const;
const SETS = {
  sample: { label: 'sample — 10 assets', note: 'A small, readable slice — named assets, the traps spelled out.' },
  full: { label: 'full city — chunked', note: 'Geo-partitioned chunks + a manifest; a query fetches only the chunks it needs.' },
} as const;
type SetKey = keyof typeof SETS;
type Chunk = { file: string; bytes: number; row_groups: number; buildings: number; geo: { w: number; e: number; s: number; n: number } | null };
type Manifest = { chunks: number; buildings: number; total_bytes: number; files: Chunk[] };

const FLOOD: [number, number, number, number][] = [[12, 40, 12, 12], [32, 40, 12, 12]]; // x,y,w,h cells
const EXTENT: [number, number, number, number] = [12, 40, 44, 52]; // x0,y0,x1,y1 union box

// ── duckdb-wasm plumbing ──────────────────────────────────────────────────────
const registered = new Set<string>();
async function reg(name: string, url: string) {
  if (registered.has(name)) return;
  const db = await getDuck();
  await db.registerFileURL(name, dataUrl(url), duckdb.DuckDBDataProtocol.HTTP, false);
  registered.add(name);
}
async function ensureBase() {
  await reg(CAT, CAT);
}
async function rows(sqlText: string): Promise<Record<string, unknown>[]> {
  await ensureBase();
  const c = await (await getDuck()).connect();
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

// tiles FROM-expression for a set, optionally geo-pruned; returns survivors so the
// caller can register them and report the fetch. Sync (uses the loaded manifest).
type TilesRef = { sql: string; files: Chunk[]; chunks: number; nChunks: number; bytes: number; total: number };
function tilesRef(set: SetKey, manifest: Manifest | null, box?: [number, number, number, number]): TilesRef {
  if (set === 'sample' || !manifest) {
    return { sql: `read_parquet('${FILES.sample.single}')`, files: [], chunks: 1, nChunks: 1, bytes: 0, total: 0 };
  }
  const hit = (g: Chunk['geo']) => g != null && (!box || !(g.w > box[2] || g.e < box[0] || g.s > box[3] || g.n < box[1]));
  const files = box ? manifest.files.filter((f) => hit(f.geo)) : manifest.files;
  const list = files.map((f) => `'${f.file}'`).join(',');
  return { sql: `read_parquet([${list}])`, files, chunks: files.length, nChunks: manifest.files.length, bytes: files.reduce((a, f) => a + f.bytes, 0), total: manifest.total_bytes };
}
async function registerTiles(set: SetKey, t: TilesRef) {
  if (set === 'sample') await reg(FILES.sample.single, FILES.sample.single);
  else await Promise.all(t.files.map((f) => reg(f.file, f.file)));
}
const edgesRef = async (set: SetKey) => { await reg(FILES[set].edges, FILES[set].edges); return `read_parquet('${FILES[set].edges}')`; };
const ovRef = async (set: SetKey) => { await reg(FILES[set].ov, FILES[set].ovUrl); return `read_parquet('${FILES[set].ov}')`; };
const mb = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} KB`);

// ── shared UI bits ────────────────────────────────────────────────────────────
function IR({ children }: { children: React.ReactNode }) { return <pre className="am-ir">{children}</pre>; }
function Count({ n, of, unit }: { n: number | null; of?: number; unit: string }) {
  if (n === null) return <div className="am-count am-muted">running…</div>;
  return <div className="am-count"><b>{n.toLocaleString()}</b>{of != null ? ` of ${of.toLocaleString()}` : ''} {unit}</div>;
}
function Fetch({ t }: { t: TilesRef }) {
  if (!t.total) return null;
  return <p className="am-note">Fetched <b>{t.chunks} of {t.nChunks}</b> chunks — {mb(t.bytes)} of {mb(t.total)} ({Math.round((100 * t.bytes) / t.total)}%). The rest were pruned from the manifest, never requested.</p>;
}
type TabProps = { set: SetKey; manifest: Manifest | null };

// ── tab: concept / range / list filter ───────────────────────────────────────
function FilterTab({ set, manifest }: TabProps) {
  const [f, setF] = React.useState({ mur: true, listed: false, pre: false, shelter: false, hospital: false });
  const [res, setRes] = React.useState<{ n: number; total: number; sample: Record<string, unknown>[]; t: TilesRef } | null>(null);
  const [ir, setIr] = React.useState('');
  React.useEffect(() => {
    let live = true;
    (async () => {
      setRes(null);
      const t = tilesRef(set, manifest);
      await registerTiles(set, t);
      const T = t.sql, C = `read_parquet('${CAT}')`;
      const parts: string[] = [], irp: string[] = [];
      if (f.mur) { parts.push(`SELECT DISTINCT x.resource_id FROM ${T} x JOIN ${C} c ON c.concept_id=x.concept_id WHERE x.nodegroup_id='profile' AND c.dfs_enter BETWEEN (SELECT dfs_enter FROM ${C} WHERE concept_id='MUR') AND (SELECT dfs_leave FROM ${C} WHERE concept_id='MUR')`); irp.push('Concept{ gem ⊑ "MUR" }'); }
      if (f.listed) { parts.push(`SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='profile' AND concept_ids LIKE '%"Listed"%'`); irp.push('Concept{ heritage is "Listed" }'); }
      if (f.pre) { parts.push(`SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='profile' AND q_ordered<=1970`); irp.push('Range{ year ≤ 1970 }'); }
      if (f.shelter) { parts.push(`SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='profile' AND concept_ids LIKE '%"Shelter"%'`); irp.push('Concept{ roles ∋ "Shelter" }'); }
      if (f.hospital) { parts.push(`SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='profile' AND concept_ids LIKE '%"Hospital"%'`); irp.push('Concept{ roles ∋ "Hospital" }'); }
      if (live) setIr(parts.length ? `All[ ${irp.join(',\n     ')} ]` : '# select one or more conditions');
      const total = await one(`SELECT count(*) FROM ${T} WHERE nodegroup_id='profile'`);
      if (!parts.length) { if (live) setRes({ n: 0, total, sample: [], t }); return; }
      const inner = parts.join('\nINTERSECT\n');
      const n = await one(`SELECT count(*) FROM (${inner})`);
      const sample = await rows(`SELECT y.descriptor_name, y.concept_id AS gem, y.concept_ids, y.q_ordered AS year FROM ${T} y JOIN (${inner}) m ON m.resource_id=y.resource_id WHERE y.nodegroup_id='profile' ORDER BY y.descriptor_name LIMIT 8`);
      if (live) setRes({ n, total, sample, t });
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, manifest, f.mur, f.listed, f.pre, f.shelter, f.hospital]);
  const chk = (k: keyof typeof f, label: string) => (<label className="am-chk"><input type="checkbox" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} /> {label}</label>);
  return (
    <div>
      <p>Tick conditions to build an <code>All[…]</code> query — GEM walks the concept hierarchy (one DFS range), roles test list membership, year is an ordered range.</p>
      <div className="am-controls">{chk('mur', 'unreinforced masonry (gem ⊑ MUR)')}{chk('listed', 'Listed')}{chk('pre', 'built ≤ 1970')}{chk('shelter', 'role ∋ Shelter')}{chk('hospital', 'role ∋ Hospital')}</div>
      <IR>{ir}</IR>
      <Count n={res ? res.n : null} of={res?.total} unit="assets match" />
      {res && <Fetch t={res.t} />}
      {res && res.sample.length > 0 && (
        <table><thead><tr><th>Asset</th><th>GEM</th><th>Concepts</th><th>Built</th></tr></thead>
          <tbody>{res.sample.map((r, i) => <tr key={i}><td>{String(r.descriptor_name)}</td><td><code>{String(r.gem)}</code></td><td><code>{String(r.concept_ids)}</code></td><td>{String(r.year)}</td></tr>)}</tbody></table>
      )}
    </div>
  );
}

// ── tab: OnTile vs All ────────────────────────────────────────────────────────
function OnTileTab({ set, manifest }: TabProps) {
  const [mode, setMode] = React.useState<'ontile' | 'all'>('ontile');
  const [n, setN] = React.useState<number | null>(null);
  const [evs, setEvs] = React.useState<Record<string, unknown>[]>([]);
  React.useEffect(() => {
    let live = true;
    (async () => {
      setN(null);
      const t = tilesRef(set, manifest); await registerTiles(set, t); const T = t.sql;
      const q = mode === 'ontile'
        ? `SELECT count(DISTINCT resource_id) FROM ${T} WHERE nodegroup_id='retrofit' AND concept_id='CR' AND q_ordered BETWEEN 1990 AND 2000 AND acc=TRUE`
        : `SELECT count(*) FROM (SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='retrofit' AND concept_id='CR' INTERSECT SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='retrofit' AND q_ordered BETWEEN 1990 AND 2000 INTERSECT SELECT DISTINCT resource_id FROM ${T} WHERE nodegroup_id='retrofit' AND acc=TRUE)`;
      const c = await one(q);
      const e = await rows(`SELECT descriptor_name, concept_id AS method, q_ordered AS year, acc FROM ${T} WHERE nodegroup_id='retrofit' ORDER BY resource_id, q_ordered LIMIT ${set === 'sample' ? 12 : 8}`);
      if (live) { setN(c); setEvs(e); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, manifest, mode]);
  return (
    <div>
      <p className="am-q">Which assets were structurally retrofitted to reinforced-concrete standard by an accredited contractor, between 1990 and 2000?</p>
      <div className="am-controls"><div className="am-seg">
        <button aria-pressed={mode === 'ontile'} onClick={() => setMode('ontile')}>OnTile · same event</button>
        <button aria-pressed={mode === 'all'} onClick={() => setMode('all')}>All · anywhere in the asset</button>
      </div></div>
      <IR>{mode === 'ontile' ? 'OnTile[  // ONE retrofit event carries all three\n  Concept{ method ⊑ "CR" }, Range{ year ∈ 1990…2000 }, accredited is true ]' : 'All[  // each condition met by SOME event, independently\n  Concept{ method ⊑ "CR" }, Range{ year ∈ 1990…2000 }, accredited is true ]'}</IR>
      <Count n={n} unit={mode === 'ontile' ? 'assets — one real retrofit event' : 'assets — conditions met somewhere'} />
      <p className="am-note">A “paper retrofit” — a CR job that wasn’t accredited plus an accredited job that wasn’t CR — passes <code>All</code> but not <code>OnTile</code>. {set === 'full' ? 'On the full corpus that gap is thousands of assets.' : 'Here it is Áras Cuain.'}</p>
      <table><thead><tr><th>Asset</th><th>Method</th><th>Year</th><th>Accredited</th></tr></thead>
        <tbody>{evs.map((r, i) => <tr key={i}><td>{String(r.descriptor_name)}</td><td><code>{String(r.method)}</code></td><td>{String(r.year)}</td><td>{r.acc ? '✓' : '✗'}</td></tr>)}</tbody></table>
    </div>
  );
}

// ── tab: spatial ──────────────────────────────────────────────────────────────
function SpatialTab({ set, manifest }: TabProps) {
  const [exact, setExact] = React.useState(true);
  const [spatial, setSpatial] = React.useState(true);
  const [q, setQ] = React.useState<'flood' | 'dry' | null>(null);
  const [out, setOut] = React.useState<{ n: number; refused: boolean; coarse: boolean; t: TilesRef } | null>(null);
  const missUnion = `(geo_min_lng>${EXTENT[2]} OR geo_max_lng<${EXTENT[0]} OR geo_min_lat>${EXTENT[3]} OR geo_max_lat<${EXTENT[1]})`;
  const hitCell = (c: number[]) => `NOT (geo_min_lng>${c[0] + c[2]} OR geo_max_lng<${c[0]} OR geo_min_lat>${c[1] + c[3]} OR geo_max_lat<${c[1]})`;
  const exactHit = FLOOD.map(hitCell).join(' OR ');
  React.useEffect(() => {
    let live = true;
    (async () => {
      if (!q) { setOut(null); return; }
      setOut(null);
      const t = tilesRef(set, manifest, EXTENT); await registerTiles(set, t); const T = t.sql;
      const eff = spatial ? exact : false;
      if (q === 'flood') {
        const where = eff ? `(${exactHit})` : `NOT ${missUnion}`;
        const n = await one(`SELECT count(*) FROM ${T} WHERE nodegroup_id='profile' AND ${where}`);
        if (live) setOut({ n, refused: false, coarse: !eff, t });
      } else {
        if (!spatial) { if (live) setOut({ n: 0, refused: true, coarse: false, t }); return; }
        const n = await one(`SELECT count(*) FROM ${T} WHERE nodegroup_id='profile' AND concept_ids LIKE '%"Shelter"%' AND NOT (${exactHit})`);
        if (live) setOut({ n, refused: false, coarse: false, t });
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, manifest, q, exact, spatial]);
  const seg = (label: string, on: boolean, click: () => void, danger = false) => (<button className={danger ? 'am-danger' : ''} aria-pressed={on} onClick={click}>{label}</button>);
  return (
    <div>
      <p>Footprints over a two-cell flood extent. Per-cell bbox overlap <em>is</em> the exact test for rectangular footprints — so “exact” and “coarse (union box)” are both real, no ST_Intersects needed. This is the no-spatial-extension, on-device path.</p>
      <div className="am-controls">
        <span className="am-lab">fine step</span><div className="am-seg">{seg('exact (per cell)', exact, () => setExact(true))}{seg('coarse (union box)', !exact, () => setExact(false))}</div>
        <span className="am-lab">spatial</span><div className="am-seg">{seg('available', spatial, () => setSpatial(true))}{seg('absent (mobile)', !spatial, () => setSpatial(false), true)}</div>
      </div>
      <div className="am-controls">
        <button className="am-run" onClick={() => setQ('flood')}>facilities in the flood extent · Bbox</button>
        <button className="am-run" onClick={() => setQ('dry')}>shelters NOT flooded · Not(Bbox)</button>
      </div>
      {out?.refused && <div className="am-banner am-err"><b>Query refused.</b> Negating a coarse superset would call a flooded shelter dry — <code>Not(Bbox)</code> requires the exact fine step, absent here.</div>}
      {out && !out.refused && out.coarse && <div className="am-banner am-warn">Coarse: a superset — assets inside the extent’s bounding box but between the flood cells are wrongly included.</div>}
      {q && <IR>{q === 'flood' ? 'Bbox{ footprint ∩ flood_extent }' : 'All[ roles ∋ "Shelter", Not(Bbox{ ∩ flood_extent }) ]'}</IR>}
      {out && !out.refused && <Count n={out.n} unit={q === 'flood' ? 'facilities intersect the flood extent' : 'dry shelters'} />}
      {out && <Fetch t={out.t} />}
    </div>
  );
}

// ── tab: zone map ─────────────────────────────────────────────────────────────
function ZonesTab({ set, manifest }: TabProps) {
  const [pts, setPts] = React.useState<Record<string, unknown>[]>([]);
  const [box, setBox] = React.useState<[number, number, number, number]>([12, 40, 28, 12]); // x,y,w,h
  const canvas = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    let live = true;
    (async () => {
      if (set === 'sample') { const t = tilesRef(set, manifest); await registerTiles(set, t); const r = await rows(`SELECT descriptor_name, concept_ids, geo_min_lng AS w, geo_min_lat AS s, geo_max_lng AS e, geo_max_lat AS n FROM ${t.sql} WHERE nodegroup_id='profile'`); if (live) setPts(r); }
      else if (live) setPts([]);
    })();
    return () => { live = false; };
  }, [set, manifest]);

  const bx = React.useMemo<[number, number, number, number]>(() => [box[0], box[1], box[0] + box[2], box[1] + box[3]], [box]);
  const chunks = React.useMemo(() => (set === 'full' && manifest ? manifest.files.filter((f) => f.geo) : []), [set, manifest]);
  const hitChunks = React.useMemo(() => chunks.filter((f) => f.geo && !(f.geo.w > bx[2] || f.geo.e < bx[0] || f.geo.s > bx[3] || f.geo.n < bx[1])), [chunks, bx]);

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
      const hitSet = new Set(hitChunks.map((f) => f.file));
      chunks.forEach((f) => { if (!f.geo) return; const on = hitSet.has(f.file); cx.globalAlpha = on ? 0.5 : 0.1; rect(f.geo.w, f.geo.s, f.geo.e, f.geo.n, on ? css('--am-accent') : css('--am-asset')); cx.globalAlpha = 1; rect(f.geo.w, f.geo.s, f.geo.e, f.geo.n, undefined, on ? css('--am-accent') : css('--am-asset')); });
    } else {
      pts.forEach((p) => { const inb = !((p.w as number) > bx[2] || (p.e as number) < bx[0] || (p.s as number) > bx[3] || (p.n as number) < bx[1]); rect(p.w as number, p.s as number, p.e as number, p.n as number, inb ? css('--am-hit') : css('--am-asset')); });
    }
    cx.strokeStyle = css('--am-flood'); cx.lineWidth = 2; cx.setLineDash([5, 3]); rect(bx[0], bx[1], bx[2], bx[3], undefined, css('--am-flood')); cx.setLineDash([]);
  }, [pts, box, set, chunks, hitChunks, bx]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = canvas.current; if (!cv) return; const r = cv.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100, y = ((e.clientY - r.top) / r.height) * 60;
    setBox([Math.max(0, Math.min(72, x - 14)), Math.max(0, Math.min(48, y - 6)), 28, 12]);
  };
  const fetched = hitChunks.reduce((a, f) => a + f.bytes, 0);
  const total = manifest?.total_bytes ?? 0;
  return (
    <div>
      <p className="am-q">Where is the data — and what does a query actually fetch?</p>
      <p>{set === 'full'
        ? 'Each rectangle is a chunk’s geo zone, read from the manifest (KB) — no coordinates downloaded. Click to move the query box: the lit chunks are the only files a spatial query fetches; the dim ones are pruned from the manifest, never requested. Within a fetched chunk, its own footer prunes row groups again.'
        : 'The 10 sample assets, plotted directly (small enough to fetch). Click to move the query box. On the full city this becomes a map of chunk zones from the manifest, not downloaded points.'}</p>
      <canvas ref={canvas} width={640} height={320} className="am-canvas" onClick={onClick} style={{ cursor: 'crosshair' }} />
      {set === 'full' && manifest && (
        <>
          <div className="am-count"><b>{hitChunks.length}</b> of {chunks.length} chunks fetched — {mb(fetched)} of {mb(total)} ({total ? Math.round((100 * fetched) / total) : 0}%)</div>
          <p className="am-note">Only the manifest (KB) + the lit chunks are requested — the rest of the corpus is never touched. Add chunks (finer partitions) or grow the corpus to GBs and the query still fetches only the handful it overlaps: cost is O(query), not O(corpus). A concept filter can’t prune <em>geo</em> chunks, so it scans the skinny <code>concept_id</code> column across them — the clustering tradeoff.</p>
        </>
      )}
    </div>
  );
}

// ── tab: cascade ──────────────────────────────────────────────────────────────
function CascadeTab({ set, manifest }: TabProps) {
  const [sub, setSub] = React.useState('');
  const [subs, setSubs] = React.useState<string[]>([]);
  const [deps, setDeps] = React.useState<{ n: number; sample: Record<string, unknown>[] } | null>(null);
  React.useEffect(() => {
    (async () => { const E = await edgesRef(set); setSubs((await rows(`SELECT DISTINCT target_resource FROM ${E} WHERE src_node='served_by' ORDER BY target_resource LIMIT 12`)).map((r) => String(r.target_resource))); })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set]);
  React.useEffect(() => {
    let live = true;
    (async () => {
      if (!sub) { setDeps(null); return; }
      const E = await edgesRef(set);
      const t = tilesRef(set, manifest); await registerTiles(set, t); const T = t.sql;
      const inner = `SELECT DISTINCT src_resource AS resource_id FROM ${E} WHERE src_node='served_by' AND target_resource='${sub}'`;
      const n = await one(`SELECT count(*) FROM (${inner})`);
      const sample = await rows(`SELECT y.descriptor_name, y.concept_ids FROM ${T} y JOIN (${inner}) d ON d.resource_id=y.resource_id WHERE y.nodegroup_id='profile' LIMIT 8`);
      if (live) setDeps({ n, sample });
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, manifest, sub]);
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

// ── tab: overlay ──────────────────────────────────────────────────────────────
function OverlayTab({ set, manifest }: TabProps) {
  const [storm, setStorm] = React.useState(false);
  const [out, setOut] = React.useState<{ total: number; damaged: number; sample: Record<string, unknown>[] } | null>(null);
  React.useEffect(() => {
    let live = true;
    (async () => {
      setOut(null);
      const t = tilesRef(set, manifest); await registerTiles(set, t); const T = t.sql; const OV = await ovRef(set);
      const total = await one(`SELECT count(*) FROM ${T} WHERE nodegroup_id='profile' AND concept_ids LIKE '%"Hospital"%'`);
      let damaged = 0; let sample: Record<string, unknown>[] = [];
      if (storm) {
        damaged = await one(`SELECT count(DISTINCT d.resource_id) FROM ${OV} d JOIN ${T} y ON y.resource_id=d.resource_id AND y.nodegroup_id='profile' AND y.concept_ids LIKE '%"Hospital"%' WHERE d.nodegroup_id='damage'`);
        sample = await rows(`SELECT y.descriptor_name, d.data FROM ${OV} d JOIN ${T} y ON y.resource_id=d.resource_id AND y.nodegroup_id='profile' AND y.concept_ids LIKE '%"Hospital"%' WHERE d.nodegroup_id='damage' LIMIT 8`);
      }
      if (live) setOut({ total, damaged, sample });
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, manifest, storm]);
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
  const [manifest, setManifest] = React.useState<Manifest | null>(null);
  React.useEffect(() => {
    let live = true;
    fetch(dataUrl('aonach_full_manifest.json')).then((r) => r.json()).then((m: Manifest) => { if (live) setManifest(m); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const Active = TABS.find((t) => t.k === tab)!.C;
  const corpusNote = set === 'full' && manifest
    ? `${manifest.chunks} geo chunks · ${manifest.buildings.toLocaleString()} assets · ${mb(manifest.total_bytes)}, remote. Only the chunks a query needs are fetched.`
    : SETS[set].note;
  return (
    <div className="am">
      <style>{AM_CSS}</style>
      <div className="am-corpus">
        <span className="am-lab">corpus</span>
        <div className="am-seg">
          <button aria-pressed={set === 'sample'} onClick={() => setSet('sample')}>{SETS.sample.label}</button>
          <button aria-pressed={set === 'full'} onClick={() => setSet('full')}>{SETS.full.label}</button>
        </div>
        <span className="am-corpus-note">{corpusNote}</span>
      </div>
      <div className="am-tabs">{TABS.map((t) => <button key={t.k} aria-current={tab === t.k} onClick={() => setTab(t.k)}>{t.label}</button>)}</div>
      <div className="am-body"><Active set={set} manifest={manifest} /></div>
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
.am-note{font-size:.85rem;opacity:.82;margin:.5rem 0;}
.am-banner{border-radius:5px;padding:.55rem .7rem;margin:.4rem 0;font-size:.85rem;}
.am-banner.am-err{border:1px solid var(--am-err);color:var(--am-err);}
.am-banner.am-warn{border:1px dashed var(--am-warn);color:var(--am-warn);}
.am-canvas{width:100%;max-width:640px;height:auto;border:1px solid var(--color-fd-border,#0002);border-radius:5px;margin-top:.6rem;background:var(--color-fd-card,transparent);}
.am table{font-size:.82rem;margin:.5rem 0;}
`;
