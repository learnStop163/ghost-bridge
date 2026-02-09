import * as esbuild from 'esbuild';
import fs from 'fs-extra';

// Clean dist directory
fs.removeSync('dist');
fs.ensureDirSync('dist');

const commonConfig = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  // Keep external only for native modules
  external: [
      'bufferutil', 
      'utf-8-validate' 
  ],
  // This tells esbuild to handle require() calls properly for ESM output
  mainFields: ['module', 'main'],
};

async function build() {
    console.log('📦 Bundling CLI...');
    await esbuild.build({
        ...commonConfig,
        entryPoints: ['bin/ghost-bridge.js'],
        outfile: 'dist/cli.js',
        banner: {
            js: '#!/usr/bin/env node\nimport { createRequire } from "module"; const require = createRequire(import.meta.url);',
        },
    });

    console.log('📦 Bundling Server...');
    await esbuild.build({
        ...commonConfig,
        entryPoints: ['src/server.js'],
        outfile: 'dist/server.js',
        banner: {
            js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);',
        },
    });

    console.log('✅ Build complete!');
}

build().catch(() => process.exit(1));
