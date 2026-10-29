/**
 * F2AE document → After Effects layers.
 *
 * Break Apart ON  — one AE layer per node (plus helper layers for gradients/images),
 *                   containers become their background shape layer or a Null, children are
 *                   parented, clipping frames become precomps or alpha mattes, masks become
 *                   track mattes.
 * Break Apart OFF — each root becomes as few shape layers as possible with nested shape
 *                   groups mirroring the hierarchy; nodes that need layer-level features are
 *                   split out (see isSpecial) and parented under a root null.
 *
 * Stacking: AE inserts new layers at index 1 (top). Nodes are created bottom→top in Figma
 * child order, so the final order matches Figma without any re-sorting.
 */
import { geometryToPath } from '@f2ae/shared/geometry';
import { apply, identity, invert, multiply, scaling, translation } from '@f2ae/shared/matrix';
import type {
  BlendMode,
  BuildResult,
  ContainerNode,
  F2AEDocument,
  Geometry,
  GradientPaint,
  ImagePaint,
  Mat2x3,
  Paint,
  RasterNode,
  RGBA,
  SceneNode,
  ShapeNode,
  SolidPaint,
  Stroke,
} from '@f2ae/shared/schema';
import { applyEffects, addTritone } from './effects';
import { findOrCreateFolder, footageFor, newFootageCache, type FootageCache } from './images';
import { applyGroupTransform, applyLayerTransform, place, type Placement } from './layout';
import {
  addGeometry,
  addGroup,
  addPaths,
  addRampFill,
  addSolidFill,
  addSolidStroke,
  contentsOf,
  sampleGradient,
  shearGeometry,
  toAEShape,
} from './shapes';
import { buildText, resetFontCache } from './text';
import { newWarnings, nowMs, warn, type Warnings } from './util';

export interface BuildContext {
  doc: F2AEDocument;
  assets: { [hash: string]: string };
  w: Warnings;
  footage: FootageCache;
  rootFolder: any;
  compsFolder: any;
  stats: { comps: number; layers: number; nodes: number };
  canMatte: boolean;
}

/** Where a node's layers attach: parent layer (or none) and its layer space → comp matrix. */
interface Parent {
  layer: any;
  toComp: Mat2x3;
  /** accumulated opacity of ancestors that AE parenting cannot propagate (nulls) */
  opacity: number;
}

var BLEND_AE: { [k: string]: string } = {
  normal: 'NORMAL',
  darken: 'DARKEN',
  multiply: 'MULTIPLY',
  linearBurn: 'LINEAR_BURN',
  colorBurn: 'COLOR_BURN',
  lighten: 'LIGHTEN',
  screen: 'SCREEN',
  linearDodge: 'LINEAR_DODGE',
  colorDodge: 'COLOR_DODGE',
  overlay: 'OVERLAY',
  softLight: 'SOFT_LIGHT',
  hardLight: 'HARD_LIGHT',
  difference: 'DIFFERENCE',
  exclusion: 'EXCLUSION',
  hue: 'HUE',
  saturation: 'SATURATION',
  color: 'COLOR',
  luminosity: 'LUMINOSITY',
};

function setBlend(layer: any, mode: BlendMode): void {
  if (mode === 'normal') return;
  var key = BLEND_AE[mode];
  if (key && BlendingMode[key] !== undefined) layer.blendingMode = BlendingMode[key];
}

function isSolid(p: Paint): p is SolidPaint {
  return p.type === 'solid';
}

// ─────────────────────────────── layer helpers ───────────────────────────────

function newShapeLayer(ctx: BuildContext, comp: any, name: string): any {
  var l = comp.layers.addShape();
  l.name = name;
  ctx.stats.layers++;
  return l;
}

function finishLayer(ctx: BuildContext, layer: any, parent: Parent, p: Placement, opacity: number, visible: boolean): void {
  if (parent.layer) layer.setParentWithJump(parent.layer);
  applyLayerTransform(layer, p, opacity);
  if (!visible) layer.enabled = false;
  void ctx;
}

var HELPER_TAG = 'f2ae:helper';

/** Marks a layer as an internal matte so later mask/clip passes never re-matte it. */
function markHelper(layer: any): void {
  layer.comment = HELPER_TAG;
  layer.enabled = false;
}

/**
 * Applies a track matte to every eligible layer. A layer can only have one matte, so layers
 * that already have one (gradient alpha) keep it and a warning is emitted.
 */
function applyMatte(ctx: BuildContext, layers: any[], matte: any, type: any, label: string): void {
  for (var i = 0; i < layers.length; i++) {
    var l = layers[i];
    if (l === matte || l.comment === HELPER_TAG) continue;
    if (l.trackMatteType !== undefined && l.trackMatteType !== TrackMatteType.NO_TRACK_MATTE) {
      warn(ctx.w, '"' + l.name + '": already uses a matte; ' + label + ' not applied to it');
      continue;
    }
    l.setTrackMatte(matte, type);
  }
}

