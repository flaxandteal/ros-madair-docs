'use client';

import { useEffect } from 'react';

// Next.js static export can't keep old lazy chunks around after a redeploy, so a
// tab left open across a deploy throws ChunkLoadError when it tries to lazy-load
// a chunk the new build renamed (now 404). Reload once to pull the current
// build. Guards:
//   - a sessionStorage flag prevents a reload loop if a chunk is *genuinely*
//     missing (the reloaded build fails the same way before the flag clears);
//   - the flag self-clears after the page has been stable for a few seconds, so
//     a later deploy in the same session still gets its one recovery reload.
export default function ChunkReload(): null {
  useEffect(() => {
    const isChunkError = (s?: string): boolean =>
      !!s && /ChunkLoadError|Loading chunk [\w-]+ failed/i.test(s);

    const reloadOnce = (): void => {
      if (sessionStorage.getItem('chunk-reloaded')) return;
      sessionStorage.setItem('chunk-reloaded', '1');
      window.location.reload();
    };

    const onError = (e: ErrorEvent): void => {
      if (isChunkError(e?.message) || isChunkError((e?.error as Error)?.name)) reloadOnce();
    };
    const onRejection = (e: PromiseRejectionEvent): void => {
      const r = e?.reason as { name?: string; message?: string } | undefined;
      if (isChunkError(r?.name) || isChunkError(r?.message)) reloadOnce();
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    const clear = window.setTimeout(() => sessionStorage.removeItem('chunk-reloaded'), 5000);

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      window.clearTimeout(clear);
    };
  }, []);

  return null;
}
