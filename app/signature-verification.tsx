'use client';

import * as React from 'react';

// An in-browser miniature of the reader-side gate `ros-madair-format`'s `verify`
// module runs natively (and `ros-madair-duck`'s `open_layers` enforces): for each
// layer, recompute the snapshot_id from the artifact bytes on disk and check it
// against the signed attestation. Three outcomes, exactly as `HeadTrust`:
//   • Verified  — content matches the signed id AND the signature checks out
//   • Unsigned  — no attestation: nobody vouched for this layer
//   • Failed    — content no longer hashes to the signed id (tampered), or the
//                 signature does not verify
// `open_layers` opens Verified/Unsigned layers and REFUSES a Failed one.
//
// The snapshot_id derivation mirrors `format::snapshot_id`: sha256 over the
// concatenated per-artifact sha256 hexes ++ the manifest's own sha256, truncated
// to 16 hex. Signatures are Ed25519 (the shipped curve) via WebCrypto — the demo
// generates a publisher key in-session and signs what it computes, so it is
// self-consistent without needing byte-for-byte parity with the Rust serializer.

type Trust =
  | { kind: 'verified' }
  | { kind: 'unsigned' }
  | { kind: 'failed'; reason: string }
  | { kind: 'pending' };

type Artifact = { path: string; bytes: Uint8Array };

type Layer = {
  id: string;
  name: string;
  role: 'base' | 'overlay';
  artifacts: Artifact[];
  // The attestation: the id that was signed + the detached signature. Absent ⇒ unsigned.
  signed?: { snapshotId: string; sig: Uint8Array };
  trust: Trust;
};

const enc = new TextEncoder();

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

async function sha256hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return hex(new Uint8Array(d));
}

/** The id-excluded "manifest" bytes for a layer — self-consistent stand-in for
 *  `manifest_digest_bytes` (compact JSON, snapshot_id omitted). */
function manifestBytes(layer: Pick<Layer, 'name' | 'role'>, artifactHashes: string[]): Uint8Array {
  return enc.encode(
    JSON.stringify({ name: layer.name, role: layer.role, format_version: 1, artifacts: artifactHashes }),
  );
}

/** Mirror of `format::snapshot_id`: sha256 over (each artifact's sha256 hex) ++
 *  (the manifest's sha256 hex), truncated to 16 hex. */
async function computeSnapshotId(layer: Pick<Layer, 'name' | 'role' | 'artifacts'>): Promise<string> {
  const hashes: string[] = [];
  for (const a of layer.artifacts) hashes.push(await sha256hex(a.bytes));
  const mHash = await sha256hex(manifestBytes(layer, hashes));
  const joined = enc.encode(hashes.join('') + mHash);
  return (await sha256hex(joined)).slice(0, 16);
}

// One publisher identity for the whole demo (generated in-session).
let keyPromise: Promise<CryptoKeyPair> | null = null;
function publisherKey(): Promise<CryptoKeyPair> {
  if (!keyPromise) {
    keyPromise = crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
  }
  return keyPromise;
}

async function sign(snapshotId: string): Promise<Uint8Array> {
  const { privateKey } = await publisherKey();
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, enc.encode(snapshotId) as unknown as ArrayBuffer);
  return new Uint8Array(sig);
}

/** The reader-side gate, per layer — the JS twin of `verify_snapshot`. */
async function verify(layer: Layer): Promise<Trust> {
  if (!layer.signed) return { kind: 'unsigned' };
  const recomputed = await computeSnapshotId(layer);
  if (recomputed !== layer.signed.snapshotId) {
    return {
      kind: 'failed',
      reason: `content hashes to ${recomputed}, but the signature covers ${layer.signed.snapshotId} — altered since it was signed`,
    };
  }
  const { publicKey } = await publisherKey();
  const ok = await crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    layer.signed.sig as unknown as ArrayBuffer,
    enc.encode(layer.signed.snapshotId) as unknown as ArrayBuffer,
  );
  return ok ? { kind: 'verified' } : { kind: 'failed', reason: 'the attestation signature does not verify' };
}

function artifact(path: string, body: string): Artifact {
  return { path, bytes: enc.encode(body) };
}

/** The three layers the demo starts with — one in each trust state. */
async function initialLayers(): Promise<Layer[]> {
  const base: Layer = {
    id: 'base',
    name: 'aonach-mor (published base)',
    role: 'base',
    artifacts: [
      artifact('tiles_site.parquet', 'PAR1…site tiles: Baile an Iarthair, Ceantar Theas, Mí Locha…'),
      artifact('edges_site.parquet', 'PAR1…site→place links…'),
      artifact('concept_catalog.parquet', 'PAR1…heritage_designation DFS intervals…'),
    ],
    trust: { kind: 'pending' },
  };
  const overlay: Layer = {
    id: 'overlay',
    name: 'on-device edits (unsigned overlay)',
    role: 'overlay',
    artifacts: [artifact('tiles_site.parquet', 'PAR1…overlay: Cé an Rí → Scheduled Monument…')],
    trust: { kind: 'pending' },
  };
  const mirror: Layer = {
    id: 'mirror',
    name: 'cdn mirror (tampered in transit)',
    role: 'base',
    artifacts: [
      artifact('tiles_site.parquet', 'PAR1…site tiles (mirror copy)…'),
      artifact('concept_catalog.parquet', 'PAR1…catalog (mirror copy)…'),
    ],
    trust: { kind: 'pending' },
  };

  // Sign base and mirror; leave the overlay unsigned. Then tamper the mirror.
  for (const l of [base, mirror]) {
    const snapshotId = await computeSnapshotId(l);
    l.signed = { snapshotId, sig: await sign(snapshotId) };
  }
  mirror.artifacts[0].bytes = enc.encode('PAR1…site tiles (mirror copy)… <a byte flipped by a bad proxy>');

  return [base, overlay, mirror];
}