// ───────────────────────────── shape paint passes ────────────────────────────

/**
 * Splits a node's paints into render passes, bottom → top. Consecutive solid paints share
 * one shape layer; each gradient/image paint needs its own layer.
 */
interface Pass {
  kind: 'vector' | 'gradient' | 'image';
  fills: SolidPaint[];
  strokes: SolidPaint[];
  gradient: GradientPaint | null;
  gradientIsStroke: boolean;
  image: ImagePaint | null;
}

function passesFor(fills: Paint[], stroke: Stroke | null): Pass[] {
  var out: Pass[] = [];
  var cur: Pass | null = null;
  var i: number;
  for (i = 0; i < fills.length; i++) {
    var f = fills[i];
    if (isSolid(f)) {
      if (!cur) {
        cur = { kind: 'vector', fills: [], strokes: [], gradient: null, gradientIsStroke: false, image: null };
        out.push(cur);
      }
      cur.fills.push(f);
    } else {
      cur = null;
      if (f.type === 'image') out.push({ kind: 'image', fills: [], strokes: [], gradient: null, gradientIsStroke: false, image: f });
      else out.push({ kind: 'gradient', fills: [], strokes: [], gradient: f, gradientIsStroke: false, image: null });
    }
  }
  if (stroke) {
    for (i = 0; i < stroke.paints.length; i++) {
      var s = stroke.paints[i];
      if (isSolid(s)) {
        if (!cur) {
          cur = { kind: 'vector', fills: [], strokes: [], gradient: null, gradientIsStroke: false, image: null };
          out.push(cur);
        }
        cur.strokes.push(s);
      } else if (s.type !== 'image') {
        cur = null;
        out.push({ kind: 'gradient', fills: [], strokes: [], gradient: s, gradientIsStroke: true, image: null });
      }
    }
  }
  return out;
}

/** Adds stroke items for one solid stroke paint, honouring alignment. Returns false if it used native stroke. */
function addStrokeFor(contents: any, geom: Geometry, sheared: boolean, s: Stroke, paint: SolidPaint, w: Warnings, name: string): void {
  if (s.align === 'center' && s.uniform) {
    addSolidStroke(contents, s, paint, s.weight);
    return;
  }
  var parametric = (geom.type === 'rect' || geom.type === 'ellipse') && !sheared && s.uniform;
  if (parametric) {
    var g = addGroup(contents, 'Stroke');
    var gc = contentsOf(g, false);
    addGeometry(gc, geom, s.align === 'inside' ? s.weight / 2 : -s.weight / 2);
    addSolidStroke(gc, s, paint, s.weight);
    g.moveTo(1);
    return;
  }
  if (s.outline && !sheared) {
    var og = addGroup(contents, 'Stroke');
    var oc = contentsOf(og, false);
    addPaths(oc, s.outline);
    addSolidFill(oc, paint, 'nonzero', 1);
    og.moveTo(1);
    return;
  }
  warn(w, '"' + name + '": ' + s.align + ' stroke approximated as centred');
  addSolidStroke(contents, s, paint, s.weight);
}

/** Fills one shape group's contents with geometry + solid strokes + solid fills (correct z-order). */
function fillVectorContents(contents: any, geom: Geometry, sheared: boolean, fills: SolidPaint[], strokes: SolidPaint[], stroke: Stroke | null, w: Warnings, name: string): void {
  var rule = geom.type === 'path' ? geom.rule : 'nonzero';
  addGeometry(contents, geom, 0);
  var i: number;
  // top-most first: Figma's last stroke/fill is on top
  if (stroke) for (i = strokes.length - 1; i >= 0; i--) addStrokeFor(contents, geom, sheared, stroke, strokes[i], w, name);
  for (i = fills.length - 1; i >= 0; i--) addSolidFill(contents, fills[i], rule, 1);
}

function alphaVaries(g: GradientPaint): boolean {
  for (var i = 1; i < g.stops.length; i++) if (Math.abs(g.stops[i].color[3] - g.stops[0].color[3]) > 0.002) return true;
  return false;
}

function grey(a: number): RGBA {
  return [a, a, a, 1];
}

