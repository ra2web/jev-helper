import {build} from 'esbuild';
import fs from 'node:fs/promises';
import {iconPng} from './binary.mjs';
await fs.rm('dist',{recursive:true,force:true});await fs.mkdir('dist/icons',{recursive:true});
await fs.cp('public','dist',{recursive:true});
await Promise.all([
  build({entryPoints:{background:'src/background.mjs',popup:'src/popup.mjs',help:'src/help.mjs',dashboard:'src/dashboard.mjs'},outdir:'dist',bundle:true,format:'esm',platform:'browser',target:'chrome120',logLevel:'info'}),
  build({entryPoints:{content:'src/content.mjs',page:'src/page.mjs'},outdir:'dist',bundle:true,format:'iife',platform:'browser',target:'chrome120',logLevel:'info'}),
  ...[16,32,48,128].map(size=>fs.writeFile(`dist/icons/${size}.png`,iconPng(size))),
]);
console.log('Load the standalone dist/ directory in Chrome or Edge. No server or game build required.');
