#!/usr/bin/env bun
/**
 * Post-build pass: rewrite `.ts` import specifiers in emitted `.d.ts` files to
 * `.js` so consumers of the published package can resolve them.
 *
 * The source uses explicit `.ts` extensions (Bun-idiomatic) and tsc emits the
 * same paths verbatim into `.d.ts`. That's correct for source consumers but
 * broken for npm consumers who only see `dist/*.js` + `dist/*.d.ts`.
 *
 * Targets:
 *   from './foo.ts'    →   from './foo.js'
 *   from "./foo.ts"    →   from "./foo.js"
 *   import('./foo.ts') →   import('./foo.js')
 */
import { Glob } from 'bun';
import { resolve } from 'node:path';

const DIST = resolve(import.meta.dir, '..', 'dist');
const glob = new Glob('**/*.d.ts');

let fileCount = 0;
let totalRewrites = 0;

for await (const rel of glob.scan({ cwd: DIST })) {
  const path = resolve(DIST, rel);
  const original = await Bun.file(path).text();
  const rewritten = original.replace(
    /(\bfrom\s+|\bimport\(\s*)(['"])(\.\.?\/[^'"]+?)\.ts(\2)/g,
    (_match, prefix: string, quote: string, spec: string, closeQuote: string) =>
      `${prefix}${quote}${spec}.js${closeQuote}`,
  );
  if (rewritten !== original) {
    await Bun.write(path, rewritten);
    const diffCount = original.split('.ts').length - rewritten.split('.ts').length;
    totalRewrites += diffCount;
    fileCount += 1;
  }
}

console.error(`fix-dts-extensions: rewrote ${totalRewrites} import paths across ${fileCount} files`);
