import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

const shared = {
  configFile: false,
  logLevel: 'warn',
  publicDir: false,
  resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
};

/** Background and content scripts have to be single classic scripts, with no imports. */
function scriptBuild(name, entry) {
  return {
    ...shared,
    build: {
      outDir: resolve(dist, name),
      emptyOutDir: true,
      minify: false,
      sourcemap: watch ? 'inline' : false,
      target: 'firefox128',
      watch: watch ? {} : null,
      lib: {
        entry: resolve(root, entry),
        formats: ['iife'],
        name: `dejavu_${name}`,
        fileName: () => 'index.js',
      },
    },
  };
}

const sidebar = {
  ...shared,
  root: resolve(root, 'src/sidebar-ui'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(dist, 'sidebar'),
    emptyOutDir: true,
    target: 'firefox128',
    // Extension pages can't load inline data URLs for scripts, and nothing here is large.
    assetsInlineLimit: 0,
    modulePreload: false,
    watch: watch ? {} : null,
  },
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, 'public'), dist, { recursive: true });
await Promise.all([
  build(scriptBuild('background', 'src/background/index.ts')),
  build(scriptBuild('content', 'src/content-scripts/index.ts')),
  build(sidebar),
]);
if (!watch) console.log(`Built to ${dist}`);
