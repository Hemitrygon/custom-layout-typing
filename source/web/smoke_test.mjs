// 画面の通し確認：ビルド済みの web/dist/ を Vite で配り、ヘッドレスの Chromium で開いて
// (1) Rust（WASM）が読み込める (2) 3D のキーボードが読み込める (3) 初めて開いたときの案内 (4) 練習を 1 文打てる (5) 各タブを開ける
// (6) ヘルプ・キーボード調整・追加のキー・データ（バックアップの書き出しと復元）(7) ページのエラーがない ことを確かめる。
//     node smoke_test.mjs [スクリーンショットの保存先.png]
// Playwright は親フォルダの node_modules のものを借りる（v6 にはまだ入れていない）。
import { preview } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(resolve(HERE, '../node_modules/playwright/index.mjs'));
// Playwright が入れたものとは別の Chromium を使うときは、環境変数 CHROMIUM_PATH にその場所を入れる
const CHROME = process.env.CHROMIUM_PATH || '';

const server = await preview({ root: HERE, preview: { port: 0, strictPort: false }, logLevel: 'silent' });
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  ...(CHROME && existsSync(CHROME) ? { executablePath: CHROME } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], // GPU のない環境でも WebGL を動かす
});
let ok = true;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  try {
    await page.waitForFunction(() => Boolean(document.documentElement.dataset.core), null, { timeout: 15000 });
    console.log('ok   WASM を読み込めた：core ' + await page.evaluate(() => document.documentElement.dataset.core));
  } catch {
    ok = false;
    console.log('FAIL WASM を読み込めない（画面が組み立てられていない）');
  }
  try {
    await page.waitForFunction(() => Number(document.documentElement.dataset.keys) > 0, null, { timeout: 30000 });
    console.log('ok   3D のキーボードを読み込めた：キー ' + await page.evaluate(() => document.documentElement.dataset.keys) + ' 個');
  } catch {
    ok = false;
    console.log('FAIL 3D のキーボードが読み込めない（public/models/keyboard.glb・public/draco/）');
  }
  // キーを 1 回押したことにする（Playwright が名前を知らないキー：IntlYen・Numpad1 なども送れる）
  const sendKey = (code, key = '', shiftKey = false) => page.evaluate(([c, k, sh]) => {
    for (const type of ['keydown', 'keyup']) document.body.dispatchEvent(new KeyboardEvent(type, { code: c, key: k, shiftKey: sh, bubbles: true, cancelable: true }));
  }, [code, key, shiftKey]);
  // 初めて開いたとき：案内（チュートリアル）が出る → キーボードの種類・配列を選ぶ → 戻る・進む → 最後まで進むと閉じて、次からは出ない
  try {
    await page.waitForFunction(() => window.__app && window.__app.ready, null, { timeout: 15000 });
    await page.waitForSelector('[data-modal="tutorial"] #tutNext', { timeout: 5000 });
    const step = () => page.evaluate(() => document.getElementById('tutStep').textContent);
    await page.keyboard.press('Space');                           // 「はじめる」にフォーカスがある：うしろの練習は始まらない
    const s2 = await step();
    await page.click('.tut-option[data-value="us"]');
    const kindUs = await page.evaluate(() => window.__app.S.kind);
    await page.click('.tut-option[data-value="jis"]');
    await page.keyboard.press('Enter');
    await page.click('.tut-option[data-value="colemak"]');
    const picked = await page.evaluate(() => window.__app.S.activeLayoutKey);
    await page.keyboard.press('ArrowLeft');
    const back = await step();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.click('.tut-option[data-value="no"]');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    const last = await step();
    const lastLabel = await page.evaluate(() => document.getElementById('tutNext').textContent);
    await page.click('#tutNext');
    const after = await page.evaluate(() => ({
      open: Boolean(document.querySelector('[data-modal="tutorial"]')), done: Boolean(localStorage.getItem('custom_typing_tutorial_done_v1')),
      kind: window.__app.S.kind, screen: document.body.dataset.pscreen,
    }));
    const good = s2 === '2 / 6' && kindUs === 'us' && picked === 'colemak' && back === '2 / 6' && last === '6 / 6' && lastLabel === '完了して練習へ'
      && !after.open && after.done && after.kind === 'jis' && after.screen === 'start';
    if (good) console.log('ok   はじめの案内：キーボードの種類・配列を選んで最後まで進めた（次からは出ない）');
    else { ok = false; console.log('FAIL はじめの案内：' + JSON.stringify({ s2, kindUs, picked, back, last, lastLabel, after })); }
  } catch (e) {
    ok = false;
    console.log('FAIL はじめの案内：' + String(e).split('\n')[0]);
    await page.evaluate(() => { localStorage.setItem('custom_typing_tutorial_done_v1', '1'); });
    await page.keyboard.press('Escape');
  }
  // 練習を 1 回通す：QWERTY にして、待機 → カウントダウン → 1 文目を打つ → 一時停止
  try {
    await page.evaluate(() => window.__app.model.selectLayout('qwerty'));
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.body.dataset.pscreen === 'typing', null, { timeout: 10000 });
    for (const ch of 'irohanioedo') await page.keyboard.press(ch);
    const progress = await page.evaluate(() => document.getElementById('stProgress').textContent);
    await page.keyboard.press('Escape');
    const screen = await page.evaluate(() => document.body.dataset.pscreen);
    if (progress === '2/8' && screen === 'paused') console.log('ok   練習：1 文を打って次の文へ進み、Esc で一時停止できた');
    else { ok = false; console.log('FAIL 練習の流れ：進行 ' + progress + '・画面 ' + screen); }
  } catch (e) {
    ok = false;
    console.log('FAIL 練習の流れ：' + String(e).split('\n')[0]);
  }
  // 平面のキーボードガイド：オンにすると、JIS だけにあるキー（¥・ろ）も出て、次のキーが光る。押したキーも一瞬光る
  try {
    await page.evaluate(() => window.__app.model.setSetting('keyboardView', 'flat'));
    await page.keyboard.press('Space');                             // 一時停止から再開
    await page.waitForFunction(() => document.body.dataset.pscreen === 'typing', null, { timeout: 5000 });
    const flat = await page.evaluate(() => {
      const box = document.getElementById('pFlat');
      const want = window.__app.model.guideFor(document.getElementById('pCaretChar').textContent);
      const lit = [...box.querySelectorAll('.fk-key.is-target')].map((n) => n.dataset.code).join(',');
      return { shown: !box.hidden, yen: Boolean(box.querySelector('[data-code="IntlYen"]')), ro: Boolean(box.querySelector('[data-code="IntlRo"]')), lit, want: want && want.code };
    });
    await page.keyboard.press('KeyZ');                              // 2 文目の最初（わ）ではない：ミス
    const hit = await page.evaluate(() => { const n = document.querySelector('#pFlat .fk-key[data-code="KeyZ"]'); return n ? n.dataset.hit : ''; });
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__app.model.setSetting('keyboardView', '3d'));
    const hidden = await page.evaluate(() => document.getElementById('pFlat').hidden);
    if (flat.shown && flat.yen && flat.ro && flat.lit && flat.lit === flat.want && hit === 'miss' && hidden) console.log('ok   平面のキーボードガイド：JIS だけのキーも出て、次のキーと押したキーが光る');
    else { ok = false; console.log('FAIL 平面のキーボードガイド：' + JSON.stringify({ flat, hit, hidden })); }
  } catch (e) {
    ok = false;
    console.log('FAIL 平面のキーボードガイド：' + String(e).split('\n')[0]);
  }
  // テーマ：ライトにすると、画面の色と 3D の光が変わる。ダークに戻せる。ローマ字の次の文字は、色を付けず下線だけ
  try {
    const look = () => page.evaluate(() => ({ theme: document.documentElement.dataset.theme, stage: window.__app.A.stage.theme, bg: getComputedStyle(document.body).backgroundColor }));
    await page.evaluate(() => window.__app.model.setSetting('theme', 'light'));
    const light = await look();
    await page.evaluate(() => window.__app.model.setSetting('theme', 'dark'));
    const dark = await look();
    await page.keyboard.press('Space');                             // 一時停止から再開
    await page.waitForFunction(() => document.body.dataset.pscreen === 'typing', null, { timeout: 5000 });
    const caret = await page.evaluate(() => {
      const now = document.getElementById('pCaretChar'), rest = now.nextElementSibling;
      return { same: getComputedStyle(now).color === getComputedStyle(rest).color, line: getComputedStyle(now, '::after').height };
    });
    await page.keyboard.press('Escape');
    if (light.theme === 'light' && light.stage === 'light' && dark.theme === 'dark' && dark.stage === 'dark' && light.bg !== dark.bg && caret.same && caret.line === '2px') console.log('ok   テーマ：ライトとダークを切り替えられた。ローマ字の次の文字は下線だけ');
    else { ok = false; console.log('FAIL テーマ・ローマ字の次の文字：' + JSON.stringify({ light, dark, caret })); }
  } catch (e) {
    ok = false;
    console.log('FAIL テーマ：' + String(e).split('\n')[0]);
  }
  // 記録の画面：タブを切り替えて、まとめの数字とシャトルランのトロフィーの棚が出る
  try {
    await page.click('.nav button[data-arg="history"]');
    await page.waitForSelector('#histBody .hist-stats', { timeout: 5000 });
    await page.click('[data-act="hist.kind"][data-arg="shuttle"]');
    await page.waitForSelector('#histBody .tr-card', { timeout: 5000 });
    const cards = await page.evaluate(() => document.querySelectorAll('#histBody .tr-card').length);
    await page.click('.nav button[data-arg="practice"]');
    console.log('ok   記録：通常の練習とシャトルラン（トロフィー ' + cards + ' 個）を表示できた');
  } catch (e) {
    ok = false;
    console.log('FAIL 記録の画面：' + String(e).split('\n')[0]);
  }
  // 練習文の画面：貼り付け → 行が増える → 一つ前に戻る → 並べ替え（ドラッグ・キー）→ 変換辞書 → 保存せずに移動
  try {
    await page.click('.nav button[data-arg="words"]');
    await page.waitForSelector('#wRows .w-row', { timeout: 5000 });
    const rows = () => page.evaluate(() => document.querySelectorAll('#wRows .w-row').length);
    const names = () => page.evaluate(() => [...document.querySelectorAll('#wPresetList .w-pname')].map((n) => n.textContent).join(','));
    const before = await rows();
    await page.fill('#wPaste', '今日は晴れ|きょうははれ\n明日（あした）');   // よみ付きの行（外の辞書を読みに行かない）
    await page.click('[data-act="words.append"]');
    const added = await rows();
    const kana = await page.evaluate(() => [...document.querySelectorAll('#wRows textarea[data-f="kana"]')].slice(-2).map((n) => n.value).join(','));
    await page.click('[data-act="words.undo"]');
    const undone = await rows();
    // プリセットの並べ替え：つまみをドラッグ（1 番目を 3 番目の下へ）、Shift＋↑ で戻す
    const order0 = await names();
    const grip = await page.locator('#wPresetList .w-pgrip').nth(0).boundingBox();
    const last = await page.locator('#wPresetList .w-pitem').nth(2).boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 10, last.y + last.height - 4, { steps: 6 });
    await page.mouse.up();
    const order1 = await names();
    await page.locator('#wPresetList .w-pitem').nth(2).focus();
    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('Shift+ArrowUp');
    const order2 = await names();
    // 変換辞書：登録 → 一覧に出る → 削除
    await page.click('[data-act="words.dict"]');
    await page.fill('#udWord', '生憎');
    await page.fill('#udReading', 'アイニク');
    await page.click('#udAdd');
    const dictRow = await page.evaluate(() => { const r = document.querySelector('#udList .ud-row'); return r ? r.querySelector('.ud-word').textContent + '=' + r.querySelector('.ud-reading').textContent : ''; });
    await page.click('#udList .ud-row [data-d="delete"]');
    await page.keyboard.press('Escape');
    // グループ：新しく作ってプリセットを足す
    await page.click('[data-act="words.sub"][data-arg="groups"]');
    await page.click('[data-act="words.groupNew"]');
    await page.click('#wGroupEditor [data-act="words.groupAdd"]');
    const members = await page.evaluate(() => document.querySelectorAll('#wGroupEditor .w-gmember').length);
    // 保存していないままタブを移ろうとすると聞かれる → 保存せずに移動
    await page.click('.nav button[data-arg="practice"]');
    await page.click('[data-choice="discard"]');
    const state = await page.evaluate(() => ({ tab: window.__app.A.tab, dirty: window.__app.S.wordsDirty, groups: window.__app.S.groups.length, order: window.__app.S.presets.map((p) => p.name).join(',') }));
    const moved = order0.split(',');
    moved.push(moved.shift());
    const good = added === before + 2 && kana === 'きょうははれ,あした' && undone === before && order1 === moved.join(',') && order2 === order0
      && dictRow === '生憎=あいにく' && members === 1 && state.tab === 'practice' && !state.dirty && state.groups === 1 && state.order === order0;
    if (good) console.log('ok   練習文：貼り付け・一つ前に戻る・並べ替え・変換辞書・グループ・保存せずに移動');
    else { ok = false; console.log('FAIL 練習文の画面：' + JSON.stringify({ before, added, kana, undone, order0, order1, order2, dictRow, members, state })); }
  } catch (e) {
    ok = false;
    console.log('FAIL 練習文の画面：' + String(e).split('\n')[0]);
  }
  // 配列の画面：キーを選ぶ → 文字を割り当てる（入れ替え）→ 一つ前に戻る → ドラッグで入れ替え → 実際のキーで選ぶ
  //   → Shift と一緒の面 → 保存枠に保存 → ファイル出力 → 初めの配列に戻す
  try {
    await page.click('.nav button[data-arg="editor"]');
    await page.waitForSelector('#edKeyboard .fk-key[data-code="KeyD"]', { timeout: 5000 });
    const st = () => page.evaluate(() => { const S = window.__app.S; return { key: S.activeLayoutKey, dirty: S.layoutDirty, q: S.layout.keys.KeyQ.char, w: S.layout.keys.KeyW.char, a: S.layout.keys.KeyA.char, sh: S.layout.keys.KeyQ.shiftChar || '', name: S.layout.name }; });
    const selected = () => page.evaluate(() => { const n = document.querySelector('#edKeyboard .fk-key.is-selected'); return n ? n.dataset.code : ''; });
    await page.evaluate(() => window.__app.model.selectLayout('qwerty'));
    await page.click('#edKeyboard .fk-key[data-code="KeyQ"]');
    await page.click('#edPalette .kc-chip[data-char="A"]');           // Q の位置に A → A と Q が入れ替わる
    const s1 = await st();
    const sel1 = await selected();                                     // 次のキー（W）へ進む
    await page.click('[data-act="ed.undo"]');
    const s2 = await st();
    const from = await page.locator('#edKeyboard .fk-key[data-code="KeyQ"]').boundingBox();
    const to = await page.locator('#edKeyboard .fk-key[data-code="KeyW"]').boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
    await page.mouse.up();
    const s3 = await st();
    await page.keyboard.press('KeyJ');
    const sel2 = await selected();
    await page.keyboard.press('ArrowLeft');
    const sel3 = await selected();
    await page.click('[data-act="ed.layer"][data-arg="shift"]');
    await page.click('#edKeyboard .fk-key[data-code="KeyQ"]');
    await page.click('#edPalette .kc-chip[data-char="!"]');
    const s4 = await st();
    await page.click('[data-act="ed.layer"][data-arg="base"]');
    await page.click('[data-act="ed.save"]');
    await page.click('[data-answer="yes"]');
    const s5 = await st();
    await page.click('[data-act="ed.export"]');
    const exported = await page.evaluate(() => { try { return JSON.parse(document.querySelector('#exText').value).keys.KeyQ.shiftChar; } catch { return 'x'; } });
    await page.keyboard.press('Escape');
    const metrics = await page.evaluate(() => document.querySelectorAll('#edMetrics .ed-metric').length);
    await page.click('[data-act="ed.pick"][data-arg="oonishi"]');
    await page.click('.nav button[data-arg="practice"]');
    const s6 = await st();
    const tab = await page.evaluate(() => window.__app.A.tab);
    const good = s1.q === 'A' && s1.a === 'Q' && s1.dirty && sel1 === 'KeyW' && s2.q === 'Q' && s2.a === 'A' && !s2.dirty
      && s3.q === 'W' && s3.w === 'Q' && sel2 === 'KeyJ' && sel3 === 'KeyH' && s4.sh === '!' && s5.key === 'custom1' && !s5.dirty && s5.name === 'QWERTY（改）'
      && exported === '!' && metrics === 4 && s6.key === 'oonishi' && tab === 'practice';
    if (good) console.log('ok   配列：割り当て・入れ替え・一つ前に戻る・ドラッグ・キーで選ぶ・Shift の面・保存枠に保存・ファイル出力');
    else { ok = false; console.log('FAIL 配列の画面：' + JSON.stringify({ s1, sel1, s2, s3, sel2, sel3, s4, s5, exported, metrics, s6, tab })); }
  } catch (e) {
    ok = false;
    console.log('FAIL 配列の画面：' + String(e).split('\n')[0]);
  }
  // ヘルプ：一覧 → 操作ガイド（ランク 18 段階・レベル一覧 45 行）→ 目次で飛ぶ → 設定の「比較表」
  try {
    await page.click('[data-act="help.menu"]');
    await page.click('.pop .pop-item');
    await page.waitForSelector('[data-modal="help"] #help-ranks', { timeout: 5000 });
    const counts = await page.evaluate(() => ({
      sections: document.querySelectorAll('[data-modal="help"] .help-sec').length,
      ranks: document.querySelectorAll('.help-ranks tbody tr').length,
      levels: document.querySelectorAll('#help-shuttle .sh-level-table tbody tr').length,
    }));
    await page.click('[data-modal="help"] [data-h="privacy"]');
    const jumped = await page.evaluate(() => {
      const body = document.querySelector('[data-modal="help"] .modal-body');
      const top = document.getElementById('help-privacy').getBoundingClientRect().top - body.getBoundingClientRect().top;
      return body.scrollTop > 500 && top >= 0 && top < 120;
    });
    await page.keyboard.press('Escape');
    await page.click('#btnDrawer');
    await page.click('[data-act="help.romaji"]');
    const romaji = await page.evaluate(() => document.querySelectorAll('.help-romaji tbody tr').length);
    await page.keyboard.press('Escape');
    const closed = await page.evaluate(() => document.querySelectorAll('.modal-wrap').length === 0);
    if (counts.sections === 10 && counts.ranks === 18 && counts.levels === 45 && jumped && romaji === 13 && closed) console.log('ok   ヘルプ：操作ガイド・ランクの基準・レベル一覧・ローマ字の比較表');
    else { ok = false; console.log('FAIL ヘルプ：' + JSON.stringify({ counts, jumped, romaji, closed })); }
  } catch (e) {
    ok = false;
    console.log('FAIL ヘルプ：' + String(e).split('\n')[0]);
  }
  // キーボード調整：A と S を入れ替えたキーボードのふりをして、全部の位置を押す（途中の Esc は閉じずにキーとして読む・「1つ戻る」で直す）
  //   → 読み取りが直る → 解除
  try {
    await page.click('[data-act="calib.open"]');
    await page.click('[data-c="start"]');
    const order = await page.evaluate(() => window.__app.S.rows.flatMap((r) => r.filter((x) => !x.isModifier).map((x) => x.code)));
    const progress = () => page.evaluate(() => { const n = document.getElementById('calProgress'); return n ? n.textContent.replace(/\s/g, '') : ''; });
    const swap = { KeyA: 'KeyS', KeyS: 'KeyA' };
    let escKept = '', backTo = '', same = '';
    for (const [i, code] of order.entries()) {
      if (i === 3) {
        await sendKey('Escape', 'Escape');
        escKept = await progress();
        await page.click('[data-c="back"]');
        backTo = await progress();
        await sendKey(order[0], '');                                // もう使った信号：進まずに知らせる
        same = await page.evaluate(() => document.getElementById('calMessage').textContent);
      }
      await sendKey(swap[code] || code, '');
    }
    const done = await page.evaluate(() => {
      const r = window.__app.S.reader, c = r.calibration();
      return { text: document.getElementById('calDoneText').textContent.slice(0, 6), remapped: c && c.remapped, a: r.physicalCode({ code: 'KeyA', key: 'a' }), d: r.physicalCode({ code: 'KeyD', key: 'd' }) };
    });
    // Shift も調整する：「2」の位置だけ、Shift と一緒に押すと別の信号（Numpad2）を送るキーボードのふり
    await page.click('[data-c="startShift"]');
    await sendKey(order[0], '', false);                             // Shift なし：進まずに知らせる
    const needShift = await page.evaluate(() => document.getElementById('calMessage').textContent);
    for (const code of order) { if (code === 'Digit2') await sendKey('Numpad2', '2', false); else await sendKey(swap[code] || code, '', true); }
    const shifted = await page.evaluate(() => {
      const r = window.__app.S.reader, c = r.calibration();
      const hit = r.resolve({ code: 'Numpad2', key: '2', shiftKey: false });
      return { map: c && JSON.stringify(c.shiftMap), kept: c && c.remapped, ch: hit && hit.char, want: window.__app.core.shiftedChar(window.__app.S.kind, window.__app.S.layout.keys.Digit2.char) };
    });
    await page.keyboard.press('Escape');
    const chip = await page.evaluate(() => document.querySelector('[data-act="calib.open"] .chip').textContent);
    await page.click('[data-act="calib.open"]');
    await page.click('[data-c="clear"]');
    await page.keyboard.press('Escape');
    const cleared = await page.evaluate(() => !window.__app.S.reader.hasCalibration() && localStorage.getItem('custom_typing_calibration_v1') === null);
    const n = order.length;
    const good = n >= 47 && escKept === '5/' + n && backTo === '4/' + n && same.includes('同じ信号') && done.text === '2 個のキー' && done.remapped === 2
      && done.a === 'KeyS' && done.d === 'KeyD' && chip === '調整済み' && cleared
      && needShift.includes('Shift を押したまま') && shifted.map === '{"Numpad2":"Digit2"}' && shifted.kept === 2 && shifted.ch === shifted.want && shifted.want !== '2';
    if (good) console.log('ok   キーボード調整：' + n + ' 個の位置を押して、入れ替わったキーを読み替えた（1つ戻る・Shift の調整・解除も）');
    else { ok = false; console.log('FAIL キーボード調整：' + JSON.stringify({ n, escKept, backTo, same, done, needShift, shifted, chip, cleared })); }
  } catch (e) {
    ok = false;
    console.log('FAIL キーボード調整：' + String(e).split('\n')[0]);
  }
  // 追加のキー：テンキーの 1 を「1」として登録 → もうほかのキーとして使われている信号は確かめる → 登録できないキー → すべて消す
  try {
    await page.click('[data-act="extra.open"]');
    await page.click('#exKeyboard .fk-key[data-code="Digit1"]');
    await sendKey('Numpad1', '1');
    const reg = await page.evaluate(() => { const r = window.__app.S.reader; return { map: r.extraKeys().Numpad1, code: r.physicalCode({ code: 'Numpad1', key: '1' }), msg: document.getElementById('exMessage').textContent }; });
    await page.click('#exKeyboard .fk-key[data-code="Digit2"]');
    await sendKey('KeyA', 'a');
    const conflict = await page.evaluate(() => Boolean(document.getElementById('exConflict')));
    await page.click('[data-c="exRetry"]');
    await sendKey('Backspace', 'Backspace');
    const blocked = await page.evaluate(() => document.getElementById('exMessage').textContent);
    await sendKey('Digit2', '2');
    const plain = await page.evaluate(() => document.getElementById('exMessage').textContent);
    const summary = await page.evaluate(() => document.getElementById('exSummary').textContent);
    await page.click('[data-c="exClear"]');
    const emptied = await page.evaluate(() => Object.keys(window.__app.S.reader.extraKeys()).length === 0 && localStorage.getItem('custom_typing_extra_keys_v1') === null);
    await page.keyboard.press('Escape');
    await page.click('#drawer [data-act="drawer.close"]');
    const good = reg.map === 'Digit1' && reg.code === 'Digit1' && reg.msg.includes('Numpad1 で登録しました') && conflict && blocked.includes('登録できません')
      && plain.includes('そのまま') && summary === '1 個のキーを登録済み' && emptied;
    if (good) console.log('ok   追加のキー：登録・ほかのキーと同じ信号の確かめ・登録できないキー・すべて消す');
    else { ok = false; console.log('FAIL 追加のキー：' + JSON.stringify({ reg, conflict, blocked, plain, summary, emptied })); }
  } catch (e) {
    ok = false;
    console.log('FAIL 追加のキー：' + String(e).split('\n')[0]);
  }
  // データ：バックアップを書き出す → 配列を変える → 書き出したファイルで復元すると、書き出したときの状態に戻る
  try {
    await page.click('[data-act="data.open"]');
    await page.waitForSelector('[data-modal="data"] #dataOverwrite', { timeout: 5000 });
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('[data-d="export"]')]);
    const file = await download.path();
    const text = readFileSync(file, 'utf8');
    const info = await page.evaluate((t) => { const v = window.__app.core.validateBackup(t, 20 * 1024 * 1024); return { ok: v.ok, keys: v.ok ? v.entries.length : 0, backedUp: Boolean(localStorage.getItem('custom_typing_last_backup_v1')) }; }, text);
    const name = download.suggestedFilename();
    await page.evaluate(() => window.__app.model.selectLayout('dvorak'));
    await page.setInputFiles('#dataFile', file);
    await page.click('[data-answer="yes"]');
    await page.waitForFunction(() => window.__app && window.__app.ready && window.__app.S.activeLayoutKey === 'oonishi', null, { timeout: 30000 });
    const restored = await page.evaluate(() => ({ tutorial: Boolean(document.querySelector('[data-modal="tutorial"]')), slot: window.__app.S.layouts.custom1.name, groups: window.__app.S.groups.length }));
    if (info.ok && info.keys > 5 && info.backedUp && /^typing_backup_\d{8}_\d{4}\.json$/.test(name) && !restored.tutorial && restored.slot === 'QWERTY（改）') console.log('ok   データ：バックアップの書き出し（' + info.keys + ' 項目）と復元');
    else { ok = false; console.log('FAIL データ：' + JSON.stringify({ info, name, restored })); }
  } catch (e) {
    ok = false;
    console.log('FAIL データ：' + String(e).split('\n')[0]);
  }
  await page.waitForTimeout(500);
  if (errors.length) { ok = false; console.log('FAIL ページのエラー：\n  ' + errors.join('\n  ')); }
  else console.log('ok   ページのエラーなし');
  if (process.argv[2]) { await page.screenshot({ path: process.argv[2] }); console.log('     スクリーンショット：' + process.argv[2]); }
} finally {
  await browser.close();
  await new Promise(r => server.httpServer.close(r));
}
process.exit(ok ? 0 : 1);