/** Builds the shape-ramp layer content for a gradient pass. */
function gradientLayerContent(layer: any, geom: Geometry, g: GradientPaint, isStroke: boolean, stroke: Stroke | null): void {
  var grp = addGroup(contentsOf(layer, true), 'Gradient');
  var c = contentsOf(grp, false);
  var useOutline = isStroke && stroke && (stroke.align !== 'center' || !stroke.uniform) && stroke.outline;
  if (useOutline) addPaths(c, stroke!.outline!);
  else addGeometry(c, geom, 0);
  if (isStroke && !useOutline) {
    var st = c.addProperty('ADBE Vector Graphic - G-Stroke');
    st.property('ADBE Vector Grad Type').setValue(g.type === 'radial' ? 2 : 1);
    st.property('ADBE Vector Grad Start Pt').setValue([g.start[0], g.start[1]]);
    st.property('ADBE Vector Grad End Pt').setValue([g.end[0], g.end[1]]);
    st.property('ADBE Vector Stroke Width').setValue(stroke ? stroke.weight : 1);
  } else {
    addRampFill(c, g, geom.type === 'path' ? geom.rule : 'nonzero');
  }
}

/**
 * Builds the layers for a shape-like node (shape node or container background).
 * Returns created layers bottom→top; the first is the node's primary layer.
 */
function buildShapeLayers(ctx: BuildContext, comp: any, node: ShapeNode | ContainerNode, geometry: Geometry, N: Mat2x3, parent: Parent, name: string, opacity: number): { layers: any[]; primary: any; primaryToComp: Mat2x3 } {
  var passes = passesFor(node.fills, node.stroke);
  if (passes.length === 0) passes.push({ kind: 'vector', fills: [], strokes: [], gradient: null, gradientIsStroke: false, image: null });
  var layers: any[] = [];
  var primary: any = null;
  var primaryToComp: Mat2x3 = N;
  var w = ctx.w;

  for (var i = 0; i < passes.length; i++) {
    var pass = passes[i];
    var attach: Parent = primary ? { layer: primary, toComp: primaryToComp, opacity: 1 } : parent;
    // AE parenting never propagates opacity, so every pass carries the node's opacity
    var layerOpacity = opacity;
    var suffix = i === 0 ? '' : pass.kind === 'image' ? ' ▸ image' : pass.kind === 'gradient' ? ' ▸ gradient' : ' ▸ paint';

    if (pass.kind === 'image') {
      var img = imageLayer(ctx, comp, pass.image!, geometry, N, attach, name + suffix, layerOpacity, node.visible);
      if (!img) continue;
      layers.push(img.layer);
      if (!primary) {
        primary = img.layer;
        primaryToComp = img.toComp;
      }
      continue;
    }

    var layer = newShapeLayer(ctx, comp, name + suffix);
    var p = place(N, attach.toComp, node.size, null);
    var geom = shearGeometry(geometry, p.shear);
    var sheared = p.shear !== 0;

    if (pass.kind === 'vector') {
      var grp = addGroup(contentsOf(layer, true), name);
      fillVectorContents(contentsOf(grp, false), geom, sheared, pass.fills, pass.strokes, node.stroke, w, name);
    } else {
      var g = pass.gradient!;
      gradientLayerContent(layer, geom, g, pass.gradientIsStroke, node.stroke);
      if (g.stops.length > 3) warn(w, '"' + name + '": gradient with ' + g.stops.length + ' stops approximated with 3');
      addTritone(layer, sampleGradient(g, 0), sampleGradient(g, 0.5), sampleGradient(g, 1));
      var constAlpha = g.stops.length ? g.stops[0].color[3] : 1;
      layerOpacity *= g.opacity * (alphaVaries(g) ? 1 : constAlpha);
      if (alphaVaries(g) && ctx.canMatte) {
        var matte = newShapeLayer(ctx, comp, name + ' ▸ gradient alpha');
        gradientLayerContent(matte, geom, g, pass.gradientIsStroke, node.stroke);
        addTritone(matte, grey(sampleGradient(g, 0)[3]), grey(sampleGradient(g, 0.5)[3]), grey(sampleGradient(g, 1)[3]));
        finishLayer(ctx, matte, attach, place(N, attach.toComp, node.size, null), 1, true);
        markHelper(matte);
        layer.setTrackMatte(matte, TrackMatteType.LUMA);
        layers.push(matte);
      }
    }
    finishLayer(ctx, layer, attach, p, layerOpacity, node.visible);
    layers.push(layer);
    if (!primary) {
      primary = layer;
      primaryToComp = p.toComp;
    }
  }
  if (!primary) {
    // every pass failed (e.g. missing images): keep hierarchy intact with an empty shape layer
    primary = newShapeLayer(ctx, comp, name);
    var pp = place(N, parent.toComp, node.size, null);
    finishLayer(ctx, primary, parent, pp, opacity, node.visible);
    primaryToComp = pp.toComp;
    layers.push(primary);
  }
  return { layers: layers, primary: primary, primaryToComp: primaryToComp };
}

