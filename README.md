# ros-madair-docs

Documentation site for [Rós Madair](https://github.com/flaxandteal/ros-madair) —
a static-file query engine for Arches heritage graph data.

Built with [Fumadocs](https://fumadocs.dev/) on Next.js. This is a deliberate
parallel of [`alizarin-docs`](https://github.com/flaxandteal/alizarin-docs): the
framework scaffold and the `app/global.css` theme are structurally identical, and
the `--az-*` CSS custom properties are kept as a **shared theme namespace**. The
only intended divergence is the token block at the top of `app/global.css` (the
Rós rose-madder palette) plus the wordmark, nav, and content. That seam is what a
future shared `@flaxandteal/docs-theme` package would extract.

## Develop

```bash
npm install
npm run dev      # http://localhost:3000
```

## Build

```bash
npm run build    # static export in out/
```

For a GitHub Pages build under a project path, set `NEXT_PUBLIC_BASE_PATH`
(e.g. `/ros-madair-docs`) — CI does this automatically.

## Content

Docs live in `content/docs/**` as MDX. Navigation order is controlled by
`meta.json` files. Unlike alizarin-docs, content is authored here directly rather
than synced from the source repo, to keep the Rós Madair Rust repo uncomplicated.

## License

AGPL-3.0-or-later (Flax & Teal Limited).
