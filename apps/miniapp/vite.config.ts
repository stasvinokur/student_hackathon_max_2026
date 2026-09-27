import react from '@vitejs/plugin-react';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizePath, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// Resolve @otkryvay/core from its TypeScript sources (export condition "source"),
// so dev, build and tests never depend on a stale core build.
const conditions = ['source', 'import', 'module', 'browser', 'default'];

/** The licence list of the build, next to index.html. */
const LICENSES_FILE = 'licenses.txt';

/** Code copied into the app, with the licence it came under: its notice must travel with the copy. */
const COPIED = [{ name: 'lucide-static', version: '1.48.0', identifier: 'ISC AND MIT', file: 'src/components/LICENSE-lucide.txt' }];

/**
 * The licence list of Vite (build.license) names the packages whose code is bundled. Two kinds of third-party files
 * escape it, and this plugin adds them to licenses.txt in its format: the files of a package that ship as assets (the
 * Lora font of @fontsource/lora, which organic.css takes by url()) and the code in COPIED (the Lucide icons).
 */
function assetAndCopiedLicenses(root: string): Plugin {
  return {
    name: 'otkryvay:asset-and-copied-licenses',
    apply: 'build',
    generateBundle: {
      order: 'post', // after vite:license, which writes the list
      handler(_options, bundle) {
        const list = bundle[LICENSES_FILE];
        // Without the list the font and the icons would ship with no licence: stop the build.
        if (list?.type !== 'asset') return this.error(`${LICENSES_FILE} is missing: is build.license on?`);
        let text = String(list.source).trimEnd();
        const add = (name: string, version: string, identifier: string | undefined, licence: string | undefined) => {
          if (text.includes(`\n## ${name} - ${version}`)) return;
          text += `\n\n## ${name} - ${version}${identifier ? ` (${identifier})` : ''}${licence ? `\n\n${licence.trim()}` : ''}`;
        };
        for (const file of Object.values(bundle)) {
          if (file.type !== 'asset') continue;
          for (const source of file.originalFileNames) {
            // The package the file ships from: the folder under its last node_modules/ (@scope/name or name).
            const path = normalizePath(resolve(root, source)); // "/" on Windows too
            const cut = path.lastIndexOf('/node_modules/');
            if (cut < 0) continue;
            const at = cut + '/node_modules/'.length;
            const [first = '', second = ''] = path.slice(at).split('/');
            const dir = path.slice(0, at) + (first.startsWith('@') ? `${first}/${second}` : first);
            const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string; license?: unknown };
            const licence = readdirSync(dir)
              .sort()
              .find((name) => /^(LICEN[CS]E|COPYING)(\.|$)/i.test(name));
            add(pkg.name, pkg.version, typeof pkg.license === 'string' ? pkg.license : undefined, licence && readFileSync(join(dir, licence), 'utf8'));
          }
        }
        for (const copied of COPIED) add(copied.name, copied.version, copied.identifier, readFileSync(resolve(root, copied.file), 'utf8'));
        list.source = `${text}\n`;
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), assetAndCopiedLicenses(import.meta.dirname)],
  resolve: { conditions },
  build: {
    // MapLibre (≈ 1 MB minified, 273 KB gzip) is a lazy chunk of its own, loaded only with the map canvas; any other
    // chunk this large would be a mistake worth the warning.
    chunkSizeWarningLimit: 1100,
    // Licence notices ship with the code (BSD-3-Clause of MapLibre requires it): every bundled package with its licence
    // text goes to licenses.txt next to index.html, served at /licenses.txt (with the font and the icons of
    // assetAndCopiedLicenses) …
    license: { fileName: LICENSES_FILE },
    // … and the @license banners stay in the chunks, which the minifier would drop by default. All three kinds are set:
    // this object replaces the one of Vite, and a kind left out would keep its comments (@__PURE__ and the like).
    rolldownOptions: { output: { comments: { legal: true, annotation: false, jsdoc: false } } },
  },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  server: {
    port: 5173,
    // Local development: the API runs separately (NODE_ENV=development enables X-Dev-User-Id).
    proxy: { '/api': process.env.VITE_API_PROXY ?? 'http://localhost:3002' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    server: { deps: { inline: ['@maxhub/max-ui'] } },
    css: false,
  },
});
