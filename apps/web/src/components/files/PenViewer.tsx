import { useEffectEvent, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { MinusIcon, PlusIcon, ScanIcon } from "lucide-react";

import { Select, SelectItem, SelectPopup, SelectTrigger } from "~/components/ui/select";
import { observeResize } from "~/lib/observeResize";

import { FileSurfaceAction, FileSurfaceFailure, FileSurfaceNotice } from "./fileSurfaceChrome";
import {
  defaultTheme,
  navigableFrames,
  parsePenDocument,
  type PenDocument,
  type PenFrameTarget,
  type PenTheme,
} from "./penDocument";
import { PenCanvasContent } from "./penRender";

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 8;
const FIT_MARGIN = 32;
const AS_DESIGNED = "__as_designed__";

interface View {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface RootLabel extends Rect {
  readonly label: string;
}

const clampZoom = (scale: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));

function unionRect(rects: ReadonlyArray<Rect>): Rect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function fitView(target: Rect, viewport: { width: number; height: number }): View {
  const scale = clampZoom(
    Math.min(
      2,
      (viewport.width - FIT_MARGIN * 2) / Math.max(target.width, 1),
      (viewport.height - FIT_MARGIN * 2) / Math.max(target.height, 1),
    ),
  );
  return {
    scale,
    x: (viewport.width - target.width * scale) / 2 - target.x * scale,
    y: (viewport.height - target.height * scale) / 2 - target.y * scale,
  };
}

/** Canvas-space rect of an element inside the transformed world. */
function worldRect(element: Element, world: HTMLElement, scale: number): Rect {
  const box = element.getBoundingClientRect();
  const origin = world.getBoundingClientRect();
  return {
    x: (box.left - origin.left) / scale,
    y: (box.top - origin.top) / scale,
    width: box.width / scale,
    height: box.height / scale,
  };
}

function rootElements(world: HTMLElement): Element[] {
  return [...world.querySelectorAll(":scope > [data-pen-root]")].flatMap(
    (wrapper) => wrapper.firstElementChild ?? [],
  );
}

function targetElement(world: HTMLElement, target: PenFrameTarget): Element | null {
  const root = world.querySelector(
    `:scope > [data-pen-root="${target.rootIndex}"]`,
  )?.firstElementChild;
  if (!root || target.childId === null) return root ?? null;
  return root.querySelector(`:scope > [data-pen-id="${CSS.escape(target.childId)}"]`);
}

function ThemeAxisSelect(props: {
  readonly axis: string;
  readonly values: ReadonlyArray<string>;
  readonly forced: string | undefined;
  readonly onChange: (value: string | undefined) => void;
}) {
  return (
    <Select
      value={props.forced ?? AS_DESIGNED}
      onValueChange={(value) => {
        if (value !== null) props.onChange(value === AS_DESIGNED ? undefined : value);
      }}
    >
      <SelectTrigger size="xs" className="w-auto min-w-0" aria-label={`${props.axis} theme`}>
        <span className="truncate">
          {props.axis}: {props.forced ?? "As designed"}
        </span>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        <SelectItem value={AS_DESIGNED}>As designed</SelectItem>
        {props.values.map((value) => (
          <SelectItem key={value} value={value}>
            {value}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function PenCanvas(props: { readonly document: PenDocument }) {
  const { document } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef(false);
  // Until the reader pans or zooms, the design stays fitted as the panel resizes.
  const movedRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const [forced, setForced] = useState<PenTheme>({});
  const [labels, setLabels] = useState<ReadonlyArray<RootLabel>>([]);
  const theme = { ...defaultTheme(document), ...forced };
  const frames = navigableFrames(document);
  const themeAxes = Object.entries(document.themes).filter(([, values]) => values.length > 1);
  // The compiler memoizes this element, so panning and zooming only move the world.
  const content = <PenCanvasContent document={document} theme={theme} forced={forced} />;

  const fitTo = (target: Rect | null) => {
    const viewport = viewportRef.current;
    if (!target || !viewport || viewport.clientWidth === 0) return false;
    setView(fitView(target, { width: viewport.clientWidth, height: viewport.clientHeight }));
    return true;
  };

  const measureRoots = () => {
    const world = worldRef.current;
    if (!world) return [];
    return rootElements(world).map((element) => worldRect(element, world, view.scale));
  };

  const fitAll = () => fitTo(unionRect(measureRoots()));

  const syncLayout = useEffectEvent(() => {
    const rects = measureRoots();
    setLabels(
      rects.map((rect, index) => {
        const node = document.children[index];
        return { ...rect, label: typeof node?.name === "string" ? node.name : "" };
      }),
    );
    // Only the first layout fits; live edits from an agent keep the reader's view.
    if (!fittedRef.current) fittedRef.current = fitTo(unionRect(rects));
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Frame labels and the first fit need the browser's layout of the rendered design.
  useLayoutEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Labels sit outside the scaled world and need measured frame bounds.
    syncLayout();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Geometry comes from the DOM, so re-measure whenever the rendered design changes.
  }, [content]);

  const fitIfPending = useEffectEvent(() => {
    if (!fittedRef.current || !movedRef.current) fittedRef.current = fitAll();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Panels can mount hidden at zero size; fit once the viewport gets real dimensions.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    return observeResize(viewport, () => fitIfPending());
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Wheel zoom must cancel page scroll, which React's passive wheel listener cannot do.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      movedRef.current = true;
      const bounds = viewport.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        const pointX = event.clientX - bounds.left;
        const pointY = event.clientY - bounds.top;
        setView((current) => {
          const scale = clampZoom(current.scale * Math.exp(-event.deltaY * 0.01));
          const ratio = scale / current.scale;
          return {
            scale,
            x: pointX - (pointX - current.x) * ratio,
            y: pointY - (pointY - current.y) * ratio,
          };
        });
      } else {
        setView((current) => ({
          ...current,
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        }));
      }
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    movedRef.current = true;
    const centerX = viewport.clientWidth / 2;
    const centerY = viewport.clientHeight / 2;
    setView((current) => {
      const scale = clampZoom(current.scale * factor);
      const ratio = scale / current.scale;
      return {
        scale,
        x: centerX - (centerX - current.x) * ratio,
        y: centerY - (centerY - current.y) * ratio,
      };
    });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    movedRef.current = true;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    dragRef.current = { ...drag, x: event.clientX, y: event.clientY };
    setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const { stats } = document;
  const inert = stats.images + stats.scripts + stats.browsers + stats.shaders;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1 text-xs">
        {frames.length > 1 ? (
          <Select
            value={null}
            onValueChange={(key) => {
              const target = frames.find((frame) => frame.key === key);
              const world = worldRef.current;
              const element = target && world ? targetElement(world, target) : null;
              if (!element || !world) return;
              movedRef.current = true;
              fitTo(worldRect(element, world, view.scale));
            }}
          >
            <SelectTrigger size="xs" className="w-auto min-w-0 max-w-48" aria-label="Jump to frame">
              <span className="truncate">Frames ({frames.length})</span>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false} className="max-h-80">
              {frames.map((frame) => (
                <SelectItem key={frame.key} value={frame.key}>
                  <span className={frame.childId === null ? "font-medium" : "ps-3"}>
                    {frame.label}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        {themeAxes.map(([axis, values]) => (
          <ThemeAxisSelect
            key={axis}
            axis={axis}
            values={values}
            forced={forced[axis]}
            onChange={(value) =>
              setForced((current) => {
                const next = { ...current };
                if (value === undefined) delete next[axis];
                else next[axis] = value;
                return next;
              })
            }
          />
        ))}
        <span className="mr-auto px-1 text-muted-foreground tabular-nums">
          {stats.nodes.toLocaleString()} layers
        </span>
        <FileSurfaceAction
          label="Zoom out"
          disabled={view.scale <= MIN_ZOOM}
          onPress={() => zoomBy(1 / 1.25)}
        >
          <MinusIcon className="size-3.5" />
        </FileSurfaceAction>
        <span className="min-w-11 text-center tabular-nums">{Math.round(view.scale * 100)}%</span>
        <FileSurfaceAction
          label="Zoom in"
          disabled={view.scale >= MAX_ZOOM}
          onPress={() => zoomBy(1.25)}
        >
          <PlusIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label="Fit design"
          onPress={() => {
            movedRef.current = false;
            fitAll();
          }}
        >
          <ScanIcon className="size-3.5" />
        </FileSurfaceAction>
      </div>
      {inert > 0 || stats.missingRefs > 0 ? (
        <FileSurfaceNotice>
          {[
            inert > 0 ? "Images, shaders, scripts, and live pages are shown as placeholders" : null,
            stats.missingRefs > 0
              ? `${stats.missingRefs} component${stats.missingRefs === 1 ? "" : "s"} could not be resolved`
              : null,
          ]
            .filter(Boolean)
            .join(". ")}
          .
        </FileSurfaceNotice>
      ) : null}
      <div
        ref={viewportRef}
        role="img"
        aria-label="Rendered .pen design"
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden bg-muted/40 select-none active:cursor-grabbing"
        style={{
          backgroundImage:
            "radial-gradient(circle, color-mix(in srgb, var(--muted-foreground) 22%, transparent) 1px, transparent 1px)",
          backgroundSize: `${Math.max(8, 20 * view.scale)}px ${Math.max(8, 20 * view.scale)}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          ref={worldRef}
          className="absolute top-0 left-0"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transformOrigin: "0 0",
          }}
        >
          {content}
        </div>
        {labels.map((label, index) =>
          label.label ? (
            <div
              // oxlint-disable-next-line react/no-array-index-key -- Labels mirror top-level order.
              key={index}
              className="pointer-events-none absolute max-w-80 truncate text-2xs font-medium text-muted-foreground"
              style={{
                left: view.x + label.x * view.scale,
                top: view.y + label.y * view.scale - 18,
                maxWidth: Math.max(48, label.width * view.scale),
              }}
            >
              {label.label}
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}

export default function PenViewer(props: { readonly text: string }) {
  const parsed = parsePenDocument(props.text);
  if (!parsed.ok) {
    return (
      <FileSurfaceFailure
        message={`This .pen file could not be read (${parsed.error}). Show the source to inspect it.`}
      />
    );
  }
  return <PenCanvas document={parsed.document} />;
}