function imageLayer(ctx: BuildContext, comp: any, paint: ImagePaint, geometry: Geometry, N: Mat2x3, parent: Parent, name: string, opacity: number, visible: boolean): { layer: any; toComp: Mat2x3 } | null {
  var item = footageFor(ctx.footage, paint.asset, ctx.assets, ctx.rootFolder, ctx.w);
  if (!item) return null;
  var fw = item.width;
  var fh = item.height;
  // placement maps paint.imageSize px → node; footage may be a different pixel size
  var imageToNode = multiply(paint.placement, scaling(paint.imageSize.w / fw, paint.imageSize.h / fh));
  var Nimg = multiply(N, imageToNode);
  var layer = comp.layers.add(item);
  ctx.stats.layers++;
  layer.name = name;
  var p = place(Nimg, parent.toComp, { w: fw, h: fh }, null);
  if (p.shear !== 0) warn(ctx.w, '"' + name + '": skewed images are not supported; skew ignored');
  // clip to the node outline with a layer mask expressed in this layer's space
  var nodeToLayer = multiply(invert(p.toComp), N);
  var pg = geometryToPath(geometry);
  var masks = layer.property('ADBE Mask Parade');
  for (var i = 0; i < pg.paths.length; i++) {
    var src = pg.paths[i];
    var v: number[][] = [];
    var ii: number[][] = [];
    var oo: number[][] = [];
    for (var k = 0; k < src.v.length; k++) {
      v.push(apply(nodeToLayer, src.v[k]));
      var a = apply(nodeToLayer, [src.v[k][0] + src.i[k][0], src.v[k][1] + src.i[k][1]]);
      var b = apply(nodeToLayer, [src.v[k][0] + src.o[k][0], src.v[k][1] + src.o[k][1]]);
      var vk = v[k];
      ii.push([a[0] - vk[0], a[1] - vk[1]]);
      oo.push([b[0] - vk[0], b[1] - vk[1]]);
    }
    var m = masks.addProperty('ADBE Mask Atom');
    m.property('ADBE Mask Shape').setValue(toAEShape({ c: true, v: v as any, i: ii as any, o: oo as any }));
  }
  finishLayer(ctx, layer, parent, p, opacity * paint.opacity, visible);
  setBlend(layer, paint.blendMode);
  return { layer: layer, toComp: p.toComp };
}

function rasterLayer(ctx: BuildContext, comp: any, node: RasterNode, N: Mat2x3, parent: Parent): any[] {
  var item = footageFor(ctx.footage, node.asset, ctx.assets, ctx.rootFolder, ctx.w);
  if (!item) return [];
  var layer = comp.layers.add(item);
  ctx.stats.layers++;
  layer.name = node.name;
  var Nimg = multiply(N, scaling(node.size.w / item.width, node.size.h / item.height));
  var p = place(Nimg, parent.toComp, { w: item.width, h: item.height }, null);
  finishLayer(ctx, layer, parent, p, node.opacity * parent.opacity, node.visible);
  setBlend(layer, node.blendMode);
  return [layer];
}

// ─────────────────────────────── break-apart ────────────────────────────────

function nodeMatrix(O: Mat2x3, node: SceneNode): Mat2x3 {
  return multiply(O, node.transform);
}

function hasMaskChild(c: ContainerNode): boolean {
  for (var i = 0; i < c.children.length; i++) if (c.children[i].isMask) return true;
  return false;
}

function subtreeHasMask(c: ContainerNode): boolean {
  var stack: SceneNode[] = [c];
  while (stack.length) {
    var n = stack.pop()!;
    if (n.kind === 'container') {
      if (n !== c && (n.isMask || n.clips)) return true;
      for (var i = 0; i < n.children.length; i++) {
        if (n.children[i].isMask) return true;
        stack.push(n.children[i]);
      }
    }
  }
  return false;
}

/** Builds a node (and subtree). Returns every layer created, bottom→top. */
export function buildNode(ctx: BuildContext, comp: any, node: SceneNode, O: Mat2x3, parent: Parent, grouped: boolean): any[] {
  ctx.stats.nodes++;
  var N = nodeMatrix(O, node);
  var layersBefore = comp.numLayers;
  var countBefore = ctx.stats.layers;
  try {
    if (node.kind === 'shape') {
      var r = buildShapeLayers(ctx, comp, node, node.geometry, N, parent, node.name, node.opacity * parent.opacity);
      if (r.primary) setBlend(r.primary, node.blendMode);
      applyEffects(r.layers, node.effects, ctx.w, node.name);
      return r.layers;
    }
    if (node.kind === 'text') {
      var t = buildText(comp, node, ctx.w);
      ctx.stats.layers++;
      var tp = place(N, parent.toComp, node.size, t.offset);
      if (tp.shear !== 0) warn(ctx.w, '"' + node.name + '": skewed text is not supported; skew ignored');
      finishLayer(ctx, t.layer, parent, tp, node.opacity * parent.opacity, node.visible);
      setBlend(t.layer, node.blendMode);
      applyEffects([t.layer], node.effects, ctx.w, node.name);
      return [t.layer];
    }
    if (node.kind === 'raster') {
      return rasterLayer(ctx, comp, node, N, parent);
    }
    return buildContainer(ctx, comp, node, O, N, parent, grouped);
  } catch (e) {
    warn(ctx.w, '"' + node.name + '": failed to build (' + String(e) + ')');
    // roll back partially created layers (new layers are always inserted at the top)
    var added = comp.numLayers - layersBefore;
    for (var rb = 0; rb < added; rb++) {
      try {
        comp.layer(1).remove();
      } catch (e2) {
        break;
      }
    }
    ctx.stats.layers = countBefore;
    return [];
  }
}

