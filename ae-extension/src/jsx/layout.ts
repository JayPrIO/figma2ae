/**
 * Layer/group transform placement — the core of anchor-point and parenting correctness.
 *
 * Convention: a layer (or shape group) draws its node in LAYER SPACE = node-local space
 * shifted by `offset` (text/footage layers have their own origin) and pre-sheared by K when
 * the node's matrix contains shear (AE layers can't express shear; shapes bake K into
 * vertices). Anchor = node centre in layer space, so rotation/scale pivot like Figma.
 *
 * For a node with matrix N (node-local → comp) under a parent whose layer space maps to the
 * comp via P, AE needs (all in parent layer space):
 *     rel      = P⁻¹ · N = T · R · S · K
 *     anchor   = K·c + offset          c = (w/2, h/2)
 *     position = rel · c
 *     scale    = (sx, sy) · 100,  rotation = θ
 * and the child's own layer space maps to the comp via  N · K⁻¹ · T(−offset).
 */
import { apply, decompose, invert, multiply, shearing, translation } from '@f2ae/shared/matrix';
import type { Mat2x3, Pt, Size } from '@f2ae/shared/schema';

export interface Placement {
  anchor: Pt;
  position: Pt;
  scale: Pt;
  rotation: number;
  /** shear factor that the caller must bake into geometry (0 = none) */
  shear: number;
  /** this layer's layer space → comp space (pass to children as their parent space) */
  toComp: Mat2x3;
}

export function place(nodeToComp: Mat2x3, parentToComp: Mat2x3, size: Size, offset: Pt | null): Placement {
  var rel = multiply(invert(parentToComp), nodeToComp);
  var d = decompose(rel);
  var c: Pt = [size.w / 2, size.h / 2];
  var ox = offset ? offset[0] : 0;
  var oy = offset ? offset[1] : 0;
  var anchor: Pt = [c[0] + d.shear * c[1] + ox, c[1] + oy];
  var position = apply(rel, c);
  var toComp = multiply(nodeToComp, multiply(invert(shearing(d.shear)), translation(-ox, -oy)));
  return {
    anchor: anchor,
    position: position,
    scale: [d.sx * 100, d.sy * 100],
    rotation: d.rotation,
    shear: d.shear,
    toComp: toComp,
  };
}

var T = 'ADBE Transform Group';

/** Applies a placement to an AE layer's transform group. */
export function applyLayerTransform(layer: any, p: Placement, opacity: number): void {
  var tg = layer.property(T);
  tg.property('ADBE Anchor Point').setValue([p.anchor[0], p.anchor[1]]);
  tg.property('ADBE Position').setValue([p.position[0], p.position[1]]);
  tg.property('ADBE Scale').setValue([p.scale[0], p.scale[1]]);
  tg.property('ADBE Rotate Z').setValue(p.rotation);
  tg.property('ADBE Opacity').setValue(Math.max(0, Math.min(100, opacity * 100)));
}

/** Applies a placement to a shape group's "ADBE Vector Transform Group". */
export function applyGroupTransform(group: any, p: Placement, opacity: number): void {
  var tg = group.property('ADBE Vector Transform Group');
  tg.property('ADBE Vector Anchor').setValue([p.anchor[0], p.anchor[1]]);
  tg.property('ADBE Vector Position').setValue([p.position[0], p.position[1]]);
  tg.property('ADBE Vector Scale').setValue([p.scale[0], p.scale[1]]);
  tg.property('ADBE Vector Rotation').setValue(p.rotation);
  tg.property('ADBE Vector Group Opacity').setValue(Math.max(0, Math.min(100, opacity * 100)));
}
