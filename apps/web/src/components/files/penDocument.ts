// Reader for pen.dev `.pen` design files: https://docs.pen.dev/for-developers/the-pen-format
// Accepts both the current schema (2.2x) and the 2.8-era shape (`icon_font`, `line`, object strokes).

export type PenTheme = Readonly<Record<string, string>>;

export interface PenNode {
  readonly id: string;
  readonly type: string;
  readonly children?: ReadonlyArray<PenNode>;
  readonly [key: string]: unknown;
}

interface PenVariableValue {
  readonly value: unknown;
  readonly theme?: PenTheme;
}

export interface PenDocument {
  readonly version: string | null;
  readonly themes: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly variables: Readonly<Record<string, ReadonlyArray<PenVariableValue>>>;
  readonly children: ReadonlyArray<PenNode>;
  readonly stats: PenStats;
}

export interface PenStats {
  readonly nodes: number;
  readonly missingRefs: number;
  readonly images: number;
  readonly scripts: number;
  readonly browsers: number;
  readonly shaders: number;
}

export type PenParseResult =
  | { readonly ok: true; readonly document: PenDocument }
  | { readonly ok: false; readonly error: string };

const MAX_REF_DEPTH = 32;
const MAX_NODES = 50_000;
const MAX_VARIABLE_DEPTH = 16;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableNode = Mutable<PenNode> & { children?: MutableNode[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNode = (value: unknown): value is PenNode =>
  isRecord(value) && typeof value.type === "string";

/** `.pen` is JSON that also allows `//` and block comments. */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i++;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += char;
  }
  return out;
}

function readVariables(raw: unknown): Record<string, ReadonlyArray<PenVariableValue>> {
  const variables: Record<string, ReadonlyArray<PenVariableValue>> = {};
  // 2.8 files store variables as a map; some early files used an array of { name, value }.
  const entries: Array<[string, unknown]> = Array.isArray(raw)
    ? raw.flatMap((entry) =>
        isRecord(entry) && typeof entry.name === "string" ? [[entry.name, entry]] : [],
      )
    : isRecord(raw)
      ? Object.entries(raw)
      : [];
  for (const [name, definition] of entries) {
    if (!isRecord(definition)) continue;
    const value = definition.value;
    variables[name] = Array.isArray(value)
      ? value.flatMap((entry) =>
          isRecord(entry)
            ? [
                isRecord(entry.theme)
                  ? { value: entry.value, theme: entry.theme as PenTheme }
                  : { value: entry.value },
              ]
            : [],
        )
      : [{ value }];
  }
  return variables;
}

function readThemes(raw: unknown): Record<string, ReadonlyArray<string>> {
  const themes: Record<string, ReadonlyArray<string>> = {};
  if (!isRecord(raw)) return themes;
  for (const [axis, values] of Object.entries(raw)) {
    if (Array.isArray(values)) {
      themes[axis] = values.filter((value): value is string => typeof value === "string");
    }
  }
  return themes;
}

function indexNodes(nodes: ReadonlyArray<unknown>, index: Map<string, PenNode>) {
  for (const node of nodes) {
    if (!isNode(node)) continue;
    if (typeof node.id === "string" && !index.has(node.id)) index.set(node.id, node);
    if (Array.isArray(node.children)) indexNodes(node.children, index);
  }
}

const cloneNode = (node: PenNode): MutableNode => structuredClone(node) as MutableNode;

function mergeOverride(existing: unknown, incoming: Record<string, unknown>) {
  if ("type" in incoming || !isRecord(existing) || "type" in existing) return incoming;
  return { ...existing, ...incoming };
}

/** Applies one `descendants` entry inside an instance; returns false when the path is not found. */
function applyDescendant(
  root: MutableNode,
  path: ReadonlyArray<string>,
  override: Record<string, unknown>,
): boolean {
  const [head, ...rest] = path;
  const visit = (parent: MutableNode): boolean => {
    const children = parent.children;
    if (!children) return false;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (child.id === head) {
        if (rest.length > 0) {
          // A deeper path targets an instance nested in this one; hand it down so the
          // nested ref applies it after expanding its own component.
          if (child.type !== "ref") return false;
          const key = rest.join("/");
          const descendants = isRecord(child.descendants) ? { ...child.descendants } : {};
          descendants[key] = mergeOverride(descendants[key], override);
          child.descendants = descendants;
        } else if ("type" in override) {
          children[i] = structuredClone(override) as MutableNode;
        } else {
          Object.assign(child, structuredClone(override));
        }
        return true;
      }
      if (child.type !== "ref" && visit(child)) return true;
    }
    return false;
  };
  return visit(root);
}

