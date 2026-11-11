// 開発用：画面をヘッドレスの Chromium で開いて、操作しながらスクリーンショットを撮る（見た目の確認用）。
//     node scripts/shot.mjs [--size 1440x900] [--url '?a=b'] [--storage file.json] [--first 1] 手順...   （web/ の中で）
// 初めて開いたときの案内（チュートリアル）は出さない。出すときは --first 1。
// 手順は書いた順に実行する：
//     --eval 'JS'      ページの中で実行（window.__app が使える）
//     --wait ミリ秒
//     --key  キー      キーを 1 回押す（Playwright の名前。例 Space、Escape、KeyA）
//     --type 文字列    1 文字ずつ押す（KeyboardEvent.code を QWERTY の位置で出す）
//     --click セレクタ
//     --shot 保存先.png
// Vite の開発サーバーを立てるので、ビルドは要らない（先に core/ で wasm-pack build が要る）。
import { createServer } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(resolve(WEB, '../node_modules/playwright/index.mjs'));
// Playwright が入れたものとは別の Chromium を使うときは、環境変数 CHROMIUM_PATH にその場所を入れる
const CHROME = process.env.CHROMIUM_PATH || '';

const args = process.argv.slice(2);
let size = [1440, 900], urlTail = '', storage = null, first = false;
const steps = [];
for (let i = 0; i < args.length; i += 2) {
  const k = args[i], v = args[i + 1];
  if (k === '--size') size = v.split('x').map(Number);
  else if (k === '--url') urlTail = v;
  else if (k === '--storage') storage = JSON.parse(readFileSync(v, 'utf8'));
  else if (k === '--first') first = v === '1';
  else steps.push([k.replace(/^--/, ''), v]);
}

const server = await createServer({ root: WEB, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  ...(CHROME && existsSync(CHROME) ? { executablePath: CHROME } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
  page.on('pageerror', (e) => { failed = true; console.log('PAGE ERROR', String(e)); });
  page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text()); else if (m.text().startsWith('[shot]')) console.log(m.text()); });
  if (!first) await page.addInitScript(() => { if (!localStorage.getItem('custom_typing_tutorial_done_v1')) localStorage.setItem('custom_typing_tutorial_done_v1', '1'); });
  if (storage) await page.addInitScript((data) => { for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v); }, storage);
  await page.goto(base + urlTail);
  await page.waitForFunction(() => window.__app && window.__app.ready, null, { timeout: 60000 });
  await page.waitForTimeout(400);
  for (const [k, v] of steps) {
    if (k === 'eval') { const r = await page.evaluate(v); if (r !== undefined) console.log('eval →', JSON.stringify(r)); }
    else if (k === 'wait') await page.waitForTimeout(Number(v));
    else if (k === 'key') await page.keyboard.press(v);
    else if (k === 'type') { for (const ch of v) await page.keyboard.press(ch === ' ' ? 'Space' : ch); }
    else if (k === 'click') await page.click(v);
    else if (k === 'shot') { await page.screenshot({ path: v }); console.log('shot', v); }
    else console.log('知らない手順：' + k);
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
