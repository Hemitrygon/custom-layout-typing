// データの引き継ぎの確かめ：旧版（old_versions/ の最新の v5：typing_practice_v5.Y.Z.html）で作ったバックアップを、
// 今の版（v6）でそのまま復元できることを、本物のブラウザで確かめる。
//   1. 旧版（v5）を開き、設定を変え（US・ヘボン式・QWERTY）、保存枠に配列を保存し、練習を 1 回最後まで打って記録を作る
//   2. 旧版（v5）の「バックアップを書き出す」でファイルを作る
//   3. v6（web/dist/）を開き、「データ」→「バックアップから復元」でそのファイルを読む
//   4. 保存データが 1 項目ずつ同じ中身になり、設定・配列・記録が画面に出ることを確かめる
//   5. 逆向き：v6 で書き出したバックアップを、旧版（v5）が自分のバックアップとして受け付ける
//     node v5_backup_test.mjs      （web/ の中で。先に npm run build が要る）
// ネットには出ない（旧版（v5）の CDN は止める）。Playwright はルートの node_modules のものを使う。
import { preview } from 'vite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OLD = resolve(ROOT, 'old_versions');
const { chromium } = await import(resolve(ROOT, 'node_modules/playwright/index.mjs'));
// Playwright が入れたものとは別の Chromium を使うときは、環境変数 CHROMIUM_PATH にその場所を入れる
const CHROME = process.env.CHROMIUM_PATH || '';

function latestSource() {
  // 旧版（v5）の本体は old_versions/ にある。いちばん新しい v5 を使う
  const found = readdirSync(OLD)
    .map((name) => ({ name, v: (name.match(/^typing_practice_v(5)\.(\d+)\.(\d+)\.html$/) || []).slice(1).map(Number) }))
    .filter((f) => f.v.length === 3)
    .sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.v[2] - b.v[2]);
  return resolve(OLD, found.pop().name);
}

// バックアップの管理に使う項目は、復元のときに書き換わる（中身のデータではない）
const MANAGED = ['custom_typing_last_backup_v1', 'custom_typing_data_changed_v1', 'custom_typing_backup_snooze_v1'];
const KEY_OF = { '-': 'Minus', ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight' };
const sameJson = (a, b) => {
  if (a === b) return true;
  try { return JSON.stringify(sortKeys(JSON.parse(a))) === JSON.stringify(sortKeys(JSON.parse(b))); } catch { return false; }
};
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);

let ok = true;
const check = (cond, text, detail) => { if (cond) console.log('ok   ' + text); else { ok = false; console.log('FAIL ' + text + (detail === undefined ? '' : '：' + JSON.stringify(detail))); } };

