import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="az-landing">
      <section className="az-hero">
        <div className="az-hero-mottle az-hero-mottle-1" aria-hidden />
        <div className="az-hero-mottle az-hero-mottle-2" aria-hidden />
        <div className="az-disc" aria-hidden />

        <div className="az-hero-content">
          <div className="az-wordmark az-display">rós madair</div>
          <div className="az-lockup">
            <span className="az-bar" aria-hidden />
            <span className="az-tagline az-display">static-file queries over heritage graphs</span>
          </div>

          <h1 className="az-subhead az-display">
            Query Arches heritage data from a CDN — no server, no database
          </h1>

          <div className="az-cta">
            <Link className="az-btn az-btn-primary" href="/docs/quickstart">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M13 2 4 14h6l-1 8 9-12h-6Z" /></svg>
              Get started
            </Link>
            <Link className="az-btn az-btn-secondary" href="/docs">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><path d="M3 5h7a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H3Zm18 0h-7a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h7Z" /></svg>
              View documentation
            </Link>
          </div>
        </div>

        <div className="az-ann az-ann-1 az-hand" aria-hidden>
          Pre-ground pigment to Alizarin&apos;s live colour mixing.
          <div className="rule" />
        </div>

        <div className="az-ann az-ann-2 az-hand" aria-hidden>
          <span>Fetch only the fragments a query needs.</span>
          <svg width="72" height="26" viewBox="0 0 72 26" fill="none" stroke="var(--az-ink-hand)" strokeWidth="1" style={{ flex: 'none', marginTop: '12px' }}>
            <path d="M1 4c22 0 44 6 64 14" />
            <path d="M58 20l7 0-2-6" />
          </svg>
        </div>

        <div className="az-features">
          <div className="az-feature">
            <svg width="27" height="27" viewBox="0 0 24 24" fill="var(--az-red)" stroke="var(--az-red)" strokeWidth="1.4" strokeLinejoin="round" style={{ flex: 'none', marginTop: '1px' }} aria-hidden><path d="M13 2 4 14h6l-1 8 9-12h-6Z" /></svg>
            <div>
              <h3>No backend</h3>
              <p>Artifacts are flat files on any static host — S3, GitHub Pages, a CDN. No database, no API server.</p>
            </div>
          </div>
          <div className="az-feature">
            <svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="var(--az-red)" strokeWidth="2.1" strokeLinecap="round" style={{ flex: 'none', marginTop: '1px' }} aria-hidden><circle cx="12" cy="5" r="2.4" fill="var(--az-red)" /><circle cx="5" cy="18" r="2.4" fill="var(--az-red)" /><circle cx="19" cy="18" r="2.4" fill="var(--az-red)" /><path d="M11 7.5 6.6 15.6M13 7.5l4.4 8.1M7.6 18h8.8" /></svg>
            <div>
              <h3>Surgical fetching</h3>
              <p>A query consults a small indexed head, then pulls only the tile fragments it needs via HTTP Range.</p>
            </div>
          </div>
          <div className="az-feature">
            <svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="var(--az-red)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', marginTop: '1px' }} aria-hidden><path d="m8.5 7.5-4.5 4.5 4.5 4.5M15.5 7.5 20 12l-4.5 4.5" /></svg>
            <div>
              <h3>Arches-native</h3>
              <p>Compiles alizarin graph + resource data and hydrates tiles into a schema-shaped tree.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="az-bindings">
        <div className="az-bindings-head">
          <h2>Emit static artifacts</h2>
          <div className="az-install">
            <span className="prompt">$</span>
            <span style={{ whiteSpace: 'nowrap' }}>cargo run -p ros-madair-emit --release -- data out</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.6 }} aria-hidden><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5h10" /></svg>
          </div>
        </div>
        <div className="az-bind-grid">
          <Link className="az-bind-card" href="/docs/quickstart">
            <div className="title">head.sqlite</div>
            <div className="desc">The coarse index a query plans against.</div>
          </Link>
          <Link className="az-bind-card" href="/docs/quickstart">
            <div className="title">chunks/*.msgpack</div>
            <div className="desc">Content-hashed tile detail for hydration.</div>
          </Link>
          <Link className="az-bind-card" href="/docs/how-it-works/overview">
            <div className="title">manifest.json</div>
            <div className="desc">Layout + format-version contract.</div>
          </Link>
          <Link className="az-bind-card" href="/docs/how-it-works/overview">
            <div className="title">DuckDB + Parquet</div>
            <div className="desc">Where the read substrate is heading.</div>
          </Link>
        </div>
      </section>

      <footer className="az-footer">
        <div>
          <div className="az-footer-brand">
            <span className="dot" />Rós Madair
          </div>
          <p className="az-footer-blurb">
            A static-file query engine for Arches heritage graph data, built and maintained by Flax &amp; Teal Limited, Belfast.
          </p>
          <p className="az-footer-license">AGPL-3.0-or-later — derived works must publish their source.</p>
        </div>
        <div className="az-footer-col">
          <div className="heading">Docs</div>
          <Link href="/docs">Introduction</Link>
          <Link href="/docs/installation">Installation</Link>
          <Link href="/docs/quickstart">Quickstart</Link>
          <Link href="/docs/how-it-works/overview">How it works</Link>
        </div>
        <div className="az-footer-col">
          <div className="heading">Related</div>
          <a href="https://github.com/flaxandteal/alizarin">Alizarin</a>
          <a href="https://archesproject.org">Arches project</a>
          <a href="https://flaxandteal.co.uk">Flax &amp; Teal</a>
        </div>
        <div className="az-footer-col">
          <div className="heading">Project</div>
          <a href="https://github.com/flaxandteal/ros-madair">GitHub</a>
        </div>
      </footer>
    </main>
  );
}
