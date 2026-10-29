/**
 * F2AE document schema v1 — the contract between the Figma extractor and the AE builder.
 *
 * Conventions
 *  - All coordinates are pixels, y-down (identical to Figma and After Effects).
 *  - `Mat2x3` is [a, b, c, d, tx, ty] mapping (x, y) → (a·x + c·y + tx, b·x + d·y + ty).
 *  - Every node's `transform` maps node-local space (0..w, 0..h) into ROOT space, whose
 *    origin is the top-left of the root's axis-aligned bounding box (= comp origin).
 *  - Bezier tangents are RELATIVE to their vertex (After Effects `Shape` convention).
 *  - Colours are linear 0..1 floats in sRGB space, RGBA tuples.
 *
 * Types only — this file emits no runtime code, so it is safe for the ES3 build.
 */

export type Mat2x3 = [number, number, number, number, number, number];
export type Pt = [number, number];
export type RGBA = [number, number, number, number];

export interface Size {
  w: number;
  h: number;
}

export type BlendMode =
  | 'normal'
  | 'darken'
  | 'multiply'
  | 'linearBurn'
  | 'colorBurn'
  | 'lighten'
  | 'screen'
  | 'linearDodge'
  | 'colorDodge'
  | 'overlay'
  | 'softLight'
  | 'hardLight'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

// ───────────────────────────── Geometry ─────────────────────────────

export interface BezierPath {
  /** closed */
  c: boolean;
  /** vertices */
  v: Pt[];
  /** in-tangents, relative to vertex */
  i: Pt[];
  /** out-tangents, relative to vertex */
  o: Pt[];
}

export type FillRule = 'nonzero' | 'evenodd';

export interface RectGeometry {
  type: 'rect';
  w: number;
  h: number;
  radius: number;
}

export interface EllipseGeometry {
  type: 'ellipse';
  w: number;
  h: number;
}

export interface PathGeometry {
  type: 'path';
  paths: BezierPath[];
  rule: FillRule;
}

export type Geometry = RectGeometry | EllipseGeometry | PathGeometry;

// ────────────────────────────── Paints ──────────────────────────────

export interface SolidPaint {
  type: 'solid';
  color: RGBA;
  opacity: number;
  blendMode: BlendMode;
}

export interface GradientStop {
  pos: number;
  color: RGBA;
}

export interface GradientPaint {
  type: 'linear' | 'radial';
  stops: GradientStop[];
  /** node-local start point (radial: centre) */
  start: Pt;
  /** node-local end point (radial: point on the edge) */
  end: Pt;
  opacity: number;
  blendMode: BlendMode;
  /** true when Figma's gradient (angular/diamond/elliptical) could only be approximated */
  approximated: boolean;
}

export type ImageScaleMode = 'fill' | 'fit' | 'crop' | 'tile';

export interface ImagePaint {
  type: 'image';
  /** asset hash (key into F2AEDocument.assets) */
  asset: string;
  /** source image pixel size */
  imageSize: Size;
  /** maps image pixel space → node-local space */
  placement: Mat2x3;
  opacity: number;
  blendMode: BlendMode;
  scaleMode: ImageScaleMode;
}

export type Paint = SolidPaint | GradientPaint | ImagePaint;

// ────────────────────────────── Strokes ─────────────────────────────

export type StrokeAlign = 'center' | 'inside' | 'outside';
export type StrokeCap = 'butt' | 'round' | 'square';
export type StrokeJoin = 'miter' | 'round' | 'bevel';

export interface Stroke {
  paints: Paint[];
  weight: number;
  align: StrokeAlign;
  cap: StrokeCap;
  join: StrokeJoin;
  miterLimit: number;
  dash: number[];
  /** false when per-side weights differ (rectangles/frames) */
  uniform: boolean;
  /** Figma strokeGeometry — outlined stroke as filled path, used when native AE strokes can't match */
  outline: PathGeometry | null;
}

// ────────────────────────────── Effects ─────────────────────────────

export interface ShadowEffect {
  type: 'dropShadow' | 'innerShadow';
  color: RGBA;
  offset: Pt;
  radius: number;
  spread: number;
  blendMode: BlendMode;
}

export interface BlurEffect {
  type: 'layerBlur' | 'backgroundBlur';
  radius: number;
}