interface ExpandContext {
  readonly index: Map<string, PenNode>;
  readonly stats: Mutable<PenStats>;
}

function countFills(fills: unknown, stats: Mutable<PenStats>) {
  for (const fill of Array.isArray(fills) ? fills : [fills]) {
    if (!isRecord(fill) || fill.enabled === false) continue;
    if (fill.type === "image" && typeof fill.url === "string" && fill.url !== "") stats.images++;
    if (fill.type === "shader") stats.shaders++;
  }
}

function expandNode(node: PenNode, context: ExpandContext, chain: ReadonlyArray<string>): PenNode {
  if (node.type === "ref") {
    const refId = typeof node.ref === "string" ? node.ref : undefined;
    const target = refId === undefined ? undefined : context.index.get(refId);
    // A component that contains an instance of itself would expand forever.
    if (
      !target ||
      refId === undefined ||
      chain.includes(refId) ||
      chain.length >= MAX_REF_DEPTH ||
      context.stats.nodes >= MAX_NODES
    ) {
      context.stats.missingRefs++;
      return { ...node, type: "missing_ref" };
    }
    const { type: _type, ref: _ref, descendants, ...rootOverrides } = node;
    const instance: MutableNode = Object.assign(cloneNode(target), structuredClone(rootOverrides));
    delete instance.reusable;
    if (isRecord(descendants)) {
      for (const [path, override] of Object.entries(descendants)) {
        if (isRecord(override)) applyDescendant(instance, path.split("/"), override);
      }
    }
    return expandNode(instance, context, [...chain, refId]);
  }
  context.stats.nodes++;
  if (node.type === "script") context.stats.scripts++;
  if (node.type === "browser") context.stats.browsers++;
  countFills(node.fill, context.stats);
  if (!Array.isArray(node.children)) return node;
  const children = node.children.filter(isNode).map((child) => expandNode(child, context, chain));
  return { ...node, children };
}

export function parsePenDocument(text: string): PenParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(text));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid JSON" };
  }
  if (!isRecord(raw) || !Array.isArray(raw.children)) {
    return { ok: false, error: "Missing the top-level `children` array." };
  }
  const index = new Map<string, PenNode>();
  indexNodes(raw.children, index);
  const stats: Mutable<PenStats> = {
    nodes: 0,
    missingRefs: 0,
    images: 0,
    scripts: 0,
    browsers: 0,
    shaders: 0,
  };
  const context = { index, stats };
  // Components stay on the canvas like any other node, matching pen.dev.
  const children = raw.children.filter(isNode).map((node) => expandNode(node, context, []));
  return {
    ok: true,
    document: {
      version: typeof raw.version === "string" ? raw.version : null,
      themes: readThemes(raw.themes),
      variables: readVariables(raw.variables),
      children,
      stats,
    },
  };
}

export function defaultTheme(document: PenDocument): PenTheme {
  const theme: Record<string, string> = {};
  for (const [axis, values] of Object.entries(document.themes)) {
    const first = values[0];
    if (first !== undefined) theme[axis] = first;
  }
  return theme;
}

/** A node's own `theme` narrows its subtree, but the viewer's forced axes always win. */
export function nestedTheme(inherited: PenTheme, own: unknown, forced: PenTheme): PenTheme {
  if (!isRecord(own)) return inherited;
  const next: Record<string, string> = { ...inherited };
  for (const [axis, value] of Object.entries(own)) {
    if (typeof value === "string" && !(axis in forced)) next[axis] = value;
  }
  return next;
}

const themeMatches = (condition: PenTheme | undefined, active: PenTheme) =>
  condition === undefined ||
  Object.entries(condition).every(([axis, value]) => active[axis] === value);

/** Resolves `$name` references against the active theme; other values pass through. */
function resolveValue(document: PenDocument, theme: PenTheme, value: unknown, depth = 0): unknown {
  if (typeof value !== "string" || !value.startsWith("$") || depth > MAX_VARIABLE_DEPTH) {
    return value;
  }
  const values = document.variables[value.slice(1)];
  if (!values) return undefined;
  let resolved: unknown;
  for (const entry of values) {
    if (themeMatches(entry.theme, theme)) resolved = entry.value;
  }
  return resolveValue(document, theme, resolved, depth + 1);
}

export type Resolver = (value: unknown) => unknown;

export function createResolver(document: PenDocument, theme: PenTheme): Resolver {
  return (value) => resolveValue(document, theme, value);
}

