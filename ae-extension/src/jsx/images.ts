/**
 * Footage import with a per-project cache (one FootageItem per content hash, tagged via the
 * item comment so re-syncs reuse existing footage instead of re-importing).
 */
import { warn, type Warnings } from './util';

export var ASSET_TAG = 'f2ae:';

export interface FootageCache {
  byHash: { [hash: string]: any };
  folder: any;
  scanned: boolean;
}

export function newFootageCache(): FootageCache {
  return { byHash: {}, folder: null, scanned: false };
}

export function findOrCreateFolder(name: string, parent: any): any {
  var items = app.project.items;
  for (var i = 1; i <= items.length; i++) {
    var it = items[i];
    if (it instanceof FolderItem && it.name === name && (!parent || it.parentFolder === parent)) return it;
  }
  var f = items.addFolder(name);
  if (parent) f.parentFolder = parent;
  return f;
}

function scan(cache: FootageCache): void {
  if (cache.scanned) return;
  cache.scanned = true;
  var items = app.project.items;
  for (var i = 1; i <= items.length; i++) {
    var it = items[i];
    var c = it.comment;
    if (it instanceof FootageItem && c && c.substring(0, ASSET_TAG.length) === ASSET_TAG) {
      cache.byHash[c.substring(ASSET_TAG.length)] = it;
    }
  }
}

export function footageFor(cache: FootageCache, hash: string, paths: { [h: string]: string }, rootFolder: any, w: Warnings): any {
  scan(cache);
  var hit = cache.byHash[hash];
  if (hit) return hit;
  var path = paths[hash];
  if (!path) {
    warn(w, 'image ' + hash.substring(0, 8) + '… was not transferred; layer skipped');
    return null;
  }
  var file = new File(path);
  if (!file.exists) {
    warn(w, 'image file missing on disk: ' + path);
    return null;
  }
  try {
    var io = new ImportOptions(file);
    var item = app.project.importFile(io);
    item.comment = ASSET_TAG + hash;
    if (!cache.folder) cache.folder = findOrCreateFolder('Assets', rootFolder);
    item.parentFolder = cache.folder;
    cache.byHash[hash] = item;
    return item;
  } catch (e) {
    warn(w, 'image import failed: ' + String(e));
    return null;
  }
}