const source = latestSource();
const server = await preview({ root: HERE, preview: { port: 0, strictPort: false }, logLevel: 'silent' });
const browser = await chromium.launch({
  ...(CHROME && existsSync(CHROME) ? { executablePath: CHROME } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  // ---------- 1・2：旧版（v5）でデータを作り、バックアップを書き出す ----------
  const oldCtx = await browser.newContext({ acceptDownloads: true });
  const old = await oldCtx.newPage();
  await old.route(/^https?:\/\//, (r) => r.abort());
  await old.goto(pathToFileURL(source).href);
  await old.waitForFunction(() => typeof buildBackupPayload === 'function' && typeof state === 'object');
  await old.evaluate(() => {
    /* global finishTutorial, setKeyboardType, setRomajiStyle, loadLayoutByKey, saveCurrentLayoutManually, state */
    finishTutorial(true);
    setKeyboardType('us', { silent: true });
    setRomajiStyle('hepburn');
    loadLayoutByKey('custom2');
    state.currentLayout.name = '旧版（v5）の配列';
    state.currentLayout.keys.KeyQ.char = 'A';
    state.currentLayout.keys.KeyA.char = 'Q';
    saveCurrentLayoutManually(true);
    loadLayoutByKey('qwerty');
  });
  await old.keyboard.press('Space');
  await old.waitForFunction(() => state.screenState === 'typing', null, { timeout: 15000 });
  let typed = 0;
  for (; typed < 3000; typed++) {
    const ch = await old.evaluate(() => (state.screenState === 'typing' ? getTargetNextChar() : null));   // eslint-disable-line no-undef
    if (!ch) break;
    await old.keyboard.press(/^[A-Z]$/.test(ch) ? 'Key' + ch : /^\d$/.test(ch) ? 'Digit' + ch : KEY_OF[ch] || ch);
  }
  await old.waitForFunction(() => state.screenState === 'result', null, { timeout: 5000 });
  const before = await old.evaluate(() => {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^(custom_typing_|typecraft_)/.test(k)) data[k] = localStorage.getItem(k); }
    return { data, record: state.scoreHistory[state.scoreHistory.length - 1], count: state.scoreHistory.length };
  });
  const [download] = await Promise.all([old.waitForEvent('download', { timeout: 10000 }), old.evaluate(() => exportBackupFile())]);   // eslint-disable-line no-undef
  const file = await download.path();
  const keys = Object.keys(before.data).filter((k) => !MANAGED.includes(k));
  check(before.count === 1 && typed > 50 && keys.length >= 6, '旧版（v5）（' + source + '）で練習を 1 回打ち切り（' + typed + ' 打）、バックアップを書き出した（' + keys.length + ' 項目）', { count: before.count, typed, keys });

  // ---------- 3・4：v6 で復元する ----------
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(server.resolvedUrls.local[0] + '?tutorial=0');
  await page.waitForFunction(() => window.__app && window.__app.ready, null, { timeout: 60000 });
  await page.click('[data-act="data.open"]');
  await page.setInputFiles('#dataFile', file);
  await page.click('[data-answer="yes"]');
  await page.waitForFunction(() => window.__app && window.__app.ready && window.__app.S.history.length === 1, null, { timeout: 60000 });
  const after = await page.evaluate(() => {
    const { S, core } = window.__app;
    const data = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^(custom_typing_|typecraft_)/.test(k)) data[k] = core.decodeStored(localStorage.getItem(k)); }
    return {
      data, kind: S.kind, style: S.romajiStyle, layout: S.activeLayoutKey, record: S.history[0], tutorial: Boolean(document.querySelector('[data-modal="tutorial"]')),
      slot: { name: S.layouts.custom2.name, q: S.layouts.custom2.keys.KeyQ.char, a: S.layouts.custom2.keys.KeyA.char }, presets: S.presets.map((p) => p.name + ':' + p.words.length).join(','),
    };
  });
  const differ = keys.filter((k) => !sameJson(before.data[k], after.data[k]));
  const extra = Object.keys(after.data).filter((k) => !(k in before.data) && !MANAGED.includes(k));
  check(differ.length === 0, '保存データ：旧版（v5）の ' + keys.length + ' 項目が、v6 でも同じ中身', differ.map((k) => ({ key: k, old: String(before.data[k]).slice(0, 160), now: String(after.data[k]).slice(0, 160) })));
  check(extra.length === 0, '保存データ：復元しただけでは、v6 が項目を足さない', extra);
  check(after.kind === 'us' && after.style === 'hepburn' && after.layout === 'qwerty' && !after.tutorial, '設定：キーボードの種類・ローマ字方式・選んでいた配列が引き継がれた', { kind: after.kind, style: after.style, layout: after.layout, tutorial: after.tutorial });
  check(after.slot.name === '旧版（v5）の配列' && after.slot.q === 'A' && after.slot.a === 'Q', '配列：保存枠の配列が引き継がれた', after.slot);
  const r0 = before.record, r1 = after.record;
  const fields = ['id', 'timestamp', 'score', 'wpm', 'layoutName', 'courseKey', 'courseName'];
  check(r1 && fields.every((f) => r0[f] === r1[f]) && r1.score > 0, '記録：旧版（v5）のスコア（' + r0.score + ' 点・' + r0.layoutName + '）が同じ値で読めた', { old: r0, now: r1 });
  await page.click('.nav button[data-arg="history"]');
  await page.waitForSelector('#histBody .hist-stats', { timeout: 5000 });
  const shown = await page.evaluate(() => ({
    rows: document.querySelectorAll('#histBody .rec-score').length, best: (document.querySelector('#histBody .hist-stat-main b') || {}).textContent,
    bestLine: (document.querySelector('#histChart .best-label') || {}).textContent || '',
  }));
  check(shown.rows === 1 && shown.best === r0.score.toLocaleString() && shown.bestLine === '最高 ' + r0.score.toLocaleString(), '記録の画面：引き継いだ記録と、グラフの「最高」の線が表示された', shown);

  // ---------- 5：逆向き（v6 のバックアップを、旧版（v5）が受け付ける） ----------
  await page.click('[data-act="data.open"]');
  const [back] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('[data-d="export"]')]);
  const backText = readFileSync(await back.path(), 'utf8');
  const info = await old.evaluate((text) => readBackupFileInfo({ getFile: async () => new File([text], 'from_remake.json', { type: 'application/json' }) }), backText);   // eslint-disable-line no-undef
  check(info && info.ok === true && info.scores === 1, '逆向き：v6 で書き出したバックアップを、旧版（v5）が自分のバックアップとして読めた', info);
  await page.waitForTimeout(300);
  check(errors.length === 0, 'ページのエラーなし', errors);
} catch (e) {
  ok = false;
  console.log('FAIL 途中で止まった：' + String(e).split('\n')[0]);
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
process.exit(ok ? 0 : 1);
