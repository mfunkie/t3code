import {
  createElement,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { CircleDashedIcon, GlobeIcon, ImageIcon, PuzzleIcon, ScrollTextIcon } from "lucide-react";

import { lucideIconByName } from "~/lib/lucideIconByName";

import {
  backgroundImage,
  createResolver,
  cssColor,
  cssFontFamily,
  nestedTheme,
  parseCornerRadius,
  parseEffects,
  parsePadding,
  parseSize,
  parseStroke,
  primaryColor,
  resolveEnabled,
  resolveNumber,
  resolveString,
  type PenDocument,
  type PenNode,
  type PenSize,
  type PenStroke,
  type PenTheme,
  type Resolver,
} from "./penDocument";

type ParentLayout = "none" | "horizontal" | "vertical";

interface RenderContext {
  readonly document: PenDocument;
  readonly theme: PenTheme;
  readonly forced: PenTheme;
  readonly resolve: Resolver;
  readonly parentLayout: ParentLayout;
}

const JUSTIFY: Record<string, CSSProperties["justifyContent"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  space_between: "space-between",
  space_around: "space-around",
};

const ALIGN: Record<string, CSSProperties["alignItems"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
};

const px = (value: number) => `${value}px`;

function sizeStyle(
  axis: "width" | "height",
  size: PenSize | undefined,
  parentLayout: ParentLayout,
  absolute: boolean,
  empty: boolean,
): CSSProperties {
  const inFlex = parentLayout !== "none" && !absolute;
  const mainAxis = parentLayout === "horizontal" ? "width" : "height";
  if (size === undefined || size.kind === "fit") {
    // fit_content falls back when there is nothing to fit, e.g. an empty slot.
    if (size?.fallback !== undefined && empty) return { [axis]: px(size.fallback) };
    return {};
  }
  if (size.kind === "fixed") return { [axis]: px(size.px) };
  if (!inFlex) return { [axis]: size.fallback === undefined ? "100%" : px(size.fallback) };
  if (axis === mainAxis) {
    return {
      flexGrow: 1,
      flexBasis: 0,
      ...(axis === "width" ? { minWidth: 0 } : { minHeight: 0 }),
    };
  }
  return { alignSelf: "stretch" };
}

function boxStyle(node: PenNode, context: RenderContext): CSSProperties {
  const { resolve, parentLayout } = context;
  const absolute = parentLayout === "none" || node.layoutPosition === "absolute";
  const empty = !(node.children ?? []).some((child) => resolveEnabled(resolve, child.enabled));
  const style: CSSProperties = {
    boxSizing: "border-box",
    flexShrink: 0,
    position: absolute ? "absolute" : "relative",
    ...(absolute
      ? {
          left: px(resolveNumber(resolve, node.x) ?? 0),
          top: px(resolveNumber(resolve, node.y) ?? 0),
        }
      : {}),
    ...sizeStyle("width", parseSize(resolve, node.width), parentLayout, absolute, empty),
    ...sizeStyle("height", parseSize(resolve, node.height), parentLayout, absolute, empty),
  };
  const opacity = resolveNumber(resolve, node.opacity);
  if (opacity !== undefined && opacity < 1) style.opacity = Math.max(0, opacity);
  const rotation = resolveNumber(resolve, node.rotation) ?? 0;
  const flipX = resolve(node.flipX) === true;
  const flipY = resolve(node.flipY) === true;
  if (rotation !== 0 || flipX || flipY) {
    style.transformOrigin = flipX || flipY ? "center" : "0 0";
    style.transform = [
      rotation !== 0 ? `rotate(${-rotation}deg)` : "",
      flipX || flipY ? `scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})` : "",
    ].join(" ");
  }
  return style;
}

function graphicsStyle(node: PenNode, resolve: Resolver): CSSProperties {
  const style: CSSProperties = {};
  const background = backgroundImage(resolve, node.fill);
  if (background !== undefined) style.backgroundImage = background;
  const radius = parseCornerRadius(resolve, node.cornerRadius);
  if (radius !== null) style.borderRadius = radius.map(px).join(" ");
  const effects = parseEffects(resolve, node.effect ?? node.effects);
  if (effects.boxShadow) style.boxShadow = effects.boxShadow;
  if (effects.filter) style.filter = effects.filter;
  if (effects.backdropFilter) style.backdropFilter = effects.backdropFilter;
  return style;
}

/** Strokes paint on an overlay so they never change layout, like pen.dev's default. */
function StrokeOverlay(props: {
  readonly stroke: PenStroke;
  readonly radius: readonly [number, number, number, number] | null;
}) {
  const { stroke, radius } = props;
  const factor = stroke.align === "inner" ? 0 : stroke.align === "center" ? 0.5 : 1;
  const { top, right, bottom, left } = stroke.widths;
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        pointerEvents: "none",
        boxSizing: "border-box",
        inset: `${-top * factor}px ${-right * factor}px ${-bottom * factor}px ${-left * factor}px`,
        borderStyle: stroke.dashed ? "dashed" : "solid",
        borderColor: stroke.color,
        borderWidth: `${top}px ${right}px ${bottom}px ${left}px`,
        ...(radius
          ? {
              borderRadius: radius
                .map((corner) => px(corner + Math.max(top, left) * factor))
                .join(" "),
            }
          : {}),
      }}
    />
  );
}

