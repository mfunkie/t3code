import { describe, expect, it } from "vite-plus/test";

import {
  backgroundImage,
  createResolver,
  cssColor,
  defaultTheme,
  nestedTheme,
  parsePenDocument,
  parseSize,
  parseStroke,
  type PenDocument,
  type PenNode,
} from "./penDocument";

function parse(source: unknown): PenDocument {
  const result = parsePenDocument(typeof source === "string" ? source : JSON.stringify(source));
  if (!result.ok) throw new Error(result.error);
  return result.document;
}

const at = (node: PenNode | undefined, ...path: number[]): PenNode => {
  let current = node;
  for (const index of path) current = current?.children?.[index];
  if (!current) throw new Error(`No node at ${path.join(".")}`);
  return current;
};

describe("parsePenDocument", () => {
  it("accepts comments without touching comment-like text in strings", () => {
    const document = parse(`{
      // pen.dev allows comments
      "version": "2.22", /* block */
      "children": [{ "id": "a", "type": "text", "content": "http://x // not a comment" }]
    }`);
    expect(document.children[0]?.content).toBe("http://x // not a comment");
  });

  it("reports malformed files instead of throwing", () => {
    expect(parsePenDocument("{").ok).toBe(false);
    expect(parsePenDocument('{"version":"2.22"}')).toEqual({
      ok: false,
      error: "Missing the top-level `children` array.",
    });
  });

  it("expands instances with root, property, replacement, children, and nested-path overrides", () => {
    const button = {
      id: "button",
      type: "frame",
      reusable: true,
      fill: "#111111",
      children: [
        { id: "label", type: "text", content: "OK" },
        { id: "icon", type: "icon", icon: "check" },
      ],
    };
    const card = {
      id: "card",
      type: "frame",
      reusable: true,
      children: [
        { id: "title", type: "text", content: "Title" },
        { id: "body", type: "frame", children: [{ id: "old", type: "text" }] },
        { id: "cta", type: "ref", ref: "button" },
      ],
    };
    const document = parse({
      children: [
        button,
        card,
        {
          id: "instance",
          type: "ref",
          ref: "card",
          x: 40,
          descendants: {
            title: { content: "Hello" },
            body: { children: [{ id: "new", type: "rectangle" }] },
            "cta/label": { content: "Buy" },
            "cta/icon": { id: "dot", type: "ellipse" },
          },
        },
      ],
    });
    const instance = document.children[2];
    expect(instance).toMatchObject({ id: "instance", type: "frame", x: 40 });
    expect(instance && "reusable" in instance).toBe(false);
    expect(at(instance, 0).content).toBe("Hello");
    expect(at(instance, 1, 0)).toMatchObject({ id: "new", type: "rectangle" });
    expect(at(instance, 2)).toMatchObject({ type: "frame", fill: "#111111" });
    expect(at(instance, 2, 0).content).toBe("Buy");
    expect(at(instance, 2, 1)).toMatchObject({ id: "dot", type: "ellipse" });
    // The component itself stays untouched.
    expect(at(document.children[1], 0).content).toBe("Title");
  });

  it("stops self-referencing and unknown components", () => {
    const document = parse({
      children: [
        { id: "loop", type: "frame", children: [{ id: "inner", type: "ref", ref: "loop" }] },
        { id: "gone", type: "ref", ref: "nowhere" },
      ],
    });
    // The canvas copy shows one nested instance; the instance's own self-reference stops.
    expect(at(document.children[0], 0).type).toBe("frame");
    expect(at(document.children[0], 0, 0).type).toBe("missing_ref");
    expect(document.children[1]?.type).toBe("missing_ref");
    expect(document.stats.missingRefs).toBe(2);
  });
});

describe("theme variables", () => {
  const document = parse({
    themes: { Mode: ["Light", "Dark"], Accent: ["Blue", "Red"] },
    variables: {
      bg: {
        type: "color",
        value: [
          { value: "#ffffff" },
          { value: "#000000", theme: { Mode: "Dark" } },
          { value: "#110000", theme: { Mode: "Dark", Accent: "Red" } },
        ],
      },
      surface: { type: "color", value: "$bg" },
    },
    children: [],
  });

  it("uses the last matching value and follows variable chains", () => {
    const light = defaultTheme(document);
    expect(light).toEqual({ Mode: "Light", Accent: "Blue" });
    expect(createResolver(document, light)("$surface")).toBe("#ffffff");
    expect(createResolver(document, { Mode: "Dark", Accent: "Blue" })("$surface")).toBe("#000000");
    expect(createResolver(document, { Mode: "Dark", Accent: "Red" })("$surface")).toBe("#110000");
  });

  it("lets node themes narrow a subtree unless the viewer forces that axis", () => {
    const base = defaultTheme(document);
    expect(nestedTheme(base, { Mode: "Dark" }, {})).toEqual({ Mode: "Dark", Accent: "Blue" });
    expect(nestedTheme(base, { Mode: "Dark" }, { Mode: "Light" })).toEqual(base);
  });
});

describe("paint", () => {
  const resolve = createResolver(parse({ children: [] }), {});

  it("only emits hex colors to CSS", () => {
    expect(cssColor(resolve, "#3B82F680")).toBe("#3B82F680");
    expect(cssColor(resolve, "#f00", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
    expect(cssColor(resolve, "red; background: url(https://example.com/x)")).toBeNull();
    expect(backgroundImage(resolve, "url(https://example.com/x)")).toBeUndefined();
  });

  it("stacks fills with the last one on top and maps gradient angles", () => {
    expect(
      backgroundImage(resolve, [
        "#000000",
        {
          type: "gradient",
          gradientType: "linear",
          rotation: 90,
          colors: [
            { color: "#ffffff", position: 0 },
            { color: "#ff0000", position: 1 },
          ],
        },
      ]),
    ).toBe(
      "linear-gradient(270.00deg, #ffffff 0%, #ff0000 100%), linear-gradient(#000000, #000000)",
    );
  });

  it("reads both current and 2.8-era strokes", () => {
    expect(
      parseStroke(resolve, {
        id: "a",
        type: "frame",
        stroke: "#000000",
        strokeWidth: { bottom: 2 },
        strokeAlignment: "outer",
      }),
    ).toMatchObject({ color: "#000000", align: "outer", widths: { top: 0, bottom: 2 } });
    expect(
      parseStroke(resolve, {
        id: "b",
        type: "frame",
        stroke: { align: "inside", thickness: { right: 1 }, fill: "#cccccc" },
      }),
    ).toMatchObject({ color: "#cccccc", align: "inner", widths: { right: 1, left: 0 } });
    expect(
      parseStroke(resolve, { id: "c", type: "frame", stroke: { align: "inside", thickness: 1 } }),
    ).toBeNull();
  });

  it("parses sizing behaviors with fallbacks", () => {
    expect(parseSize(resolve, 120)).toEqual({ kind: "fixed", px: 120 });
    expect(parseSize(resolve, "fill_container")).toEqual({ kind: "fill", fallback: undefined });
    expect(parseSize(resolve, "fit_content(100)")).toEqual({ kind: "fit", fallback: 100 });
    expect(parseSize(resolve, "auto")).toBeUndefined();
  });
});