function buildChildren(ctx: BuildContext, comp: any, children: SceneNode[], O: Mat2x3, parent: Parent, grouped: boolean): any[] {
  var all: any[] = [];
  var mask: any = null;
  var maskType: any = null;
  for (var i = 0; i < children.length; i++) {
    var child = children[i];
    var made = grouped ? buildGroupedNode(ctx, comp, child, O, parent) : buildNode(ctx, comp, child, O, parent, false);
    if (child.isMask && made.length > 0) {
      if (!ctx.canMatte) {
        warn(ctx.w, 'masks require After Effects 2023 or newer; "' + child.name + '" left visible');
        continue;
      }
      mask = made[made.length - 1];
      maskType = child.maskType === 'luminance' ? TrackMatteType.LUMA : TrackMatteType.ALPHA;
      for (var m = 0; m < made.length; m++) made[m].enabled = false;
      if (made.length > 1) warn(ctx.w, '"' + child.name + '": mask uses only its top layer');
    } else if (mask) {
      applyMatte(ctx, made, mask, maskType, 'mask "' + children[i].name + '"');
    }
    for (var j = 0; j < made.length; j++) all.push(made[j]);
  }
  return all;
}

function newPrecomp(ctx: BuildContext, name: string, w: number, h: number): any {
  var o = ctx.doc.options;
  var pc = app.project.items.addComp(name, Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)), 1, o.duration, o.frameRate);
  pc.parentFolder = ctx.compsFolder;
  ctx.stats.comps++;
  return pc;
}

function buildContainer(ctx: BuildContext, comp: any, node: ContainerNode, O: Mat2x3, N: Mat2x3, parent: Parent, grouped: boolean): any[] {
  var hasBg = node.geometry !== null && (node.fills.length > 0 || node.stroke !== null);
  var usePrecomp = node.clips && (ctx.doc.options.clippedFramesAsPrecomps || !ctx.canMatte || subtreeHasMask(node) || grouped);

  if (usePrecomp) {
    var pc = newPrecomp(ctx, node.name, node.size.w, node.size.h);
    var inner: Parent = { layer: null, toComp: identity(), opacity: 1 };
    var innerO = invert(node.transform); // root space → precomp (node-local) space
    if (hasBg) buildShapeLayers(ctx, pc, node, node.geometry!, identity(), inner, node.name + ' ▸ background', 1);
    if (grouped) buildGroupedChildren(ctx, pc, node, innerO, inner);
    else buildChildren(ctx, pc, node.children, innerO, inner, false);
    var layer = comp.layers.add(pc);
    ctx.stats.layers++;
    layer.name = node.name;
    var p = place(N, parent.toComp, node.size, null);
    if (p.shear !== 0) warn(ctx.w, '"' + node.name + '": skewed precomps are not supported; skew ignored');
    finishLayer(ctx, layer, parent, p, node.opacity * parent.opacity, node.visible);
    setBlend(layer, node.blendMode);
    applyEffects([layer], node.effects, ctx.w, node.name);
    return [layer];
  }

  var all: any[] = [];
  var primary: any;
  var primaryToComp: Mat2x3;
  var childOpacity = parent.opacity * node.opacity;
  if (hasBg) {
    var bg = buildShapeLayers(ctx, comp, node, node.geometry!, N, parent, node.name, childOpacity);
    primary = bg.primary;
    primaryToComp = bg.primaryToComp;
    for (var i = 0; i < bg.layers.length; i++) all.push(bg.layers[i]);
    applyEffects(bg.layers, node.effects, ctx.w, node.name);
  } else {
    primary = comp.layers.addNull(ctx.doc.options.duration);
    ctx.stats.layers++;
    primary.name = node.name;
    var np = place(N, parent.toComp, node.size, null);
    finishLayer(ctx, primary, parent, np, 1, true);
    primaryToComp = np.toComp;
    all.push(primary);
    if (node.effects.length > 0) warn(ctx.w, '"' + node.name + '": effects on a group without fill need "Clipped frames as precomps" or a frame fill');
  }
  if (node.blendMode !== 'normal') {
    if (hasBg) setBlend(primary, node.blendMode);
    else warn(ctx.w, '"' + node.name + '": group blend mode needs a precomp; ignored');
  }

  var matte: any = null;
  if (node.clips) {
    matte = newShapeLayer(ctx, comp, node.name + ' ▸ clip');
    var mg = addGroup(contentsOf(matte, true), 'Clip');
    var mc = contentsOf(mg, false);
    var mp = place(N, primaryToComp, node.size, null);
    addGeometry(mc, shearGeometry(node.geometry || { type: 'rect', w: node.size.w, h: node.size.h, radius: 0 }, mp.shear), 0);
    addSolidFill(mc, { type: 'solid', color: [1, 1, 1, 1], opacity: 1, blendMode: 'normal' }, 'nonzero', 1);
    finishLayer(ctx, matte, { layer: primary, toComp: primaryToComp, opacity: 1 }, mp, 1, true);
    markHelper(matte);
    all.push(matte);
  }

  var kids = buildChildren(ctx, comp, node.children, O, { layer: primary, toComp: primaryToComp, opacity: childOpacity }, false);
  if (matte) applyMatte(ctx, kids, matte, TrackMatteType.ALPHA, 'clipping of "' + node.name + '"');
  for (var k = 0; k < kids.length; k++) all.push(kids[k]);
  if (!node.visible) for (var h = 0; h < all.length; h++) all[h].enabled = false;
  return all;
}