function renderChildren(node: PenNode, context: RenderContext, layout: ParentLayout) {
  return (node.children ?? []).map((child, index) => (
    <PenNodeView
      // oxlint-disable-next-line react/no-array-index-key -- Instances repeat component ids, so position is the stable identity.
      key={`${index}:${child.id}`}
      node={child}
      context={{ ...context, parentLayout: layout }}
    />
  ));
}

function FrameView(props: { readonly node: PenNode; readonly context: RenderContext }) {
  const { node, context } = props;
  const { resolve } = context;
  const layoutValue = resolveString(resolve, node.layout);
  // Frames default to a horizontal flex row; groups only position their children.
  const layout: ParentLayout =
    node.type === "group"
      ? "none"
      : layoutValue === "none" || layoutValue === "vertical"
        ? layoutValue
        : "horizontal";
  const style: CSSProperties = { ...boxStyle(node, context), ...graphicsStyle(node, resolve) };
  if (layout !== "none") {
    const padding = parsePadding(resolve, node.padding);
    Object.assign(style, {
      display: "flex",
      flexDirection: layout === "vertical" ? "column" : "row",
      gap: px(resolveNumber(resolve, node.gap) ?? 0),
      padding: `${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px`,
      justifyContent: JUSTIFY[resolveString(resolve, node.justifyContent) ?? "start"],
      alignItems: ALIGN[resolveString(resolve, node.alignItems) ?? "start"],
    });
  }
  if (node.type === "group" && style.width === undefined && style.height === undefined) {
    // Groups take the bounds of their children; measure what the file states numerically.
    let width = 0;
    let height = 0;
    for (const child of node.children ?? []) {
      width = Math.max(
        width,
        (resolveNumber(resolve, child.x) ?? 0) + (resolveNumber(resolve, child.width) ?? 0),
      );
      height = Math.max(
        height,
        (resolveNumber(resolve, child.y) ?? 0) + (resolveNumber(resolve, child.height) ?? 0),
      );
    }
    style.width = px(width);
    style.height = px(height);
  }
  if (resolve(node.clip) === true) style.overflow = "hidden";
  const stroke = parseStroke(resolve, node);
  return (
    <div style={style} data-pen-id={node.id}>
      {renderChildren(node, context, layout)}
      {stroke ? (
        <StrokeOverlay stroke={stroke} radius={parseCornerRadius(resolve, node.cornerRadius)} />
      ) : null}
    </div>
  );
}

