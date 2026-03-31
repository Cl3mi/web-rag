/**
 * Vite config for building the standalone chat-widget IIFE bundle.
 *
 * Usage:
 *   bun run build:widget
 *
 * Output: static/widget/chat-widget.iife.js
 * Embed on any site:
 *   <script src="https://your-server.com/widget/chat-widget.iife.js"></script>
 *   <chat-widget api-url="https://your-server.com"></chat-widget>
 */

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    svelte({
      compilerOptions: {
        customElement: true,
      },
    }),
  ],
  build: {
    lib: {
      entry: resolve('./src/widget/index.ts'),
      name: 'ChatWidget',
      fileName: () => 'chat-widget.iife.js',
      formats: ['iife'],
    },
    outDir: 'static/widget',
    emptyOutDir: false,
    rollupOptions: {
      // Bundle everything — no external dependencies
      external: [],
    },
  },
  resolve: {
    alias: {
      $lib: resolve('./src/lib'),
    },
  },
});