// ───────────────────────────────── grouped ──────────────────────────────────

/** Nodes that cannot live inside a shared shape layer. */
function isSpecial(n: SceneNode): boolean {
  if (n.kind === 'text' || n.kind === 'raster') return true;
  if (n.effects.length > 0 || n.blendMode !== 'normal' || n.isMask) return true;
  if (n.kind === 'container' && (n.clips || hasMaskChild(n))) return true;
  if (n.kind === 'shape' || n.kind === 'container') {
    for (var i = 0; i < n.fills.length; i++) if (!isSolid(n.fills[i])) return true;
    if (n.stroke) for (var j = 0; j < n.stroke.paints.length; j++) if (!isSolid(n.stroke.paints[j])) return true;
  }
  return false;
}

function subtreeHasSpecial(c: ContainerNode): boolean {
  for (var i = 0; i < c.children.length; i++) {
    var ch = c.children[i];
    if (isSpecial(ch)) return true;
    if (ch.kind === 'container' && subtreeHasSpecial(ch)) return true;
  }
  return false;
}

interface Chunk {
  layer: any;
  gen: number;
}

interface Anc {
  node: ContainerNode;
  /** node-local → root-layer space after shear */
  space: Mat2x3;
  group: any;
  gen: number;
  placement: Placement;
}

interface GroupUnit {
  ctx: BuildContext;
  comp: any;
  root: ContainerNode;
  /** root layer space → comp */
  rootToComp: Mat2x3;
  /** root-space → root-local (for descendant matrices) */
  rootInv: Mat2x3;
  O: Mat2x3;
  parent: Parent;
  rootNull: any;
  chunk: Chunk | null;
  chunkCount: number;
  genSeq: number;
  layers: any[];
  single: boolean;
}

function openChunk(u: GroupUnit): Chunk {
  if (u.chunk) return u.chunk;
  u.chunkCount++;
  var name = u.single ? u.root.name : u.root.name + ' ▸ shapes' + (u.chunkCount > 1 ? ' ' + u.chunkCount : '');
  var layer = newShapeLayer(u.ctx, u.comp, name);
  var attach: Parent = u.rootNull ? { layer: u.rootNull, toComp: u.rootToComp, opacity: 1 } : u.parent;
  var p = place(multiply(u.O, u.root.transform), attach.toComp, u.root.size, null);
  finishLayer(u.ctx, layer, attach, p, u.root.opacity * u.parent.opacity, u.root.visible);
  if (!u.rootNull) u.rootToComp = p.toComp;
  u.layers.push(layer);
  u.chunk = { layer: layer, gen: ++u.genSeq };
  return u.chunk;
}

/** Ensures the ancestor group chain exists in the current chunk; returns the innermost contents. */
function ensureGroups(u: GroupUnit, ancestors: Anc[]): any {
  var chunk = openChunk(u);
  var contents = contentsOf(chunk.layer, true);
  for (var i = 0; i < ancestors.length; i++) {
    var a = ancestors[i];
    if (a.gen !== chunk.gen) {
      a.group = addGroup(contents, a.node.name);
      applyGroupTransform(a.group, a.placement, a.node.opacity);
      if (!a.node.visible) a.group.enabled = false;
      a.group.moveTo(1);
      a.gen = chunk.gen;
    }
    contents = contentsOf(a.group, false);
  }
  return contents;
}

