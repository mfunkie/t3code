import { lazy, Suspense } from "react";

import { FileSurfaceLoading } from "./fileSurfaceChrome";

const PenViewer = lazy(() => import("./PenViewer"));

export function PenFilePreview(props: { readonly text: string }) {
  return (
    <Suspense fallback={<FileSurfaceLoading />}>
      <PenViewer text={props.text} />
    </Suspense>
  );
}
