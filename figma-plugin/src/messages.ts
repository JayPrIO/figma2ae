/** postMessage contract between the plugin main thread and the UI iframe. */
import type { BuildOptions, F2AEDocument } from '@f2ae/shared/schema';
import type { ExtractedAsset } from './main/extract';

export interface SelectionInfo {
  count: number;
  names: string[];
  /** roots that would become comps */
  frames: number;
}

export type MainToUi =
  | { type: 'init'; options: BuildOptions; selection: SelectionInfo; fileName: string }
  | { type: 'selection'; selection: SelectionInfo }
  | { type: 'extract:progress'; nodes: number }
  | { type: 'extract:done'; requestId: number; document: F2AEDocument; assets: ExtractedAsset[]; ms: number }
  | { type: 'extract:error'; requestId: number; message: string }
  | { type: 'export:done'; requestId: number; files: ExportedFile[] }
  | { type: 'export:error'; requestId: number; message: string };

export type ExportFormat = 'PNG' | 'SVG' | 'PDF';

export interface ExportedFile {
  name: string;
  bytes: Uint8Array;
}

export type UiToMain =
  | { type: 'ready' }
  | { type: 'extract'; requestId: number; options: BuildOptions }
  | { type: 'export'; requestId: number; format: ExportFormat; scale: number }
  | { type: 'options:save'; options: BuildOptions }
  | { type: 'notify'; message: string; error?: boolean }
  | { type: 'resize'; height: number };