function walkGrouped(u: GroupUnit, c: ContainerNode, ancestors: Anc[], parentSpace: Mat2x3): void {
  var ctx = u.ctx;
  for (var i = 0; i < c.children.length; i++) {
    var ch = c.children[i];
    if (isSpecial(ch)) {
      u.chunk = null; // later vectors must stack above this layer
      var opacity = u.root.opacity * u.parent.opacity;
      for (var a = 0; a < ancestors.length; a++) opacity *= ancestors[a].node.opacity;
      var made = buildGroupedNode(ctx, u.comp, ch, u.O, { layer: u.rootNull, toComp: u.rootToComp, opacity: opacity });
      for (var m = 0; m < made.length; m++) u.layers.push(made[m]);
      continue;
    }
    ctx.stats.nodes++;
    var local = multiply(u.rootInv, ch.transform); // node-local → root-local
    var p = place(local, parentSpace, ch.size, null);
    if (ch.kind === 'container') {
      var entry: Anc = { node: ch, space: p.toComp, group: null, gen: -1, placement: p };
      ancestors.push(entry);
      if (ch.geometry && (ch.fills.length > 0 || ch.stroke)) {
        var bgContents = ensureGroups(u, ancestors);
        var bg = addGroup(bgContents, 'Background');
        fillVectorContents(contentsOf(bg, false), shearGeometry(ch.geometry, p.shear), p.shear !== 0, ch.fills as SolidPaint[], ch.stroke ? (ch.stroke.paints as SolidPaint[]) : [], ch.stroke, ctx.w, ch.name);
        bg.moveTo(1);
      }
      walkGrouped(u, ch, ancestors, p.toComp);
      ancestors.pop();
    } else if (ch.kind === 'shape') {
      var contents = ensureGroups(u, ancestors);
      var g = addGroup(contents, ch.name);
      applyGroupTransform(g, p, ch.opacity);
      if (!ch.visible) g.enabled = false;
      fillVectorContents(contentsOf(g, false), shearGeometry(ch.geometry, p.shear), p.shear !== 0, ch.fills as SolidPaint[], ch.stroke ? (ch.stroke.paints as SolidPaint[]) : [], ch.stroke, ctx.w, ch.name);
      g.moveTo(1);
    }
  }
}

function buildGroupedChildren(ctx: BuildContext, comp: any, c: ContainerNode, O: Mat2x3, parent: Parent): any[] {
  // inside a precomp: treat the clipped frame's children as a grouped unit rooted at the frame
  var pseudoRoot: ContainerNode = {
    kind: 'container',
    id: c.id,
    name: c.name + ' ▸ contents',
    figmaType: c.figmaType,
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    size: c.size,
    transform: c.transform,
    effects: [],
    isMask: false,
    maskType: 'alpha',
    clips: false,
    geometry: null,
    fills: [],
    stroke: null,
    children: c.children,
  };
  return buildGroupedUnit(ctx, comp, pseudoRoot, O, parent);
}

function buildGroupedUnit(ctx: BuildContext, comp: any, root: ContainerNode, O: Mat2x3, parent: Parent): any[] {
  var single = !subtreeHasSpecial(root);
  var u: GroupUnit = {
    ctx: ctx,
    comp: comp,
    root: root,
    rootToComp: parent.toComp,
    rootInv: invert(root.transform),
    O: O,
    parent: parent,
    rootNull: null,
    chunk: null,
    chunkCount: 0,
    genSeq: 0,
    layers: [],
    single: single,
  };
  ctx.stats.nodes++;
  if (!single) {
    u.rootNull = comp.layers.addNull(ctx.doc.options.duration);
    ctx.stats.layers++;
    u.rootNull.name = root.name;
    var np = place(multiply(O, root.transform), parent.toComp, root.size, null);
    finishLayer(ctx, u.rootNull, parent, np, 1, true);
    u.rootToComp = np.toComp;
    u.layers.push(u.rootNull);
  }
  var bgNeeded = root.geometry && (root.fills.length > 0 || root.stroke);
  if (bgNeeded || single) {
    var chunk = openChunk(u);
    if (bgNeeded) {
      var bg = addGroup(contentsOf(chunk.layer, true), 'Background');
      fillVectorContents(contentsOf(bg, false), root.geometry!, false, root.fills as SolidPaint[], root.stroke ? (root.stroke.paints as SolidPaint[]) : [], root.stroke, ctx.w, root.name);
    }
  }
  // root-local space is the root layer's own space (identity)
  walkGrouped(u, root, [], identity());
  if (!root.visible) for (var i = 0; i < u.layers.length; i++) u.layers[i].enabled = false;
  if (!single && root.opacity < 1) warn(ctx.w, '"' + root.name + '": group opacity applied per layer');
  return u.layers;
}

