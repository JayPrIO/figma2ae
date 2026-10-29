/// <reference types="@figma/plugin-typings" />
/**
 * Figma plugin main-thread entry. Owns document access; the UI iframe owns networking.
 */
import { DEFAULT_BUILD_OPTIONS, type BuildOptions } from '@f2ae/shared/schema';
import type { MainToUi, SelectionInfo, UiToMain } from '../messages';
import { exportNodes } from './export-files';
import { extractSelection } from './extract';

const OPTIONS_KEY = 'f2ae.options.v1';
const UI_WIDTH = 320;

figma.showUI(__html__, { width: UI_WIDTH, height: 460, themeColors: true, title: 'Figma2AE' });

function post(msg: MainToUi): void {
  figma.ui.postMessage(msg);
}

function selectionInfo(): SelectionInfo {
  const sel = figma.currentPage.selection;
  return {
    count: sel.length,
    names: sel.slice(0, 3).map((n) => n.name),
    frames: sel.filter((n) => n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE').length,
  };
}

async function loadOptions(): Promise<BuildOptions> {
  try {
    const saved = (await figma.clientStorage.getAsync(OPTIONS_KEY)) as Partial<BuildOptions> | undefined;
    return { ...DEFAULT_BUILD_OPTIONS, ...(saved ?? {}) };
  } catch {
    return { ...DEFAULT_BUILD_OPTIONS };
  }
}

let extracting = false;

figma.ui.onmessage = async (msg: UiToMain) => {
  switch (msg.type) {
    case 'ready':
      post({ type: 'init', options: await loadOptions(), selection: selectionInfo(), fileName: figma.root.name });
      return;
    case 'options:save':
      await figma.clientStorage.setAsync(OPTIONS_KEY, msg.options).catch(() => undefined);
      return;
    case 'notify':
      figma.notify(msg.message, { error: msg.error === true, timeout: msg.error ? 6000 : 3000 });
      return;
    case 'resize':
      figma.ui.resize(UI_WIDTH, Math.max(240, Math.min(900, Math.round(msg.height))));
      return;
    case 'export': {
      const selection = figma.currentPage.selection;
      if (selection.length === 0) {
        post({ type: 'export:error', requestId: msg.requestId, message: 'Select at least one layer' });
        return;
      }
      try {
        const files = await exportNodes(selection as unknown as Parameters<typeof exportNodes>[0], msg.format, msg.scale);
        post({ type: 'export:done', requestId: msg.requestId, files });
      } catch (e) {
        post({ type: 'export:error', requestId: msg.requestId, message: (e as Error).message || String(e) });
      }
      return;
    }
    case 'extract': {
      if (extracting) {
        post({ type: 'extract:error', requestId: msg.requestId, message: 'An export is already running' });
        return;
      }
      const selection = figma.currentPage.selection;
      if (selection.length === 0) {
        post({ type: 'extract:error', requestId: msg.requestId, message: 'Select at least one layer' });
        return;
      }
      extracting = true;
      const t0 = Date.now();
      try {
        const { document, assets } = await extractSelection(
          selection,
          msg.options,
          { mixed: figma.mixed, getImageByHash: (h) => figma.getImageByHash(h) },
          { fileName: figma.root.name, pageName: figma.currentPage.name },
          (nodes) => post({ type: 'extract:progress', nodes }),
        );
        post({ type: 'extract:done', requestId: msg.requestId, document, assets, ms: Date.now() - t0 });
      } catch (e) {
        post({ type: 'extract:error', requestId: msg.requestId, message: (e as Error).message || String(e) });
      } finally {
        extracting = false;
      }
      return;
    }
  }
};

figma.on('selectionchange', () => post({ type: 'selection', selection: selectionInfo() }));