function TextView(props: { readonly node: PenNode; readonly context: RenderContext }) {
  const { node, context } = props;
  const { resolve } = context;
  const growth = resolveString(resolve, node.textGrowth) ?? "auto";
  const base = boxStyle(node, context);
  // Width and height only take effect once textGrowth opts in.
  if (growth === "auto") {
    delete base.width;
    delete base.height;
    delete base.flexGrow;
    delete base.flexBasis;
    delete base.alignSelf;
  } else if (growth === "fixed-width") {
    delete base.height;
  }
  const fontSize = resolveNumber(resolve, node.fontSize) ?? 14;
  const lineHeight = resolveNumber(resolve, node.lineHeight);
  const decoration = [
    resolve(node.underline) === true ? "underline" : "",
    resolve(node.strikethrough) === true ? "line-through" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const vertical = resolveString(resolve, node.textAlignVertical);
  const style: CSSProperties = {
    ...base,
    ...graphicsStyle({ ...node, fill: undefined }, resolve),
    color: primaryColor(resolve, node.fill) ?? "#000000",
    fontFamily: cssFontFamily(resolve, node.fontFamily),
    fontSize: px(fontSize),
    fontWeight:
      resolveString(resolve, node.fontWeight) ?? resolveNumber(resolve, node.fontWeight) ?? 400,
    fontStyle: resolveString(resolve, node.fontStyle) === "italic" ? "italic" : "normal",
    letterSpacing: px(resolveNumber(resolve, node.letterSpacing) ?? 0),
    lineHeight: lineHeight ?? "normal",
    textAlign: (resolveString(resolve, node.textAlign) as CSSProperties["textAlign"]) ?? "left",
    textDecoration: decoration || undefined,
    whiteSpace: growth === "auto" ? "pre" : "pre-wrap",
    overflowWrap: growth === "auto" ? "normal" : "break-word",
    ...(growth === "fixed-width-height"
      ? {
          display: "flex",
          flexDirection: "column",
          justifyContent:
            vertical === "middle" ? "center" : vertical === "bottom" ? "flex-end" : "flex-start",
        }
      : {}),
  };
  const content = resolve(node.content);
  return (
    <div style={style} data-pen-id={node.id}>
      {growth === "fixed-width-height" ? (
        <span>{String(content ?? "")}</span>
      ) : (
        String(content ?? "")
      )}
    </div>
  );
}

function IconView(props: { readonly node: PenNode; readonly context: RenderContext }) {
  const { node, context } = props;
  const { resolve } = context;
  const library = resolveString(resolve, node.library ?? node.iconFontFamily) ?? "lucide";
  const name = resolveString(resolve, node.icon ?? node.iconFontName) ?? "";
  const width = resolveNumber(resolve, node.width) ?? 24;
  const height = resolveNumber(resolve, node.height) ?? 24;
  // Feather's set is a subset of Lucide's; other libraries fall back to a same-named Lucide glyph.
  const icon = lucideIconByName(name.replace(/_/g, "-"));
  const color = primaryColor(resolve, node.fill) ?? "currentColor";
  const weight = resolveNumber(resolve, node.weight);
  return (
    <div
      data-pen-id={node.id}
      aria-label={`${library} icon ${name}`}
      style={{
        ...boxStyle({ ...node, width: node.width ?? 24, height: node.height ?? 24 }, context),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color,
        ...graphicsStyle({ ...node, fill: undefined }, resolve),
      }}
    >
      {createElement(icon ?? CircleDashedIcon, {
        size: Math.min(width, height),
        strokeWidth: weight === undefined ? 2 : Math.max(0.5, Math.min(3, weight / 200)),
        opacity: icon ? 1 : 0.5,
      })}
    </div>
  );
}

function svgPaint(node: PenNode, resolve: Resolver) {
  const stroke = parseStroke(resolve, node);
  return {
    fill: primaryColor(resolve, node.fill) ?? "none",
    stroke: stroke?.color ?? "none",
    strokeWidth: stroke ? Math.max(stroke.widths.top, stroke.widths.left) : 0,
    strokeLinecap: stroke?.cap,
    strokeLinejoin: stroke?.join,
    vectorEffect: "non-scaling-stroke" as const,
  };
}

function PathView(props: { readonly node: PenNode; readonly context: RenderContext }) {
  const { node, context } = props;
  const { resolve } = context;
  const explicit = Array.isArray(node.viewBox) && node.viewBox.length === 4 ? node.viewBox : null;
  const pathRef = useRef<SVGPathElement>(null);
  const [measured, setMeasured] = useState<string | null>(null);
  const geometry = typeof node.geometry === "string" ? node.geometry : "";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The default viewBox is the geometry's tight bounds, which only the SVG DOM can measure.
  useLayoutEffect(() => {
    if (explicit || !pathRef.current || geometry === "") return;
    const box = pathRef.current.getBBox();
    setMeasured(`${box.x} ${box.y} ${Math.max(box.width, 0.001)} ${Math.max(box.height, 0.001)}`);
  }, [explicit, geometry]);
  const viewBox = explicit ? explicit.join(" ") : (measured ?? undefined);
  return (
    <svg
      data-pen-id={node.id}
      viewBox={viewBox}
      preserveAspectRatio="none"
      overflow="visible"
      style={{
        ...boxStyle(node, context),
        ...graphicsStyle({ ...node, fill: undefined }, resolve),
      }}
    >
      <path
        ref={pathRef}
        d={geometry}
        fillRule={resolve(node.fillRule) === "evenodd" ? "evenodd" : "nonzero"}
        {...svgPaint(node, resolve)}
      />
    </svg>
  );
}

function ellipsePath(inner: number, start: number, sweep: number): string {
  // Unit box [0,100]; angles are counter-clockwise from the right, so SVG's downward y flips them.
  const point = (radius: number, degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    return `${50 + radius * Math.cos(radians)} ${50 - radius * Math.sin(radians)}`;
  };
  const outer = 50;
  const innerRadius = outer * inner;
  if (Math.abs(sweep) >= 360) {
    const ring = (r: number) =>
      `M ${50 - r} 50 A ${r} ${r} 0 1 0 ${50 + r} 50 A ${r} ${r} 0 1 0 ${50 - r} 50 Z`;
    return innerRadius > 0 ? `${ring(outer)} ${ring(innerRadius)}` : ring(outer);
  }
  const end = start + sweep;
  const large = Math.abs(sweep) > 180 ? 1 : 0;
  const outerSweep = sweep > 0 ? 0 : 1;
  const innerSweep = sweep > 0 ? 1 : 0;
  const outerArc = `M ${point(outer, start)} A ${outer} ${outer} 0 ${large} ${outerSweep} ${point(outer, end)}`;
  if (innerRadius <= 0) return `${outerArc} L 50 50 Z`;
  return `${outerArc} L ${point(innerRadius, end)} A ${innerRadius} ${innerRadius} 0 ${large} ${innerSweep} ${point(innerRadius, start)} Z`;
}

function EllipseView(props: { readonly node: PenNode; readonly context: RenderContext }) {
  const { node, context } = props;
  const { resolve } = context;
  const inner = resolveNumber(resolve, node.innerRadius) ?? 0;
  const start = resolveNumber(resolve, node.startAngle) ?? 0;
  const sweep = resolveNumber(resolve, node.sweepAngle) ?? 360;
  if (inner === 0 && Math.abs(sweep) >= 360) {
    const stroke = parseStroke(resolve, node);
    return (
      <div
        data-pen-id={node.id}
        style={{ ...boxStyle(node, context), ...graphicsStyle(node, resolve), borderRadius: "50%" }}
      >
        {stroke ? <StrokeOverlay stroke={stroke} radius={[9999, 9999, 9999, 9999]} /> : null}
      </div>
    );
  }
  return (
    <svg
      data-pen-id={node.id}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      overflow="visible"
      style={boxStyle(node, context)}
    >
      <path d={ellipsePath(inner, start, sweep)} fillRule="evenodd" {...svgPaint(node, resolve)} />
    </svg>
  );
}

function PolygonView(props: { readonly node: PenNode; readonly context: RenderContext }) {
  const { node, context } = props;
  const { resolve } = context;
  const count = Math.max(3, Math.round(resolveNumber(resolve, node.polygonCount) ?? 3));
  const points = Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
    return `${50 + 50 * Math.cos(angle)},${50 + 50 * Math.sin(angle)}`;
  }).join(" ");
  return (
    <svg
      data-pen-id={node.id}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      overflow="visible"
      style={boxStyle(node, context)}
    >
      <polygon points={points} {...svgPaint(node, resolve)} />
    </svg>
  );
}

