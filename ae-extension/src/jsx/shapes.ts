/**
 * Shape-layer content builders: geometry (parametric + bezier), solid fills, strokes,
 * and the white→black gradient ramp used by the Tritone gradient technique.
 * Contents render top-first in AE, so callers append paths, then strokes (top-most first),
 * then fills (top-most first).
 */
import { geometryToPath } from '@f2ae/shared/geometry';
import { shearing, transformPath } from '@f2ae/shared/matrix';
import type { BezierPath, Geometry, GradientPaint, PathGeometry, RGBA, SolidPaint, Stroke } from '@f2ae/shared/schema';

export var ROOT_VECTORS = 'ADBE Root Vectors Group';
var GROUP = 'ADBE Vector Group';
var CONTENTS = 'ADBE Vectors Group';

export function contentsOf(layerOrGroup: any, isLayer: boolean): any {
  return isLayer ? layerOrGroup.property(ROOT_VECTORS) : layerOrGroup.property(CONTENTS);
}

export function addGroup(contents: any, name: string): any {
  var g = contents.addProperty(GROUP);
  g.name = name;
  return g;
}

export function toAEShape(p: BezierPath): any {
  var s = new Shape();
  s.vertices = p.v;
  s.inTangents = p.i;
  s.outTangents = p.o;
  s.closed = p.c;
  return s;
}

/** Applies residual shear by converting to a path and transforming vertices (exact). */
export function shearGeometry(g: Geometry, k: number): Geometry {
  if (k === 0) return g;
  var pg = geometryToPath(g);
  var K = shearing(k);
  var out: BezierPath[] = [];
  for (var i = 0; i < pg.paths.length; i++) out.push(transformPath(pg.paths[i], K));
  return { type: 'path', paths: out, rule: pg.rule };
}

/** Adds path items for a geometry; inset > 0 shrinks parametric shapes (inside strokes). */
export function addGeometry(contents: any, g: Geometry, inset: number): void {
  if (g.type === 'rect') {
    var w = Math.max(0, g.w - 2 * inset);
    var h = Math.max(0, g.h - 2 * inset);
    var r = contents.addProperty('ADBE Vector Shape - Rect');
    r.property('ADBE Vector Rect Size').setValue([w, h]);
    r.property('ADBE Vector Rect Position').setValue([g.w / 2, g.h / 2]);
    r.property('ADBE Vector Rect Roundness').setValue(Math.max(0, Math.min(g.radius - inset, w / 2, h / 2)));
    return;
  }
  if (g.type === 'ellipse') {
    var e = contents.addProperty('ADBE Vector Shape - Ellipse');
    e.property('ADBE Vector Ellipse Size').setValue([Math.max(0, g.w - 2 * inset), Math.max(0, g.h - 2 * inset)]);
    e.property('ADBE Vector Ellipse Position').setValue([g.w / 2, g.h / 2]);
    return;
  }
  addPaths(contents, g);
}

export function addPaths(contents: any, g: PathGeometry): void {
  for (var i = 0; i < g.paths.length; i++) {
    var item = contents.addProperty('ADBE Vector Shape - Group');
    item.property('ADBE Vector Shape').setValue(toAEShape(g.paths[i]));
  }
}

function rgb(c: RGBA): number[] {
  return [c[0], c[1], c[2]];
}

export function addSolidFill(contents: any, p: SolidPaint, rule: string, opacityMul: number): any {
  var f = contents.addProperty('ADBE Vector Graphic - Fill');
  f.property('ADBE Vector Fill Color').setValue(rgb(p.color));
  f.property('ADBE Vector Fill Opacity').setValue(Math.max(0, Math.min(100, p.opacity * p.color[3] * opacityMul * 100)));
  f.property('ADBE Vector Fill Rule').setValue(rule === 'evenodd' ? 2 : 1);
  return f;
}

var CAP: { [k: string]: number } = { butt: 1, round: 2, square: 3 };
var JOIN: { [k: string]: number } = { miter: 1, round: 2, bevel: 3 };

export function addSolidStroke(contents: any, s: Stroke, p: SolidPaint, weight: number): any {
  var st = contents.addProperty('ADBE Vector Graphic - Stroke');
  st.property('ADBE Vector Stroke Color').setValue(rgb(p.color));
  st.property('ADBE Vector Stroke Opacity').setValue(Math.max(0, Math.min(100, p.opacity * p.color[3] * 100)));
  st.property('ADBE Vector Stroke Width').setValue(weight);
  st.property('ADBE Vector Stroke Line Cap').setValue(CAP[s.cap] || 1);
  st.property('ADBE Vector Stroke Line Join').setValue(JOIN[s.join] || 1);
  st.property('ADBE Vector Stroke Miter Limit').setValue(Math.max(1, s.miterLimit));
  if (s.dash.length > 0) addDashes(st, s.dash);
  return st;
}

function addDashes(stroke: any, dash: number[]): void {
  var d = stroke.property('ADBE Vector Stroke Dashes');
  if (!d) return;
  // AE supports up to 3 dash/gap pairs; odd-length patterns repeat (SVG semantics).
  var pattern = dash.length % 2 === 1 ? dash.concat(dash) : dash;
  var n = Math.min(pattern.length, 6);
  for (var i = 0; i < n; i++) {
    var isGap = i % 2 === 1;
    var idx = Math.floor(i / 2) + 1;
    var item = d.addProperty(isGap ? 'ADBE Vector Stroke Gap ' + idx : 'ADBE Vector Stroke Dash ' + idx);
    item.setValue(pattern[i]);
  }
}

/** White→black gradient fill positioned at the paint's handles (recoloured by Tritone). */
export function addRampFill(contents: any, g: GradientPaint, rule: string): any {
  var f = contents.addProperty('ADBE Vector Graphic - G-Fill');
  f.property('ADBE Vector Grad Type').setValue(g.type === 'radial' ? 2 : 1);
  f.property('ADBE Vector Grad Start Pt').setValue([g.start[0], g.start[1]]);
  f.property('ADBE Vector Grad End Pt').setValue([g.end[0], g.end[1]]);
  f.property('ADBE Vector Fill Rule').setValue(rule === 'evenodd' ? 2 : 1);
  return f;
}

/** Linear interpolation of gradient stops at t ∈ [0,1]. */
export function sampleGradient(g: GradientPaint, t: number): RGBA {
  var s = g.stops;
  if (s.length === 0) return [0, 0, 0, 1];
  if (t <= s[0].pos) return s[0].color;
  for (var i = 1; i < s.length; i++) {
    if (t <= s[i].pos) {
      var a = s[i - 1];
      var b = s[i];
      var span = b.pos - a.pos;
      var u = span > 0 ? (t - a.pos) / span : 0;
      return [
        a.color[0] + (b.color[0] - a.color[0]) * u,
        a.color[1] + (b.color[1] - a.color[1]) * u,
        a.color[2] + (b.color[2] - a.color[2]) * u,
        a.color[3] + (b.color[3] - a.color[3]) * u,
      ];
    }
  }
  return s[s.length - 1].color;
}
