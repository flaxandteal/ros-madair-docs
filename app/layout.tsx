import './global.css';
import { RootProvider } from 'fumadocs-ui/provider';
import ChunkReload from './chunk-reload.tsx';
import { League_Spartan, Caveat } from 'next/font/google';
import localFont from 'next/font/local';
import type { CSSProperties, ReactNode } from 'react';

// Display / UI face — replaces Inter. Lowercase wordmark + headings.
const leagueSpartan = League_Spartan({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '900'],
  variable: '--font-display',
  display: 'swap',
});

// Handwriting — used only for the two hero annotations.
const caveat = Caveat({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-hand',
  display: 'swap',
});

// Body — Kumbh Sans (variable). YOPQ axis is pinned in global.css.
const kumbhSans = localFont({
  src: './fonts/KumbhSans-Variable.ttf',
  variable: '--font-body',
  display: 'swap',
  weight: '100 900',
});

// GitHub Pages serves under /ros-madair-docs. CSS url() is NOT rewritten by
// Next for basePath, so texture URLs are injected here as CSS variables.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export default function Layout({ children }: { children: ReactNode }) {
  const rootStyle = {
    '--az-grain': `url(${basePath}/textures/paper-grain.png)`,
    '--az-mottle': `url(${basePath}/textures/paper-mottle.png)`,
    '--az-bar-light': `url(${basePath}/textures/bar-teal-trim.png)`,
    '--az-bar-dark': `url(${basePath}/textures/bar-teal-dark.png)`,
    '--az-disc-light': `url(${basePath}/textures/disc-plant.png)`,
    '--az-disc-dark': `url(${basePath}/textures/disc-plant-dark.png)`,
  } as CSSProperties;

  return (
    <html
      lang="en"
      className={`${leagueSpartan.variable} ${caveat.variable} ${kumbhSans.variable}`}
      style={rootStyle}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <ChunkReload />
        <RootProvider
          search={{
            options: {
              type: 'static'
            }
          }}
        >{children}</RootProvider>
      </body>
    </html>
  );
}