function LineView(props: { readonly node: PenNode; readonly context: RenderContext }) {
  const { node, context } = props;
  return (
    <svg data-pen-id={node.id} overflow="visible" style={boxStyle(node, context)}>
      <line
        x1="0"
        y1="0"
        x2="100%"
        y2="100%"
        {...svgPaint({ ...node, fill: undefined }, context.resolve)}
      />
    </svg>
  );
}

/** Content pen.dev renders live (pages, scripts, images, missing components) stays inert here. */
function PlaceholderView(props: {
  readonly node: PenNode;
  readonly context: RenderContext;
  readonly icon: ReactNode;
  readonly label: string;
}) {
  const { node, context } = props;
  return (
    <div
      data-pen-id={node.id}
      style={{
        ...boxStyle({ ...node, width: node.width ?? 160, height: node.height ?? 48 }, context),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        padding: 8,
        overflow: "hidden",
        border: "1px dashed rgba(127,127,127,.6)",
        borderRadius: 6,
        background:
          "repeating-linear-gradient(45deg, rgba(127,127,127,.12) 0 6px, rgba(127,127,127,.04) 6px 12px)",
        color: "rgba(110,110,110,1)",
        font: "500 11px/1.3 ui-sans-serif, system-ui, sans-serif",
        textAlign: "center",
      }}
    >
      {props.icon}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{props.label}</span>
    </div>
  );
}

