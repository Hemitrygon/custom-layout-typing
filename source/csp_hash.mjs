// Updates the script-src of the Content-Security-Policy in typing_practice_vX.Y.Z.html.
//   node csp_hash.mjs [file.html]      (default: the newest typing_practice_vX.Y.Z.html here)
// The page allows no inline script except its own <script> blocks (by SHA-256 hash) and the
// kuromoji.js program it injects after checking that file's SHA-256. Run this after every edit of
// a <script> block, or the browser refuses to run the changed script.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Files are named by semantic version: typing_practice_v4.1.0.html and its distribution build
// typing_practice_dist_v4.1.0.html.
const VERSIONED_SOURCE = /^typing_practice_v(\d+)\.(\d+)\.(\d+)\.html$/;

// The newest source file in a folder, or null when there is none.
export function latestSourceFile(dir = '.') {
  const found = readdirSync(dir).map(name => ({ name, m: name.match(VERSIONED_SOURCE) })).filter(f => f.m);
  found.sort((a, b) => {
    for (let i = 1; i <= 3; i++) {
      const d = Number(b.m[i]) - Number(a.m[i]);
      if (d) return d;
    }
    return 0;
  });
  return found.length ? found[0].name : null;
}

// typing_practice_v4.1.0.html -> typing_practice_dist_v4.1.0.html
export function distFileFor(source) {
  return VERSIONED_SOURCE.test(source) ? source.replace(/^typing_practice_v/, 'typing_practice_dist_v') : 'typing_practice_dist.html';
}

// SHA-256 of kuromoji 0.1.2 build/kuromoji.js (the same value as KUROMOJI_SHA256 in the page).
// The page injects that file's text as an inline script, so the policy must allow its hash.
export const KUROMOJI_JS_SHA256_HEX = 'ab0ac10f1c4a9b5e246e63e57b04ba14d3a6148cd7e8d62cb97a960d4f85a3e6';

export function inlineScriptHashes(html) {
  const out = [];
  // HTML comments are skipped, so a comment that mentions a script tag is not taken for one
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(markup))) {
    // the browser turns CRLF / CR line breaks into LF before it hashes, so the same is done here
    // (a file saved with Windows line breaks still gets the right value)
    const text = m[1].replace(/\r\n?/g, '\n');
    out.push("'sha256-" + createHash('sha256').update(text, 'utf8').digest('base64') + "'");
  }
  return out;
}

export function applyCsp(html) {
  const hashes = inlineScriptHashes(html);
  const kuromoji = "'sha256-" + Buffer.from(KUROMOJI_JS_SHA256_HEX, 'hex').toString('base64') + "'";
  const scriptSrc = 'script-src ' + hashes.concat(kuromoji).join(' ');
  const re = /(<meta http-equiv="Content-Security-Policy" content="[^"]*?)script-src [^;"]*/;
  if (!re.test(html)) throw new Error('Content-Security-Policy meta tag not found');
  return { html: html.replace(re, '$1' + scriptSrc), count: hashes.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] || latestSourceFile() || 'typing_practice.html';
  const { html, count } = applyCsp(readFileSync(file, 'utf8'));
  writeFileSync(file, html);
  console.log(file + ': script-src updated (' + count + ' inline scripts + kuromoji.js)');
}
