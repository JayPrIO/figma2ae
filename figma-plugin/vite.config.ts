import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve } from 'node:path';

// Figma loads the UI as a single HTML string (`__html__`), so everything is inlined.
export default defineConfig({
  root: 'src/ui',
  plugins: [preact(), viteSingleFile()],
  build: {
    outDir: '../../dist',
    emptyOutDir: false,
    target: 'es2020',
    minify: true,
    reportCompressedSize: false,
    rollupOptions: { input: resolve(__dirname, 'src/ui/ui.html') },
  },
  logLevel: 'warn',
});
