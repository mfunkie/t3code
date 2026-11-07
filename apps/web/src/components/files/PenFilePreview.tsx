import { lazy, Suspense, useEffect, useEffectEvent } from "react";

import { FileSurfaceLoading } from "./fileSurfaceChrome";

const PenViewer = lazy(() => import("./PenViewer"));

export function PenFilePreview(props: { readonly text: string; readonly onRefresh: () => void }) {
  const refresh = useEffectEvent(props.onRefresh);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Workspace refreshes only follow agent tools, so edits saved in pen.dev's own editor are picked up when the reader returns.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return (
    <Suspense fallback={<FileSurfaceLoading />}>
      <PenViewer text={props.text} />
    </Suspense>
  );
}
