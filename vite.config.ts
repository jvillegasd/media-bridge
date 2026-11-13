import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { renameSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { build as viteBuild } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production';

  return {
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          'background': resolve(__dirname, 'src/service-worker.ts'),
          'offscreen/offscreen': resolve(__dirname, 'src/offscreen/offscreen.html'),
          // Content script excluded - will be built separately as IIFE
          'popup/popup': resolve(__dirname, 'src/popup/popup.html'),
          'options/options': resolve(__dirname, 'src/options/options.html'),
          'capture-bridge/bridge': resolve(__dirname, 'src/capture-bridge/bridge.html'),
        },
        output: {
          // ES modules for service worker and other scripts
          format: 'es',
          entryFileNames: (chunkInfo) => {
            // Keep HTML files in their directories, JS files follow the same structure
            if (chunkInfo.name.includes('popup')) {
              return 'popup/popup.js';
            }
            if (chunkInfo.name.includes('options')) {
              return 'options/options.js';
            }
            if (chunkInfo.name.includes('background')) {
              return 'background.js';
            }
            if (chunkInfo.name.includes('offscreen')) {
              return 'offscreen/offscreen.js';
            }
            if (chunkInfo.name.includes('bridge')) {
              return 'capture-bridge/bridge.js';
            }
            return '[name].js';
          },
          chunkFileNames: '[name].js',
          assetFileNames: (assetInfo) => {
            // Keep HTML files in their directories
            if (assetInfo.name?.endsWith('.html')) {
              if (assetInfo.name.includes('popup')) {
                return 'popup/popup.html';
              }
              if (assetInfo.name.includes('options')) {
                return 'options/options.html';
              }
              if (assetInfo.name.includes('offscreen')) {
                return 'offscreen/offscreen.html';
              }
              if (assetInfo.name.includes('bridge')) {
                return 'capture-bridge/bridge.html';
              }
            }
            return '[name].[ext]';
          },
        },
      },
      sourcemap: !isProduction,
      minify: isProduction,
      target: 'es2020',
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
      extensions: ['.ts', '.tsx', '.js'],
    },
    plugins: [
      viteStaticCopy({
        targets: [
          {
            src: 'manifest.json',
            dest: '.',
          },
          {
            src: 'public/ffmpeg',
            dest: 'ffmpeg',
          },
        ],
      }),
      // Plugin to move HTML files to correct locations and fix script paths
      {
        name: 'move-html-files',
        closeBundle() {
          const htmlMoves = [
            { from: 'dist/src/popup/popup.html', to: 'dist/popup/popup.html' },
            { from: 'dist/src/options/options.html', to: 'dist/options/options.html' },
            { from: 'dist/src/offscreen/offscreen.html', to: 'dist/offscreen/offscreen.html' },
            { from: 'dist/src/capture-bridge/bridge.html', to: 'dist/capture-bridge/bridge.html' },
          ];
          
          htmlMoves.forEach(({ from, to }) => {
            if (existsSync(from)) {
              renameSync(from, to);
            }
          });
          
          // Fix script paths to be relative
          const htmlFiles = [
            'dist/popup/popup.html',
            'dist/options/options.html',
            'dist/offscreen/offscreen.html',
            'dist/capture-bridge/bridge.html',
          ];
          
          htmlFiles.forEach((file) => {
            if (existsSync(file)) {
              let content = readFileSync(file, 'utf-8');
              // Replace absolute paths with relative paths
              content = content.replace(/src="\/(popup|options|offscreen|capture-bridge)\/([^"]+)"/g, 'src="./$2"');
              writeFileSync(file, content, 'utf-8');
            }
          });
        },
      },
      // Plugin to build content script separately as IIFE (content scripts can't use ES modules)
      {
        name: 'build-content-script-as-iife',
        async writeBundle() {
          // Use writeBundle instead of closeBundle to avoid recursion
          // This runs after files are written but before closeBundle
          const buildingContentScript = (globalThis as any).__buildingContentScript;
          if (buildingContentScript) {
            return;
          }
          
          (globalThis as any).__buildingContentScript = true;
          
          try {
            // Build content scripts separately with IIFE format:
            // content.ts (isolated world) and mse-capture.ts (MAIN world hook)
            for (const [entry, outName] of [
              ['src/content.ts', 'content.js'],
              ['src/inject/mse-capture.ts', 'mse-capture.js'],
            ] as const) {
            await viteBuild({
              configFile: false, // Don't use the main config file
              build: {
                outDir: resolve(__dirname, 'dist'),
                emptyOutDir: false,
                rollupOptions: {
                  input: resolve(__dirname, entry),
                  output: {
                    format: 'iife',
                    entryFileNames: outName,
                    inlineDynamicImports: true, // Bundle everything into one file
                  },
                },
                minify: isProduction,
                sourcemap: !isProduction,
                target: 'es2020',
              },
              resolve: {
                alias: {
                  '@': resolve(__dirname, './src'),
                },
                extensions: ['.ts', '.tsx', '.js'],
              },
              optimizeDeps: {
                exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
              },
              plugins: [], // No plugins to avoid recursion
              logLevel: 'warn',
            });
            }
          } finally {
            (globalThis as any).__buildingContentScript = false;
          }
        },
      },
    ],
    // Exclude FFmpeg packages from optimization
    optimizeDeps: {
      exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
    },
    // Watch options
    server: {
      watch: {
        ignored: ['**/ffmpeg/**'],
      },
    },
  };
});