const BADGE: Record<Exclude<Trust['kind'], 'pending'>, { label: string; bg: string; fg: string; mark: string }> = {
  verified: { label: 'Verified', bg: '#0f5132', fg: '#d1e7dd', mark: '✓' },
  unsigned: { label: 'Unsigned', bg: '#664d03', fg: '#fff3cd', mark: '⚠' },
  failed: { label: 'Failed', bg: '#842029', fg: '#f8d7da', mark: '✗' },
};

export default function SignatureVerification() {
  const [layers, setLayers] = React.useState<Layer[]>([]);
  const [supported, setSupported] = React.useState<boolean | null>(null);

  const reverify = React.useCallback(async (ls: Layer[]) => {
    const out = await Promise.all(ls.map(async (l) => ({ ...l, trust: await verify(l) })));
    setLayers(out);
  }, []);

  React.useEffect(() => {
    (async () => {
      try {
        await publisherKey(); // probes WebCrypto Ed25519 support
        setSupported(true);
        await reverify(await initialLayers());
      } catch {
        setSupported(false);
      }
    })();
  }, [reverify]);

  // Mutators: flip a layer's state, then re-run the gate over the whole stack.
  const mutate = (id: string, f: (l: Layer) => void) => {
    const next = layers.map((l) => {
      if (l.id !== id) return l;
      const copy: Layer = { ...l, artifacts: l.artifacts.map((a) => ({ ...a, bytes: a.bytes.slice() })) };
      f(copy);
      return copy;
    });
    void reverify(next);
  };

  const tamper = (id: string) =>
    mutate(id, (l) => {
      const a = l.artifacts[0];
      a.bytes = enc.encode(new TextDecoder().decode(a.bytes) + '!');
    });
  const resign = async (id: string) => {
    const target = layers.find((l) => l.id === id);
    if (!target) return;
    const snapshotId = await computeSnapshotId(target);
    const signed = { snapshotId, sig: await sign(snapshotId) };
    void reverify(layers.map((l) => (l.id === id ? { ...l, signed } : l)));
  };
  const unsign = (id: string) => mutate(id, (l) => (l.signed = undefined));

  if (supported === false) {
    return (
      <div className="alizarin-example not-prose">
        <div className="alizarin-error">
          This demo needs WebCrypto Ed25519, which your browser does not expose. Try a recent
          Chrome, Firefox, or Safari.
        </div>
      </div>
    );
  }

  const anyFailed = layers.some((l) => l.trust.kind === 'failed');

  return (
    <div className="alizarin-example not-prose">
      <div className="alizarin-example-head">
        <span className="filename">layer signature verification</span>
        <span className="alizarin-example-live">
          <span className="dot" />
          WebCrypto, live in your browser
        </span>
      </div>
      <div className="alizarin-example-body" style={{ display: 'grid', gap: '0.75rem' }}>
        {layers.length === 0 && <div className="alizarin-scratchspace">Generating a publisher key + signing layers…</div>}

        {layers.map((l) => {
          const b = l.trust.kind === 'pending' ? null : BADGE[l.trust.kind];
          return (
            <div
              key={l.id}
              style={{
                border: '1px solid var(--color-fd-border, #33333a)',
                borderRadius: 8,
                padding: '0.75rem 0.9rem',
                display: 'grid',
                gap: '0.4rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                {b && (
                  <span
                    style={{
                      background: b.bg,
                      color: b.fg,
                      borderRadius: 999,
                      padding: '0.1rem 0.6rem',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {b.mark} {b.label}
                  </span>
                )}
                <strong>{l.name}</strong>
                <span style={{ opacity: 0.6, fontSize: '0.8rem' }}>({l.role})</span>
              </div>

              <div style={{ fontSize: '0.82rem', opacity: 0.85, fontFamily: 'var(--font-mono, monospace)' }}>
                {l.trust.kind === 'verified' && l.signed && <>signed id {l.signed.snapshotId} — recomputed, matches, signature ok</>}
                {l.trust.kind === 'unsigned' && <>no attestations.json — nobody has vouched for this layer</>}
                {l.trust.kind === 'failed' && l.trust.reason}
                {l.trust.kind === 'pending' && <>verifying…</>}
              </div>

              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                <button className="rm-btn-secondary" style={btn} onClick={() => tamper(l.id)}>
                  Tamper an artifact
                </button>
                {l.signed ? (
                  <button className="rm-btn-secondary" style={btn} onClick={() => unsign(l.id)}>
                    Remove signature
                  </button>
                ) : (
                  <button className="rm-btn-secondary" style={btn} onClick={() => void resign(l.id)}>
                    Re-sign (publish)
                  </button>
                )}
                {l.trust.kind === 'failed' && l.signed && (
                  <button className="rm-btn-secondary" style={btn} onClick={() => void resign(l.id)}>
                    Re-sign current bytes
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {layers.length > 0 && (
          <div
            style={{
              marginTop: '0.25rem',
              padding: '0.6rem 0.9rem',
              borderRadius: 8,
              fontWeight: 600,
              background: anyFailed ? '#842029' : '#0f5132',
              color: anyFailed ? '#f8d7da' : '#d1e7dd',
            }}
          >
            open_layers verdict: {anyFailed ? '✗ REFUSED — a layer failed verification' : '✓ OPENS — no tampered layer'}
          </div>
        )}
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  fontSize: '0.8rem',
  padding: '0.25rem 0.7rem',
  borderRadius: 6,
  cursor: 'pointer',
};
