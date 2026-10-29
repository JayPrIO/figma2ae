/** Selection → PNG / SVG / PDF files via Figma's native exporter (bounded concurrency). */
import type { ExportedFile, ExportFormat } from '../messages';
import { mapLimit } from './extract';

interface Exportable {
  name: string;
  exportAsync(settings: Record<string, unknown>): Promise<Uint8Array>;
}

export function exportSettings(format: ExportFormat, scale: number): Record<string, unknown> {
  if (format === 'PNG') return { format: 'PNG', constraint: { type: 'SCALE', value: Math.max(0.5, Math.min(4, scale)) } };
  if (format === 'SVG') return { format: 'SVG', svgIdAttribute: true, svgOutlineText: true, svgSimplifyStroke: true };
  return { format: 'PDF' };
}

export async function exportNodes(nodes: readonly Exportable[], format: ExportFormat, scale: number): Promise<ExportedFile[]> {
  const settings = exportSettings(format, scale);
  return mapLimit(nodes, 4, async (n) => ({ name: n.name, bytes: await n.exportAsync(settings) }));
}