function NoteView(props: { readonly node: PenNode; readonly context: RenderContext }) {
  const { node, context } = props;
  const { resolve } = context;
  return (
    <div
      data-pen-id={node.id}
      style={{
        ...boxStyle({ ...node, width: node.width ?? 200 }, context),
        background: cssColor(resolve, node.color) ?? "#FEE484",
        color: "#3b3415",
        padding: 12,
        borderRadius: 4,
        boxShadow: "0 1px 3px rgba(0,0,0,.18)",
        font: "13px/1.45 ui-sans-serif, system-ui, sans-serif",
        whiteSpace: "pre-wrap",
      }}
    >
      {String(resolve(node.content) ?? "")}
    </div>
  );
}

function PenNodeView(props: { readonly node: PenNode; readonly context: RenderContext }) {
  const { node } = props;
  const parent = props.context;
  if (!resolveEnabled(parent.resolve, node.enabled)) return null;
  const theme = nestedTheme(parent.theme, node.theme, parent.forced);
  const context =
    theme === parent.theme
      ? parent
      : { ...parent, theme, resolve: createResolver(parent.document, theme) };
  switch (node.type) {
    case "frame":
    case "group":
      return <FrameView node={node} context={context} />;
    case "rectangle": {
      const stroke = parseStroke(context.resolve, node);
      return (
        <div
          data-pen-id={node.id}
          style={{ ...boxStyle(node, context), ...graphicsStyle(node, context.resolve) }}
        >
          {stroke ? (
            <StrokeOverlay
              stroke={stroke}
              radius={parseCornerRadius(context.resolve, node.cornerRadius)}
            />
          ) : null}
        </div>
      );
    }
    case "text":
      return <TextView node={node} context={context} />;
    case "icon":
    case "icon_font":
      return <IconView node={node} context={context} />;
    case "path":
      return <PathView node={node} context={context} />;
    case "ellipse":
      return <EllipseView node={node} context={context} />;
    case "polygon":
      return <PolygonView node={node} context={context} />;
    case "line":
      return <LineView node={node} context={context} />;
    case "note":
      return <NoteView node={node} context={context} />;
    case "browser":
      return (
        <PlaceholderView
          node={node}
          context={context}
          icon={<GlobeIcon size={14} />}
          label={resolveString(context.resolve, node.url) || "Web page"}
        />
      );
    case "script":
      return (
        <PlaceholderView
          node={node}
          context={context}
          icon={<ScrollTextIcon size={14} />}
          label={`Script: ${resolveString(context.resolve, node.scriptUri) ?? "not run"}`}
        />
      );
    case "missing_ref":
      return (
        <PlaceholderView
          node={node}
          context={context}
          icon={<PuzzleIcon size={14} />}
          label={`Missing component ${typeof node.ref === "string" ? node.ref : ""}`}
        />
      );
    default:
      return (
        <PlaceholderView
          node={node}
          context={context}
          icon={<ImageIcon size={14} />}
          label={`Unsupported ${node.type}`}
        />
      );
  }
}

/** Renders every top-level node at its canvas position. `data-pen-root` marks navigation targets. */
export function PenCanvasContent(props: {
  readonly document: PenDocument;
  readonly theme: PenTheme;
  readonly forced: PenTheme;
}) {
  const { document, theme, forced } = props;
  const context: RenderContext = {
    document,
    theme,
    forced,
    resolve: createResolver(document, theme),
    parentLayout: "none",
  };
  return (
    <>
      {document.children.map((node, index) => (
        <div
          // oxlint-disable-next-line react/no-array-index-key -- Top-level ids can repeat in hand-written files; order is identity.
          key={`${index}:${node.id}`}
          data-pen-root={index}
          style={{ display: "contents" }}
        >
          <PenNodeView node={node} context={context} />
        </div>
      ))}
    </>
  );
}
