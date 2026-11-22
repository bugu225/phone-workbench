import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = join(scriptDir, '..');
const distDir = join(appDir, 'dist');

if (relative(appDir, distDir) !== 'dist') {
  throw new Error('Refusing to build outside apps/desktop/dist.');
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const shared = {
  bundle: true,
  sourcemap: false,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'info',
};

await Promise.all([
  build({
    ...shared,
    entryPoints: [join(appDir, 'src', 'main.ts')],
    outfile: join(distDir, 'main.cjs'),
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...shared,
    entryPoints: [join(appDir, 'src', 'preload.ts')],
    outfile: join(distDir, 'preload.cjs'),
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...shared,
    entryPoints: [join(appDir, 'src', 'renderer.tsx')],
    outfile: join(distDir, 'renderer.js'),
    platform: 'browser',
    target: 'es2023',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
  }),
]);

await copyFile(join(appDir, 'index.html'), join(distDir, 'index.html'));
await copyFile(join(appDir, 'src', 'styles.css'), join(distDir, 'renderer.css'));
