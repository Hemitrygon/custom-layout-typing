// Builds the page people open from typing_practice_vX.Y.Z.html in this folder.
//   node build.mjs [source.html] [output.html]
// Defaults: the newest typing_practice_vX.Y.Z.html here -> ../index.html when this folder is the
// repository's source/, otherwise typing_practice_dist_vX.Y.Z.html next to the source.
//
// The code stays as readable as the source. What the build does:
//   1. The developer tools (marked DEV-ONLY in the source) are removed; the build fails if any of
//      them is left.
//   2. The background scene files (scene/...) are packed into the page as base64 (#sceneFiles), so
//      index.html is one file that works without the scene folder.
//   3. The Content-Security-Policy gets the hashes of the page's scripts (no 'unsafe-inline').
// Only Node.js is needed (no npm packages).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCsp, latestSourceFile, distFileFor } from './csp_hash.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const src = args[0] || (latestSourceFile(here) && join(here, latestSourceFile(here)));
if (!src) throw new Error('no typing_practice_vX.Y.Z.html found in ' + here);
const out = args[1] || (basename(here) === 'source'
  ? join(here, '..', 'index.html')
  : join(dirname(src), distFileFor(basename(src))));

// ---------- 1. developer-only parts ----------
// The source marks them /* DEV-ONLY:BEGIN */ ... /* DEV-ONLY:END */ (script, CSS) and
// <!-- DEV-ONLY:BEGIN --> ... <!-- DEV-ONLY:END --> (markup).
const DEV_BLOCK_RE = /\/\* DEV-ONLY:BEGIN[\s\S]*?DEV-ONLY:END \*\/|<!-- DEV-ONLY:BEGIN[\s\S]*?DEV-ONLY:END -->/g;
const DEV_NAMES_RE = /DEV-ONLY|devLog|DevTools|devToolsModal|devErrorBadge|ctp_devlog|開発者ツール|開発者ログ/;
let blocks = 0;
let html = readFileSync(src, 'utf8').replace(DEV_BLOCK_RE, () => { blocks++; return ''; });
const left = html.match(DEV_NAMES_RE);
if (left) throw new Error('developer-only code is left after removing ' + blocks + ' DEV-ONLY blocks: "' + left[0] + '" (check the DEV-ONLY markers)');

// ---------- 2. the scene files go inside the page ----------
// The page's background script reads #sceneFiles when it is there, so the links to scene/ are taken
// out (no failed loads when the folder is missing). #sceneFiles comes first in <body>, before the scripts.
const sceneNames = [...new Set([...html.matchAll(/(?:scene\/|sceneUrl\(')([\w.-]+\.(?:mp4|webp|jpg))/g)].map(m => m[1]))];
const missing = sceneNames.filter(n => !existsSync(join(dirname(src), 'scene', n)));
if (missing.length) throw new Error('scene files missing (needed to pack them into the page): ' + missing.join(', '));
const sceneFiles = '<div id="sceneFiles" hidden>' + sceneNames.map(n =>
  '<i data-name="' + n + '">' + readFileSync(join(dirname(src), 'scene', n)).toString('base64') + '</i>').join('') + '</div>';
html = html
  .replace(/ src="scene\/[\w.-]+"/g, '')
  .replace(/url\('scene\/[\w.-]+'\)/g, 'none')
  .replace(/<body[^>]*>/, m => m + '\n' + sceneFiles);

// ---------- 3. Content-Security-Policy ----------
const page = applyCsp(html);
if (page.count !== 2) throw new Error('expected 2 inline scripts, found ' + page.count);
writeFileSync(out, page.html);

console.log(out + '  ' + Math.round(page.html.length / 1024) + 'KB  developer-only blocks removed: ' + blocks +
  '  scene files packed: ' + sceneNames.length);
