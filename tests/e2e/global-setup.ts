import { join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { FIXTURE_BUILD, startServer } from './harness';

/** Builds the React fixture and serves the fixture site for the whole run. */
export default async function setup(): Promise<() => Promise<void>> {
  // Vitest sets this to "test", which makes the React plugin emit its development runtime.
  const environment = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'production';
  await build({
    configFile: false,
    mode: 'production',
    logLevel: 'warn',
    publicDir: false,
    plugins: [react()],
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: FIXTURE_BUILD,
      emptyOutDir: true,
      minify: false,
      lib: {
        entry: join(resolve(import.meta.dirname), 'fixtures/react-app.tsx'),
        formats: ['iife'],
        name: 'reactFixture',
        fileName: () => 'react-app.js',
      },
    },
  });
  process.env['NODE_ENV'] = environment;
  const server = await startServer();
  return () => new Promise((done) => server.close(() => done()));
}
