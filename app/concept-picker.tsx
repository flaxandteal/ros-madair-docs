'use client';

import * as React from 'react';
import { ensureAlizarin, getCollection, queryRows, hydrate } from '@/lib/rm-arches-client';

type Opt = { conceptId: string; valueId: string; label: string; depth: number };

async function attr(model: unknown, alias: string): Promise<string> {
  try {
    const v = await (model as Record<string, Promise<unknown>>)[alias];
    return v == null ? '—' : String(v);
  } catch {
    return '—';
  }
}

// A full alizarin → Rós Madair → alizarin roundtrip:
//  1. alizarin's RDM cache populates a hierarchical concept picker,
//  2. picking a concept builds a DescendantOrSelfOf query (self + descendant
//     value-ids, expanded from the same hierarchy),
//  3. the query runs against the tile-row Parquet,
//  4. the matches hydrate back into typed alizarin resources.
export default function ConceptPicker({
  collectionId,
  roleColumnFile,
}: {
  collectionId: string;
  roleColumnFile: string;
}) {
  const [opts, setOpts] = React.useState<Opt[]>([]);
  const [childIds, setChildIds] = React.useState<Record<string, string[]>>({});
  const [valueOf, setValueOf] = React.useState<Record<string, string>>({});
  const [labelOf, setLabelOf] = React.useState<Record<string, string>>({});
  const [selected, setSelected] = React.useState<string>('');
  const [sql, setSql] = React.useState<string>('');
  const [out, setOut] = React.useState<React.ReactNode>(null);
  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'running'>('loading');

  // Load the controlled list from alizarin and flatten it into indented options.
  React.useEffect(() => {
    let live = true;
    (async () => {
      await ensureAlizarin();
      const coll = await getCollection(collectionId);
      const concepts = coll.concepts ?? {};
      const kids: Record<string, string[]> = {};
      const vOf: Record<string, string> = {};
      const lOf: Record<string, string> = {};
      // Concepts nest: a top-level entry carries its narrower terms as child
      // OBJECTS (not id references), each with its own value id. Ingest the whole
      // tree, registering every concept's value id + label + child ids.
      type CNode = { id?: string; children?: (string | CNode)[]; prefLabels?: Record<string, { id: string; value: string }> };
      const ingest = (node: CNode) => {
        const cid = node.id;
        if (!cid || vOf[cid] !== undefined) return;
        const pl = node.prefLabels ? Object.values(node.prefLabels)[0] : undefined;
        vOf[cid] = pl?.id ?? cid;
        lOf[cid] = pl?.value ?? cid;
        const childNodes = (node.children ?? []).map((x) => (typeof x === 'string' ? (concepts as Record<string, CNode>)[x] ?? { id: x } : x));
        kids[cid] = childNodes.map((c) => c.id!).filter(Boolean);
        childNodes.forEach(ingest);
      };
      Object.values(concepts).forEach((c) => ingest(c as CNode));
      const childSet = new Set(Object.values(kids).flat());
      const tops = Object.keys(vOf).filter((id) => !childSet.has(id)).sort((a, b) => lOf[a].localeCompare(lOf[b]));
      const flat: Opt[] = [];
      const walk = (id: string, depth: number) => {
        flat.push({ conceptId: id, valueId: vOf[id], label: lOf[id], depth });
        [...(kids[id] ?? [])].sort((a, b) => lOf[a].localeCompare(lOf[b])).forEach((k) => walk(k, depth + 1));
      };
      tops.forEach((t) => walk(t, 0));
      if (!live) return;
      setChildIds(kids);
      setValueOf(vOf);
      setLabelOf(lOf);
      setOpts(flat);
      const hospital = flat.find((o) => o.label === 'Hospital') ?? flat[0];
      setSelected(hospital?.conceptId ?? '');
      setPhase('ready');
    })();
    return () => {
      live = false;
    };
  }, [collectionId]);

  const descendantValueIds = React.useCallback(
    (conceptId: string): string[] => {
      const acc: string[] = [];
      const visit = (id: string) => {
        acc.push(valueOf[id]);
        (childIds[id] ?? []).forEach(visit);
      };
      visit(conceptId);
      return acc.filter(Boolean);
    },
    [childIds, valueOf],
  );

  const runSelected = React.useCallback(
    async (conceptId: string) => {
      const valueIds = descendantValueIds(conceptId);
      const inList = valueIds.map((v) => `'${v}'`).join(', ');
      const query = `SELECT DISTINCT resource_id, concept_label
FROM read_parquet('${roleColumnFile}')
WHERE concept_id IN (${valueIds.length > 1 ? '\n  ' + valueIds.map((v) => `'${v}'`).join(',\n  ') + '\n' : inList});`;
      setSql(query);
      setPhase('running');
      setOut(<div className="alizarin-scratchspace">Querying Parquet + hydrating…</div>);
      try {
        const rows = await queryRows(query);
        if (!rows.length) {
          setOut(<div className="alizarin-scratchspace">0 resources tagged under “{labelOf[conceptId]}”.</div>);
          return;
        }
        const hydrated = await Promise.all(
          rows.map(async (r) => {
            const org = await hydrate(String(r.resource_id));
            return {
              name: await attr(org, 'name'),
              role: String(r.concept_label ?? '—'),
              sector: await attr(org, 'sector'),
            };
          }),
        );
        setOut(
          <>
            <table>
              <thead>
                <tr><th>Organisation (hydrated)</th><th>Matched role</th><th>Sector (concept)</th></tr>
              </thead>
              <tbody>
                {hydrated.map((h, i) => (
                  <tr key={i}><td>{h.name}</td><td>{h.role}</td><td>{h.sector}</td></tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: '10px', opacity: 0.7 }}>
              {hydrated.length} alizarin resource(s) · DescendantOrSelfOf(“{labelOf[conceptId]}”) = {valueIds.length} concept id(s)
            </div>
          </>,
        );
      } catch (e) {
        setOut(<div className="alizarin-error">Error: {e instanceof Error ? e.message : String(e)}</div>);
      } finally {
        setPhase('ready');
      }
    },
    [descendantValueIds, labelOf, roleColumnFile],
  );

  return (
    <div className="alizarin-example not-prose">
      <div className="alizarin-example-head">
        <span className="filename">concept-picker · alizarin → RM → alizarin</span>
        <span className="alizarin-example-live">
          <span className="dot" />
          {phase === 'loading' ? 'loading RDM…' : 'live in your browser'}
        </span>
      </div>
      <div className="alizarin-example-body">
        <div className="alizarin-run-box">
          <div className="rm-picker-row">
            <label htmlFor="concept-select">Concept (from alizarin RDM):</label>
            <select
              id="concept-select"
              className="rm-picker-select"
              disabled={phase !== 'ready' && phase !== 'running'}
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {opts.map((o) => (
                <option key={o.conceptId} value={o.conceptId}>
                  {`${'  '.repeat(o.depth)}${o.depth ? '└ ' : ''}${o.label}`}
                </option>
              ))}
            </select>
            <button type="button" disabled={phase === 'loading' || !selected} onClick={() => runSelected(selected)}>
              Build query &amp; run
            </button>
          </div>
          {sql && (
            <div className="alizarin-code">
              <pre className="rm-sql-preview">{sql}</pre>
            </div>
          )}
          {out && <div className="alizarin-scratchspace">{out}</div>}
        </div>
      </div>
    </div>
  );
}
