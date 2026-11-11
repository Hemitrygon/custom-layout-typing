// Vite の設定。
//   - 開発サーバーが、web/ の外にある WASM（../core/pkg/）を配れるようにする
//   - 配るファイルは相対パスで読む（GitHub Pages のどのフォルダに置いても動く）
//   - 版番号（package.json の version）を、画面のコードに __APP_VERSION__ として渡す
//   - ビルドしたページにだけ、読み込み先とプログラムの制限（Content-Security-Policy）を入れる
//     （開発サーバーは Vite が差し込むスクリプトを使うので、制限を入れると動かない）
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const WEB = dirname(fileURLToPath(import.meta.url));
// 版番号は package.json の version だけで管理する（画面には __APP_VERSION__ として渡す）
const VERSION = JSON.parse(readFileSync(resolve(WEB, 'package.json'), 'utf8')).version;

// 通信は旧版（v5）と同じ 2 つだけ：Google Fonts と、漢字のよみの辞書（kuromoji。jsDelivr → unpkg）。
// 'wasm-unsafe-eval' は WASM（Rust の中身と Draco の展開器）を動かすのに要る。blob: は Draco の展開器（Worker）と、
// SHA-256 を確かめたあとの kuromoji のプログラム。
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "connect-src 'self' blob: https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(VERSION) },
  server: { fs: { allow: [resolve(WEB, '..')] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  plugins: [{
    name: 'csp-on-build',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="' + CSP + '">');
    },
  }],
});
