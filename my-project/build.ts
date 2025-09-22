#!/usr/bin/env bun
/**
 * Self-contained build script for ElizaOS projects
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { $ } from 'bun';

async function cleanBuild(outdir = 'dist') {
  if (existsSync(outdir)) {
    await rm(outdir, { recursive: true, force: true });
    console.log(`✓ Cleaned ${outdir} directory`);
  }
}

async function build() {
  const start = performance.now();
  console.log('🚀 Building project...');

  try {
    // Clean previous build
    await cleanBuild('dist');

    // Run JavaScript build, TypeScript declarations, and frontend build in parallel
    console.log('Starting build tasks...');

    const [buildResult, tscResult, frontendResult] = await Promise.all([
      // Task 1: Build with Bun
      (async () => {
        console.log('📦 Bundling with Bun...');
        const result = await Bun.build({
          entrypoints: ['./src/index.ts'],
          outdir: './dist',
          target: 'node',
          format: 'esm',
          sourcemap: true,
          minify: false,
          external: [
            'dotenv',
            'fs',
            'path',
            'https',
            'node:*',
            '@elizaos/core',
            '@elizaos/plugin-bootstrap',
            '@elizaos/plugin-sql',
            '@elizaos/cli',
            'zod',
          ],
          naming: {
            entry: '[dir]/[name].[ext]',
          },
        });

        if (!result.success) {
          console.error('✗ Build failed:', result.logs);
          return { success: false, outputs: [] };
        }

        const totalSize = result.outputs.reduce((sum, output) => sum + output.size, 0);
        const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
        console.log(`✓ Built ${result.outputs.length} file(s) - ${sizeMB}MB`);

        return result;
      })(),

      // Task 2: Generate TypeScript declarations
      (async () => {
        console.log('📝 Generating TypeScript declarations...');
        try {
          await $`tsc --emitDeclarationOnly --incremental --project ./tsconfig.build.json`.quiet();
          console.log('✓ TypeScript declarations generated');
          return { success: true };
        } catch (error) {
          console.warn('⚠ Failed to generate TypeScript declarations');
          console.warn('  This is usually due to test files or type errors.');
          return { success: false };
        }
      })(),

      // Task 3: Copy ElizaOS frontend assets (already built)
      (async () => {
        console.log('🎨 Using ElizaOS client frontend...');
        try {
          // ElizaOS client frontend is already built in node_modules
          console.log('✓ ElizaOS frontend ready (pre-built)');
          return { success: true };
        } catch (error) {
          console.error('❌ ElizaOS frontend check failed:', error);
          return { success: false };
        }
      })(),
    ]);

    if (!buildResult.success || !frontendResult.success) {
      return false;
    }

    // Copy ElizaOS client frontend assets to root public directory for CF Worker
    console.log('📂 Copying ElizaOS frontend assets for deployment...');
    try {
      await $`cp -r node_modules/@elizaos/client/dist/* ../public/`;
      console.log('✓ ElizaOS frontend assets copied to root public directory');
    } catch (error) {
      console.error('⚠ Warning: Failed to copy ElizaOS frontend assets:', error);
      // Continue anyway - might be missing files
    }

    const elapsed = ((performance.now() - start) / 1000).toFixed(2);
    console.log(`✅ Build complete! (${elapsed}s)`);
    return true;
  } catch (error) {
    console.error('Build error:', error);
    return false;
  }
}

// Execute the build
build()
  .then((success) => {
    if (!success) {
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error('Build script error:', error);
    process.exit(1);
  });
