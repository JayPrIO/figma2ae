/** Layer effects: drop shadow, blur, inner shadow (layer style), Tritone recolouring. */
import type { Effect, RGBA, ShadowEffect } from '@f2ae/shared/schema';
import { warn, type Warnings } from './util';

var PARADE = 'ADBE Effect Parade';

function effects(layer: any): any {
  return layer.property(PARADE);
}

export function addDropShadow(layer: any, e: ShadowEffect, w: Warnings, name: string): void {
  var fx = effects(layer).addProperty('ADBE Drop Shadow');
  var dx = e.offset[0];
  var dy = e.offset[1];
  fx.property('ADBE Drop Shadow-0001').setValue([e.color[0], e.color[1], e.color[2]]);
  fx.property('ADBE Drop Shadow-0002').setValue(e.color[3] * 255);
  // AE direction: 0° = up, clockwise
  fx.property('ADBE Drop Shadow-0003').setValue((Math.atan2(dx, -dy) * 180) / Math.PI);
  fx.property('ADBE Drop Shadow-0004').setValue(Math.sqrt(dx * dx + dy * dy));
  fx.property('ADBE Drop Shadow-0005').setValue(e.radius);
  if (e.spread !== 0) warn(w, '"' + name + '": shadow spread is not supported by AE Drop Shadow');
}

export function addBlur(layer: any, radius: number): void {
  var fx = effects(layer).addProperty('ADBE Gaussian Blur 2');
  fx.property('ADBE Gaussian Blur 2-0001').setValue(radius);
  var rep = fx.property('ADBE Gaussian Blur 2-0003');
  if (rep) rep.setValue(0);
}

function selectOnly(layer: any): void {
  var comp = layer.containingComp;
  var sel = comp.selectedLayers;
  for (var i = 0; i < sel.length; i++) sel[i].selected = false;
  layer.selected = true;
}

export function addInnerShadow(layer: any, e: ShadowEffect, w: Warnings, name: string): void {
  try {
    selectOnly(layer);
    app.executeCommand(app.findMenuCommandId('Inner Shadow'));
    var st = layer.property('ADBE Layer Styles').property('innerShadow/enabled');
    var dx = e.offset[0];
    var dy = e.offset[1];
    st.property('innerShadow/color').setValue([e.color[0], e.color[1], e.color[2]]);
    st.property('innerShadow/opacity').setValue(e.color[3] * 100);
    // layer-style angle: light direction (shadow falls opposite), 0° = right, counter-clockwise
    st.property('innerShadow/useGlobalAngle').setValue(0);
    st.property('innerShadow/localLightingAngle').setValue((Math.atan2(dy, -dx) * 180) / Math.PI);
    st.property('innerShadow/distance').setValue(Math.sqrt(dx * dx + dy * dy));
    st.property('innerShadow/blur').setValue(e.radius);
    layer.selected = false;
  } catch (err) {
    warn(w, '"' + name + '": inner shadow could not be added (' + String(err) + ')');
  }
}

/** Recolours a luminance ramp: white → hi, 50 % grey → mid, black → lo. */
export function addTritone(layer: any, hi: RGBA, mid: RGBA, lo: RGBA): void {
  var fx = effects(layer).addProperty('ADBE Tritone');
  fx.property('ADBE Tritone-0001').setValue([hi[0], hi[1], hi[2]]);
  fx.property('ADBE Tritone-0002').setValue([mid[0], mid[1], mid[2]]);
  fx.property('ADBE Tritone-0003').setValue([lo[0], lo[1], lo[2]]);
}

/**
 * Applies node effects. Drop shadows go on `first` only (bottom-most layer of a split node);
 * blurs go on every layer the node produced.
 */
export function applyEffects(layers: any[], list: Effect[], w: Warnings, name: string): void {
  if (!list || list.length === 0 || layers.length === 0) return;
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (e.type === 'dropShadow') addDropShadow(layers[0], e, w, name);
    else if (e.type === 'innerShadow') addInnerShadow(layers[layers.length - 1], e, w, name);
    else if (e.type === 'layerBlur') {
      for (var j = 0; j < layers.length; j++) addBlur(layers[j], e.radius);
    } else if (e.type === 'backgroundBlur') warn(w, '"' + name + '": background blur has no After Effects equivalent');
  }
}