export const resolveNumber = (resolve: Resolver, value: unknown): number | undefined => {
  const resolved = resolve(value);
  return typeof resolved === "number" && Number.isFinite(resolved) ? resolved : undefined;
};

export const resolveString = (resolve: Resolver, value: unknown): string | undefined => {
  const resolved = resolve(value);
  return typeof resolved === "string" ? resolved : undefined;
};

export const resolveEnabled = (resolve: Resolver, value: unknown): boolean =>
  resolve(value) !== false;

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Only hex colors reach CSS, so a crafted file cannot smuggle `url()` or other declarations. */
export function cssColor(resolve: Resolver, value: unknown, opacity = 1): string | null {
  const resolved = resolve(value);
  if (typeof resolved !== "string" || !HEX_COLOR.test(resolved)) return null;
  if (opacity >= 1) return resolved;
  let hex = resolved.slice(1);
  if (hex.length <= 4) hex = [...hex].map((digit) => digit + digit).join("");
  const channel = (offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16);
  const alpha = (hex.length === 8 ? channel(6) / 255 : 1) * Math.max(0, opacity);
  return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${Number(alpha.toFixed(3))})`;
}

export type PenSize =
  | { readonly kind: "fixed"; readonly px: number }
  | { readonly kind: "fill"; readonly fallback: number | undefined }
  | { readonly kind: "fit"; readonly fallback: number | undefined };

export function parseSize(resolve: Resolver, value: unknown): PenSize | undefined {
  const resolved = resolve(value);
  if (typeof resolved === "number" && Number.isFinite(resolved)) {
    return { kind: "fixed", px: Math.max(0, resolved) };
  }
  if (typeof resolved !== "string") return undefined;
  const match = /^(fill_container|fit_content)(?:\(\s*(-?[\d.]+)\s*\))?$/.exec(resolved.trim());
  if (!match) return undefined;
  const fallback = match[2] === undefined ? undefined : Number(match[2]);
  return {
    kind: match[1] === "fill_container" ? "fill" : "fit",
    fallback: fallback !== undefined && Number.isFinite(fallback) ? fallback : undefined,
  };
}

export interface Sides {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export function parsePadding(resolve: Resolver, value: unknown): Sides {
  const n = (entry: unknown) => resolveNumber(resolve, entry) ?? 0;
  if (Array.isArray(value)) {
    if (value.length === 2) {
      return { top: n(value[0]), right: n(value[1]), bottom: n(value[0]), left: n(value[1]) };
    }
    if (value.length === 4) {
      return { top: n(value[0]), right: n(value[1]), bottom: n(value[2]), left: n(value[3]) };
    }
  }
  if (isRecord(value)) {
    return {
      top: n(value.top),
      right: n(value.right),
      bottom: n(value.bottom),
      left: n(value.left),
    };
  }
  const all = n(value);
  return { top: all, right: all, bottom: all, left: all };
}

/** [topLeft, topRight, bottomRight, bottomLeft] */
export function parseCornerRadius(
  resolve: Resolver,
  value: unknown,
): readonly [number, number, number, number] | null {
  const n = (entry: unknown) => resolveNumber(resolve, entry) ?? 0;
  if (Array.isArray(value) && value.length === 4) {
    return [n(value[0]), n(value[1]), n(value[2]), n(value[3])];
  }
  const all = resolveNumber(resolve, value);
  return all === undefined || all === 0 ? null : [all, all, all, all];
}

const fillList = (fills: unknown): ReadonlyArray<unknown> =>
  Array.isArray(fills) ? fills : fills === undefined || fills === null ? [] : [fills];

/** CSS stops for a gradient fill, with its opacity folded into each color. */
function gradientStops(resolve: Resolver, fill: Record<string, unknown>): string | null {
  const opacity = resolveNumber(resolve, fill.opacity) ?? 1;
  const stops = Array.isArray(fill.colors) ? fill.colors : [];
  const parts = stops.flatMap((stop) => {
    if (!isRecord(stop)) return [];
    const color = cssColor(resolve, stop.color, opacity);
    const position = resolveNumber(resolve, stop.position);
    if (color === null) return [];
    return [position === undefined ? color : `${color} ${Number((position * 100).toFixed(3))}%`];
  });
  if (parts.length === 0) return null;
  return parts.length === 1 ? `${parts[0]}, ${parts[0]}` : parts.join(", ");
}

/**
 * One CSS background layer for a fill, or null when it paints nothing here.
 * Images and shaders are never fetched or run; they show a neutral hatch instead.
 */
function fillLayer(resolve: Resolver, fill: unknown): string | null {
  if (typeof fill === "string") {
    const color = cssColor(resolve, fill);
    return color === null ? null : `linear-gradient(${color}, ${color})`;
  }
  if (!isRecord(fill) || !resolveEnabled(resolve, fill.enabled)) return null;
  switch (fill.type) {
    case "color":
    case "solid": {
      const color = cssColor(resolve, fill.color);
      return color === null ? null : `linear-gradient(${color}, ${color})`;
    }
    case "gradient":
    case "linear_gradient":
    case "radial_gradient":
    case "angular_gradient": {
      const stops = gradientStops(resolve, fill);
      if (stops === null) return null;
      const kind =
        fill.type === "gradient"
          ? (resolveString(resolve, fill.gradientType) ?? "linear")
          : String(fill.type).replace("_gradient", "");
      // pen.dev angles run counter-clockwise from "up"; CSS runs clockwise from "up".
      const rotation = resolveNumber(resolve, fill.rotation ?? fill.angle) ?? 0;
      const cssAngle = (((-rotation % 360) + 360) % 360).toFixed(2);
      const center = isRecord(fill.center) ? fill.center : {};
      const cx = (resolveNumber(resolve, center.x) ?? 0.5) * 100;
      const cy = (resolveNumber(resolve, center.y) ?? 0.5) * 100;
      if (kind === "radial") {
        const size = isRecord(fill.size) ? fill.size : {};
        const rx = (resolveNumber(resolve, size.width) ?? 1) * 50;
        const ry = (resolveNumber(resolve, size.height) ?? 1) * 50;
        return `radial-gradient(${rx}% ${ry}% at ${cx}% ${cy}%, ${stops})`;
      }
      if (kind === "angular")
        return `conic-gradient(from ${cssAngle}deg at ${cx}% ${cy}%, ${stops})`;
      return `linear-gradient(${cssAngle}deg, ${stops})`;
    }
    case "mesh_gradient": {
      const colors = Array.isArray(fill.colors) ? fill.colors : [];
      const opacity = resolveNumber(resolve, fill.opacity) ?? 1;
      const parsed = colors.flatMap((color) => cssColor(resolve, color, opacity) ?? []);
      if (parsed.length === 0) return null;
      // Approximate the bezier mesh by fading the corner colors across the box.
      return parsed.length === 1
        ? `linear-gradient(${parsed[0]}, ${parsed[0]})`
        : `linear-gradient(135deg, ${parsed.join(", ")})`;
    }
    case "image":
      return typeof fill.url === "string" && fill.url !== ""
        ? "repeating-linear-gradient(45deg, rgba(127,127,127,.18) 0 6px, rgba(127,127,127,.08) 6px 12px)"
        : null;
    case "shader":
      return "repeating-linear-gradient(-45deg, rgba(127,127,127,.18) 0 6px, rgba(127,127,127,.08) 6px 12px)";
    default:
      return null;
  }
}

/** CSS `background-image` for a fill stack. The last pen fill paints on top; CSS lists top first. */
export function backgroundImage(resolve: Resolver, fills: unknown): string | undefined {
  const layers = fillList(fills)
    .map((fill) => fillLayer(resolve, fill))
    .filter((layer): layer is string => layer !== null);
  return layers.length === 0 ? undefined : layers.toReversed().join(", ");
}

/** The single color used where CSS can only take one (text, icons, SVG paint). */
export function primaryColor(resolve: Resolver, fills: unknown): string | null {
  const list = fillList(fills);
  for (let i = list.length - 1; i >= 0; i--) {
    const fill = list[i];
    if (typeof fill === "string") {
      const color = cssColor(resolve, fill);
      if (color !== null) return color;
      continue;
    }
    if (!isRecord(fill) || !resolveEnabled(resolve, fill.enabled)) continue;
    if (fill.type === "color" || fill.type === "solid") {
      const color = cssColor(resolve, fill.color);
      if (color !== null) return color;
    } else if (Array.isArray(fill.colors)) {
      const first = fill.colors[0];
      const color = cssColor(resolve, isRecord(first) ? first.color : first);
      if (color !== null) return color;
    }
  }
  return null;
}

export interface PenStroke {
  readonly color: string;
  readonly widths: Sides;
  readonly align: "inner" | "center" | "outer";
  readonly cap: "butt" | "round" | "square" | undefined;
  readonly join: "miter" | "round" | "bevel" | undefined;
  readonly dashed: boolean;
}

const ALIGNMENTS = {
  inner: "inner",
  inside: "inner",
  center: "center",
  outer: "outer",
  outside: "outer",
} as const;

function pick<T extends string>(value: unknown, allowed: ReadonlyArray<T>): T | undefined {
  return allowed.find((entry) => entry === value);
}

export function parseStroke(resolve: Resolver, node: PenNode): PenStroke | null {
  const raw = node.stroke;
  // 2.8 files keep width, alignment, and paint together in one object.
  const legacy =
    isRecord(raw) && !("type" in raw) && ("thickness" in raw || "align" in raw || "fill" in raw);
  const paint = legacy ? raw.fill : raw;
  const color = primaryColor(resolve, paint);
  if (color === null) return null;
  const widthValue = legacy ? raw.thickness : node.strokeWidth;
  const widths = isRecord(widthValue)
    ? parsePadding(resolve, widthValue)
    : parsePadding(resolve, resolveNumber(resolve, widthValue) ?? 1);
  if (widths.top + widths.right + widths.bottom + widths.left <= 0) return null;
  const alignValue = resolve(legacy ? raw.align : node.strokeAlignment);
  const align =
    typeof alignValue === "string" && alignValue in ALIGNMENTS
      ? ALIGNMENTS[alignValue as keyof typeof ALIGNMENTS]
      : "inner";
  return {
    color,
    widths,
    align,
    cap: pick(resolve(legacy ? raw.cap : node.strokeLinecap), ["butt", "round", "square"]),
    join: pick(resolve(legacy ? raw.join : node.strokeLinejoin), ["miter", "round", "bevel"]),
    dashed: legacy && Array.isArray(raw.dash) && raw.dash.length > 0,
  };
}

export interface PenEffects {
  readonly boxShadow: string | undefined;
  readonly filter: string | undefined;
  readonly backdropFilter: string | undefined;
}

export function parseEffects(resolve: Resolver, value: unknown): PenEffects {
  const shadows: string[] = [];
  const filters: string[] = [];
  const backdrops: string[] = [];
  for (const effect of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
    if (!isRecord(effect) || !resolveEnabled(resolve, effect.enabled)) continue;
    const radius = resolveNumber(resolve, effect.radius) ?? 0;
    if (effect.type === "blur" && radius > 0) filters.push(`blur(${radius / 2}px)`);
    if (effect.type === "background_blur" && radius > 0) backdrops.push(`blur(${radius / 2}px)`);
    if (effect.type !== "shadow") continue;
    const color = cssColor(resolve, effect.color) ?? "#00000040";
    const offset = isRecord(effect.offset) ? effect.offset : effect;
    const x = resolveNumber(resolve, offset.x) ?? 0;
    const y = resolveNumber(resolve, offset.y) ?? 0;
    const blur = resolveNumber(resolve, effect.blur) ?? 0;
    const spread = resolveNumber(resolve, effect.spread) ?? 0;
    const inset = effect.shadowType === "inner" ? "inset " : "";
    shadows.push(`${inset}${x}px ${y}px ${blur}px ${spread}px ${color}`);
  }
  return {
    boxShadow: shadows.length > 0 ? shadows.join(", ") : undefined,
    filter: filters.length > 0 ? filters.join(" ") : undefined,
    backdropFilter: backdrops.length > 0 ? backdrops.join(" ") : undefined,
  };
}

const GENERIC_FONT_FALLBACK =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Fonts are matched against locally installed families only; nothing is downloaded. */
export function cssFontFamily(resolve: Resolver, value: unknown): string {
  const family = resolveString(resolve, value)
    ?.replace(/["'\\;{}()<>]/g, "")
    .trim();
  return family ? `"${family}", ${GENERIC_FONT_FALLBACK}` : GENERIC_FONT_FALLBACK;
}

export interface PenFrameTarget {
  readonly key: string;
  readonly label: string;
  readonly rootIndex: number;
  /** Set for a board inside the single root container; null for the root itself. */
  readonly childId: string | null;
}

/** Top-level nodes, plus the boards inside a single root container (common in libraries). */
export function navigableFrames(document: PenDocument): ReadonlyArray<PenFrameTarget> {
  const label = (node: PenNode, fallback: string) =>
    typeof node.name === "string" && node.name.trim() !== "" ? node.name : fallback;
  const targets: PenFrameTarget[] = document.children.map((node, index) => ({
    key: String(index),
    label: label(node, `${node.type} ${index + 1}`),
    rootIndex: index,
    childId: null,
  }));
  const only = document.children[0];
  if (document.children.length === 1 && only?.layout === "none" && only.children) {
    only.children.forEach((child, index) => {
      if (child.type !== "frame" && child.type !== "group") return;
      targets.push({
        key: `0.${index}`,
        label: label(child, child.id),
        rootIndex: 0,
        childId: child.id,
      });
    });
  }
  return targets;
}