export type Effect = ShadowEffect | BlurEffect;

// ─────────────────────────────── Text ───────────────────────────────

export type TextAutoResize = 'none' | 'height' | 'widthAndHeight' | 'truncate';
export type TextAlignH = 'left' | 'center' | 'right' | 'justified';
export type TextAlignV = 'top' | 'center' | 'bottom';
export type TextCase = 'original' | 'upper' | 'lower' | 'title' | 'smallCaps';
export type TextDecoration = 'none' | 'underline' | 'strikethrough';

export interface FontRef {
  family: string;
  style: string;
}

export interface TextSegment {
  start: number;
  end: number;
  font: FontRef;
  size: number;
  /** px; null = auto */
  lineHeight: number | null;
  /** px */
  letterSpacing: number;
  /** first visible solid fill (null when the segment is gradient/image-filled) */
  color: RGBA | null;
  decoration: TextDecoration;
  textCase: TextCase;
}

export interface TextData {
  characters: string;
  autoResize: TextAutoResize;
  alignH: TextAlignH;
  alignV: TextAlignV;
  paragraphSpacing: number;
  segments: TextSegment[];
}

// ─────────────────────────────── Nodes ──────────────────────────────

export type MaskType = 'alpha' | 'vector' | 'luminance';

export interface BaseNode {
  id: string;
  name: string;
  /** original Figma node type (FRAME, VECTOR, TEXT …) — informational */
  figmaType: string;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
  size: Size;
  /** node-local → root space */
  transform: Mat2x3;
  effects: Effect[];
  isMask: boolean;
  maskType: MaskType;
}

export interface ContainerNode extends BaseNode {
  kind: 'container';
  clips: boolean;
  /** background geometry (frames: rect/path; groups: null) */
  geometry: Geometry | null;
  fills: Paint[];
  stroke: Stroke | null;
  children: SceneNode[];
}

export interface ShapeNode extends BaseNode {
  kind: 'shape';
  geometry: Geometry;
  fills: Paint[];
  stroke: Stroke | null;
}

export interface TextNode extends BaseNode {
  kind: 'text';
  text: TextData;
}

/** Rasterised fallback for content that has no faithful vector mapping. */
export interface RasterNode extends BaseNode {
  kind: 'raster';
  asset: string;
  /** exported bitmap pixel size (node size × export scale) */
  imageSize: Size;
  reason: string;
}

export type SceneNode = ContainerNode | ShapeNode | TextNode | RasterNode;

// ───────────────────────────── Document ─────────────────────────────

export type BuildTarget = 'newComp' | 'activeComp';

export interface BuildOptions {
  /** true: one AE layer per node with parenting; false: one shape layer per root */
  breakApart: boolean;
  /** clipping frames become nested precomps (true) or alpha track mattes (false) */
  clippedFramesAsPrecomps: boolean;
  includeHidden: boolean;
  target: BuildTarget;
  frameRate: number;
  /** seconds */
  duration: number;
  /** raster/image export scale */
  imageScale: number;
}

export interface Root {
  node: SceneNode;
  /** axis-aligned bounds in root space (always x=y=0) */
  size: Size;
  /** absolute canvas position of the root bounds (used to keep relative layout in activeComp mode) */
  canvasOrigin: Pt;
}

export interface AssetInfo {
  hash: string;
  mime: 'image/png' | 'image/jpeg' | 'image/gif';
  width: number;
  height: number;
  byteLength: number;
}

export interface F2AEDocument {
  schemaVersion: 1;
  generator: { name: string; version: string };
  createdAt: number;
  source: { fileName: string; pageName: string };
  options: BuildOptions;
  roots: Root[];
  assets: AssetInfo[];
  fonts: FontRef[];
  /** extraction-time warnings, surfaced to the user together with build warnings */
  warnings: string[];
}

export interface BuildStats {
  comps: number;
  layers: number;
  nodes: number;
  durationMs: number;
}

export interface BuildResult {
  ok: boolean;
  stats: BuildStats;
  warnings: string[];
  error?: string;
}

export var DEFAULT_BUILD_OPTIONS: BuildOptions = {
  breakApart: true,
  clippedFramesAsPrecomps: true,
  includeHidden: false,
  target: 'newComp',
  frameRate: 30,
  duration: 10,
  imageScale: 2,
};
