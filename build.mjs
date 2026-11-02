// Bundles src/app.js (+ three.js) into dist/app.js as a classic script so index.html works from file://
import { build } from 'esbuild';

await build({
  entryPoints: ['src/app.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2021'],
  outfile: 'dist/app.js',
  legalComments: 'none',
  logLevel: 'info',
});