function buildGroupedNode(ctx: BuildContext, comp: any, node: SceneNode, O: Mat2x3, parent: Parent): any[] {
  if (node.kind !== 'container') return buildNode(ctx, comp, node, O, parent, false);
  // masks need per-layer track mattes → this subtree is broken apart
  if (hasMaskChild(node)) return buildNode(ctx, comp, node, O, parent, false);
  // clipping → precomp whose contents stay grouped
  if (node.clips) return buildNode(ctx, comp, node, O, parent, true);
  var layers = buildGroupedUnit(ctx, comp, node, O, parent);
  if (node.effects.length > 0) {
    if (layers.length === 1) applyEffects(layers, node.effects, ctx.w, node.name);
    else warn(ctx.w, '"' + node.name + '": group effects need "Break Apart" off with no split layers, or a clipped frame; skipped');
  }
  if (node.blendMode !== 'normal') {
    if (layers.length === 1) setBlend(layers[0], node.blendMode);
    else warn(ctx.w, '"' + node.name + '": group blend mode ignored (group was split into several layers)');
  }
  return layers;
}

// ───────────────────────────────── document ─────────────────────────────────

export function aeMajorVersion(): number {
  var v = parseFloat(String(app.version));
  return isFinite(v) ? v : 0;
}

export function buildDocument(doc: F2AEDocument, assets: { [hash: string]: string }): BuildResult {
  var t0 = nowMs();
  resetFontCache();
  var w = newWarnings();
  for (var i = 0; i < doc.warnings.length; i++) warn(w, doc.warnings[i]);
  var root = findOrCreateFolder('Figma2AE', null);
  var ctx: BuildContext = {
    doc: doc,
    assets: assets,
    w: w,
    footage: newFootageCache(),
    rootFolder: root,
    compsFolder: findOrCreateFolder('Precomps', root),
    stats: { comps: 0, layers: 0, nodes: 0 },
    canMatte: aeMajorVersion() >= 23,
  };
  if (!ctx.canMatte) warn(w, 'After Effects ' + app.version + ' detected: masks/matte clipping need 2023 (23.0) or newer');
  var o = doc.options;
  var firstComp: any = null;

  app.beginUndoGroup('Figma2AE: Import ' + doc.roots.length + ' layer' + (doc.roots.length === 1 ? '' : 's'));
  try {
    var active = app.project.activeItem;
    var intoActive = o.target === 'activeComp' && active && active instanceof CompItem;
    if (o.target === 'activeComp' && !intoActive) warn(w, 'No active composition — created new comps instead');

    var ux = 0;
    var uy = 0;
    var offX = 0;
    var offY = 0;
    if (intoActive) {
      // keep relative canvas layout, centre the union in the active comp
      var minX = Infinity;
      var minY = Infinity;
      var maxX = -Infinity;
      var maxY = -Infinity;
      for (var r = 0; r < doc.roots.length; r++) {
        var rt = doc.roots[r];
        minX = Math.min(minX, rt.canvasOrigin[0]);
        minY = Math.min(minY, rt.canvasOrigin[1]);
        maxX = Math.max(maxX, rt.canvasOrigin[0] + rt.size.w);
        maxY = Math.max(maxY, rt.canvasOrigin[1] + rt.size.h);
      }
      ux = minX;
      uy = minY;
      offX = (active.width - (maxX - minX)) / 2;
      offY = (active.height - (maxY - minY)) / 2;
      firstComp = active;
    }

    for (var k = 0; k < doc.roots.length; k++) {
      var rootEntry = doc.roots[k];
      var comp: any;
      var O: Mat2x3;
      if (intoActive) {
        comp = active;
        O = translation(rootEntry.canvasOrigin[0] - ux + offX, rootEntry.canvasOrigin[1] - uy + offY);
      } else {
        comp = app.project.items.addComp(rootEntry.node.name, Math.max(4, rootEntry.size.w), Math.max(4, rootEntry.size.h), 1, o.duration, o.frameRate);
        comp.parentFolder = root;
        ctx.stats.comps++;
        O = identity();
        if (!firstComp) firstComp = comp;
      }
      var parent: Parent = { layer: null, toComp: identity(), opacity: 1 };
      var n = rootEntry.node;
      // a selected frame that defines its own comp should not clip/precomp itself again
      if (!intoActive && n.kind === 'container' && n.clips) n.clips = false;
      if (o.breakApart) buildNode(ctx, comp, n, O, parent, false);
      else buildGroupedNode(ctx, comp, n, O, parent);
    }
  } finally {
    app.endUndoGroup();
  }
  try {
    if (firstComp) firstComp.openInViewer();
  } catch (e) {
    /* headless / no viewer */
  }
  return {
    ok: true,
    stats: { comps: ctx.stats.comps, layers: ctx.stats.layers, nodes: ctx.stats.nodes, durationMs: nowMs() - t0 },
    warnings: w.list,
  };
}
