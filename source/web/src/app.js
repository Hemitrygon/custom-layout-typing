// 画面全体のまとめ役：上の帯・タブの切り替え・設定の引き出し・キーの振り分け・舞台（3D）との連絡。
import { core } from './core.js';
import { S, bus, loadAll, setSetting, setShiftGuide, setRomajiStyle, setKind, selectLayout, refreshReader, SHIFT_GUIDE_LABELS } from './model.js';
import { checkStorage, onStorageFailure, PREFIXES } from './store.js';
import { $, html, setHtml, act, wireActions } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { toast, banner, closeBanner, modalKeyDown, modalOpen, popKeyDown, popOpen, closePop, confirmDialog } from './ui/overlay.js';
import { setSoundEnabled } from './sound.js';
import { mountShuttle, shuttleActive, shuttleSlot, shuttleKeyDown, shuttleKeyUp, shuttlePause } from './views/shuttle.js';
import { mountPractice, practiceKeyDown, practiceKeyUp, practiceBusy, practiceScreen, applyStage as applyPracticeStage, clearVirtualShift, pause as pausePractice, resetToStart, abandonForNewSelection } from './views/practice.js';

/* global __APP_VERSION__ */
export const VERSION_LABEL = 'v' + __APP_VERSION__;   // 版番号は web/package.json の version（vite.config.js が渡す）
const TABS = [
  { id: 'practice', label: '練習', title: 'タイピング練習' },
  { id: 'words', label: '練習文', title: '練習文を編集' },
  { id: 'editor', label: '配列', title: '配列エディタ' },
  { id: 'history', label: '記録', title: '過去のスコア' },
];

export const A = {
  tab: 'practice',
  stage: null,
  views: {},          // タブ名 → {mount, enter, leave, keyDown, dirty, save, discard}
  held: new Map(),    // e.code → 舞台で沈めているキー
  hooks: {},          // ほかのモジュールが足す：openShuttle・shuttleKeyDown・maybeBackupReminder など
};

// ---------- 骨組み ----------

export function buildShell() {
  setHtml('#app', html`
    <header id="top">
      <div class="brand">
        <img src="${import.meta.env.BASE_URL}img/logo.png" alt="" width="30" height="30">
        <span class="brand-name">カスタム配列タイピング</span>
        <span class="brand-ver">${VERSION_LABEL}</span>
      </div>
      <nav class="nav" aria-label="画面の切り替え">
        ${TABS.map((t) => html`<button data-act="nav" data-arg="${t.id}" title="${t.title}" aria-current="${t.id === 'practice' ? 'page' : 'false'}">${t.label}</button>`)}
      </nav>
      <div class="top-actions">
        <button class="icon-btn" data-act="drawer.toggle" aria-expanded="false" id="btnDrawer" title="入力と表示の設定">${icon.sliders}<span>設定</span></button>
        <button class="icon-btn" data-act="data.open" title="データの保存とバックアップ">${icon.data}<span>データ</span></button>
        <button class="icon-btn" data-act="help.menu" aria-expanded="false" title="ヘルプ">${icon.help}<span>ヘルプ</span></button>
      </div>
    </header>
    <main id="views">
      <section class="view" id="view-practice" aria-label="タイピング練習"></section>
      <section class="view panel-view" id="view-words" aria-label="練習文を編集" hidden></section>
      <section class="view panel-view" id="view-editor" aria-label="配列エディタ" hidden></section>
      <section class="view panel-view" id="view-history" aria-label="過去のスコア" hidden></section>
    </main>
    <div id="shuttle" hidden></div>
    <div id="scrim" data-act="drawer.close"></div>
    <aside id="drawer" class="glass" aria-label="設定" aria-hidden="true"></aside>
    <div id="modals"></div>
    <div id="toasts" aria-live="polite"></div>`);
}

// ---------- タブ ----------

export function registerView(id, view) { A.views[id] = view; }

/** タブを切り替える（保存していない変更があれば確かめる）。 */
export async function switchTab(id) {
  if (!TABS.some((t) => t.id === id) || id === A.tab) return;
  const from = A.views[A.tab];
  if (from && from.dirty && from.dirty()) {
    const ok = await from.confirmLeave();
    if (!ok) return;
  }
  if (A.tab === 'practice' && practiceBusy()) { resetToStart(); toast('練習を中断しました（今回の結果は記録されません）'); }
  if (from && from.leave) from.leave();
  closePop();
  A.tab = id;
  for (const t of TABS) $('#view-' + t.id).hidden = t.id !== id;
  for (const b of document.querySelectorAll('.nav button')) b.setAttribute('aria-current', b.dataset.arg === id ? 'page' : 'false');
  const to = A.views[id];
  if (to && to.enter) to.enter();
  applyStage();
}

/** 舞台のカメラ・光・ぼけを、今のタブに合わせる。 */
export function applyStage() {
  const st = A.stage;
  if (!st) return;
  document.body.dataset.tab = A.tab;
  if (A.hooks.shuttleActive && A.hooks.shuttleActive()) return;   // シャトルランは自分で決める
  if (A.tab === 'practice') {
    document.body.dataset.depth = 'front';
    applyPracticeStage();
  } else {
    document.body.dataset.depth = 'back';
    document.body.dataset.focus = '0';
    st.setTargets([]);
    st.setHeat({});
    const look = { words: ['words', 'dawn'], editor: ['editor', 'night'], history: ['history', 'day'] }[A.tab];
    st.setPose(look[0], 1.5);
    st.setMood(look[1], 1.5);
  }
  syncSlot();
}

/** キーボードを収める枠を舞台に伝える（練習：下半分の枠。ほかのタブ：画面全体）。 */
export function syncSlot(immediate = false) {
  const st = A.stage;
  if (!st) return;
  if (A.hooks.shuttleActive && A.hooks.shuttleActive()) { const r = A.hooks.shuttleSlot(); if (r) st.setSlot(r, immediate); return; }
  if (A.tab === 'practice' && document.body.dataset.pscreen === 'result') {
    // 結果の画面：キーボードの枠は、結果の枠の下の広めの場所に固定する（縮んだ枠に合わせると、カメラが大きく引いてしまう）
    st.setSlot({ left: window.innerWidth * 0.14, top: window.innerHeight * 0.56, width: window.innerWidth * 0.72, height: window.innerHeight * 0.44 }, immediate);
  } else if (A.tab === 'practice') {
    const node = $('#kbSlot');
    const r = node.getBoundingClientRect();
    if (r.width > 10 && r.height > 10) st.setSlot(r, immediate);
  } else {
    st.setSlot({ left: 0, top: window.innerHeight * 0.12, width: window.innerWidth, height: window.innerHeight * 0.88 }, immediate);
  }
}

// ---------- 配列を選ぶ ----------

/** 配列を切り替える（配列エディタに保存していない変更があれば確かめる）。 */
export async function requestLayout(key) {
  if (key === S.activeLayoutKey && !S.layoutDirty) return;
  if (S.layoutDirty) {
    const ok = await confirmDialog({ title: '保存していない配列の変更があります', text: '配列を切り替えると編集中の変更は失われますが、切り替えますか？', ok: '切り替える', danger: true });
    if (!ok) return;
  }
  abandonForNewSelection();
  selectLayout(key);
  toast('配列を「' + S.layout.name + '」に切り替えました');
}

/** 舞台の刻印を、今の配列と設定に合わせる。 */
export function syncLegends() {
  if (!A.stage) return;
  A.stage.setLayout(S.layout, S.kind, S.rows, { fingerColors: S.settings.showFingerColors, qwertySub: S.settings.showQwertySub, qwerty: S.layouts.qwerty });
}

// ---------- 設定の引き出し ----------

// 練習中の表示（オン・オフ）：[設定の名前, 表示名, 説明]
const TOGGLES = [
  ['showFingerColors', '運指の色分け', 'キーを担当指の色で塗り分けます'],
  ['showKeyGuide', '次のキーのガイド', '次に押すキーと指を光らせます'],
  ['showQwertySub', 'QWERTY の文字を添える', 'キーの隅に QWERTY 配列での文字を表示します'],
  ['showKana', 'よみがな', ''],
  ['showRomaji', 'ローマ字', ''],
  ['minimalMode', '最小構成', '練習中は文とキーボード以外を隠します'],
];

function seg(actName, value, options) {
  return html`<div class="seg" role="group">${options.map(([v, label]) => html`<button data-act="${actName}" data-arg="${v}" aria-pressed="${String(value === v)}">${label}</button>`)}</div>`;
}
const row = (name, note, control) => html`<div class="set-row"><div><div class="set-name">${name}</div>${note ? html`<div class="set-note">${note}</div>` : ''}</div>${control}</div>`;
const sw = (key, name) => html`<button class="switch" role="switch" aria-checked="${String(S.settings[key])}" aria-label="${name}" data-act="set.toggle" data-arg="${key}"></button>`;

export function renderDrawer() {
  const s = S.settings;
  const calibrated = S.reader && S.reader.hasCalibration();
  const extraCount = S.reader ? Object.keys(S.reader.extraKeys()).length : 0;
  setHtml('#drawer', html`
    <div class="drawer-head"><h2 class="modal-title">設定</h2><button class="icon-btn" data-act="drawer.close" aria-label="閉じる">${icon.close}</button></div>
    <div class="drawer-body">
      <div class="set-group">
        <h3>見た目</h3>
        ${row('テーマ', '', seg('set.theme', s.theme, [['dark', 'ダーク'], ['light', 'ライト'], ['auto', '自動']]))}
        ${row('練習のキーボード', '平面にすると ¥ と ろ のキーも表示されます', seg('set.view', s.keyboardView, [['3d', '3D'], ['flat', '平面']]))}
        ${row('軽い表示', '影やぼかし、カメラの動きを省いて GPU の負荷を減らします', sw('lowQuality', '軽い表示'))}
      </div>
      <div class="set-group">
        <h3>入力</h3>
        ${row('ローマ字方式', html`どちらの綴りで打っても正解になります <button class="btn-link" data-act="help.romaji">比較表</button>`, seg('set.romaji', S.romajiStyle, [['nihon', '日本式'], ['hepburn', 'ヘボン式']]))}
        ${row('キーボードの種類', '', seg('set.kind', S.kind, [['jis', 'JIS'], ['us', 'US']]))}
        ${row('光らせる Shift', '記号の入力時に光らせる Shift キーを選びます', seg('set.shiftGuide', S.shiftGuide, Object.entries(SHIFT_GUIDE_LABELS)))}
        <button class="set-row" data-act="calib.open"><div><div class="set-name">キーボード調整</div><div class="set-note">キーボード側で配列を変更している場合に使います</div></div><span class="chip ${calibrated ? 'chip-ok' : ''}">${calibrated ? '調整済み' : 'なし'}</span></button>
        <button class="set-row" data-act="extra.open"><div><div class="set-name">追加のキー</div><div class="set-note">数字や記号をレイヤーから入力する場合に使います</div></div><span class="chip ${extraCount ? 'chip-ok' : ''}">${extraCount ? extraCount + ' 個' : 'なし'}</span></button>
      </div>
      <div class="set-group">
        <h3>練習中の表示</h3>
        ${TOGGLES.map(([key, name, note]) => row(name, note, sw(key, name)))}
      </div>
      <div class="set-group">
        <h3>音</h3>
        ${row('打鍵音', '', sw('soundEnabled', '打鍵音'))}
      </div>
    </div>`);
}

function setDrawer(open) {
  const d = $('#drawer');
  if (open) renderDrawer();
  d.classList.toggle('is-open', open);
  d.setAttribute('aria-hidden', String(!open));
  $('#scrim').classList.toggle('is-on', open);
  $('#btnDrawer').setAttribute('aria-expanded', String(open));
  if (open && A.tab === 'practice' && practiceScreen() === 'typing') pausePractice();
}
export const drawerOpen = () => $('#drawer').classList.contains('is-open');

/** 今のテーマ（'auto' はパソコンの設定に合わせる）。 */
const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
export function currentTheme() {
  const t = S.settings.theme;
  if (t === 'auto') return darkQuery && !darkQuery.matches ? 'light' : 'dark';
  return t === 'light' ? 'light' : 'dark';
}

/** 設定を画面と舞台に反映する。 */
export function applySettings() {
  const s = S.settings;
  setSoundEnabled(s.soundEnabled);
  const theme = currentTheme();
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.content = theme;
  document.body.dataset.view = s.keyboardView === 'flat' ? 'flat' : '3d';
  if (A.stage) {
    A.stage.setTheme(theme);
    const want = s.lowQuality || A.stage.software ? 'low' : 'high';
    if (A.stage.quality !== want) A.stage.setQuality(want);
    document.body.dataset.low = want === 'low' ? '1' : '0';
    syncLegends();
  }
}

// ---------- キー ----------

const NEUTRAL_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'Tab', 'CapsLock', 'Enter', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

function stageVisible() { return A.tab === 'practice' || (A.hooks.shuttleActive && A.hooks.shuttleActive()); }

function onKeyDown(e) {
  // 文字の変換中（IME）のキーは、ショートカットにしない
  const inField = e.target instanceof Element && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if ((e.isComposing || e.keyCode === 229) && inField) return;
  if (popOpen() && popKeyDown(e)) return;
  if (modalOpen()) { modalKeyDown(e); return; }
  if (drawerOpen()) { if (e.key === 'Escape') { e.preventDefault(); setDrawer(false); } if (!inField) return; }
  if (A.hooks.shuttleKeyDown && A.hooks.shuttleKeyDown(e)) return;

  const view = A.views[A.tab];
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && String(e.key || '').toLowerCase() === 'z' && view && view.undo) {
    if (view.undo(e)) return;
  }
  if (inField) return;

  // 舞台のキーを沈める（文字のキーは、正誤の色を付けて各画面が沈める）
  if (stageVisible() && !e.repeat && A.stage && (NEUTRAL_KEYS.has(e.key) || e.code === 'Space')) pressKey(e, e.code, 'neutral');

  if (A.tab === 'practice') practiceKeyDown(e);
  else if (view && view.keyDown) view.keyDown(e);
}

function onKeyUp(e) {
  const code = A.held.get(e.code);
  if (code && A.stage) A.stage.release(code);
  A.held.delete(e.code);
  practiceKeyUp(e);
  if (A.hooks.shuttleKeyUp) A.hooks.shuttleKeyUp(e);
}

/** 舞台のキーを沈める（離したときに戻せるよう覚えておく）。 */
export function pressKey(e, code, tone) {
  if (!A.stage || !code) return;
  A.stage.press(code, { tone, hold: Boolean(e) });
  if (e) A.held.set(e.code, code);
}

// ---------- 起動 ----------

export function wireApp() {
  wireActions(document);
  act({
    'nav': (id) => switchTab(id),
    'drawer.toggle': () => setDrawer(!drawerOpen()),
    'drawer.close': () => setDrawer(false),
    'banner.close': () => closeBanner(),
    'set.toggle': (key) => { setSetting(key, !S.settings[key]); renderDrawer(); },
    'set.theme': (v) => { setSetting('theme', ['dark', 'light', 'auto'].includes(v) ? v : 'dark'); renderDrawer(); },
    'set.view': (v) => { setSetting('keyboardView', v === 'flat' ? 'flat' : '3d'); renderDrawer(); },
    'set.romaji': (v) => { setRomajiStyle(v); renderDrawer(); },
    'set.shiftGuide': (v) => { setShiftGuide(v); renderDrawer(); },
    'set.kind': async (v) => {
      if (v === S.kind) return;
      if (S.layoutDirty) {
        const ok = await confirmDialog({ title: '保存していない配列の変更があります', text: 'キーボードの種類を変更すると編集中の配列が読み込み直されますが、続行しますか？', ok: '続行する', danger: true });
        if (!ok) return;
      }
      abandonForNewSelection();
      setKind(v);
      renderDrawer();
      toast('キーボードを ' + (v === 'us' ? 'US' : 'JIS') + ' 配列に切り替えました');
    },
  });

  bus.on('settings', () => applySettings());
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', () => { if (S.settings.theme === 'auto') applySettings(); });
  bus.on('layout', () => syncLegends());
  bus.on('reader', () => { if (drawerOpen()) renderDrawer(); });   // キーボード調整・追加のキーが変わった

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  // ウィンドウが後ろに回っている間に離した Shift は、離した知らせが届かない
  window.addEventListener('blur', () => { clearVirtualShift(); A.held.clear(); if (A.stage) A.stage.releaseAll(); if (A.hooks.shuttlePause) A.hooks.shuttlePause(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && A.hooks.shuttlePause) A.hooks.shuttlePause(); });
  window.addEventListener('resize', () => syncSlot(true));
  // 保存していない変更があるときは、閉じる前に確かめる
  window.addEventListener('beforeunload', (e) => {
    if (S.layoutDirty || S.wordsDirty) { e.preventDefault(); e.returnValue = ''; }
  });
  // 別のウィンドウ・タブで保存されたものを読み直す（古いデータで上書きしない）
  window.addEventListener('storage', (e) => {
    if (e.key !== null && !PREFIXES.some((p) => e.key.startsWith(p))) return;
    bus.emit('storage', e.key);
  });
}

export function initData() {
  onStorageFailure((text) => banner(text));
  checkStorage();
  loadAll();
}

export function mountViews() {
  mountPractice($('#view-practice'), {
    stage: A.stage,
    isActive: () => A.tab === 'practice' && !(A.hooks.shuttleActive && A.hooks.shuttleActive()),
    switchTab,
    requestLayout,
    syncSlot: () => syncSlot(),
    press: pressKey,
    suggestCalibration: () => { if (A.hooks.suggestCalibration) A.hooks.suggestCalibration(); },
    maybeBackupReminder: (delay, where) => { if (A.hooks.maybeBackupReminder) A.hooks.maybeBackupReminder(delay, where); },
  });
  mountShuttle($('#shuttle'), {
    stage: A.stage, press: pressKey, applyStage, syncSlot, practiceBusy, resetPractice: resetToStart, refreshPractice: resetToStart,
    maybeBackupReminder: (delay, where) => { if (A.hooks.maybeBackupReminder) A.hooks.maybeBackupReminder(delay, where); },
  });
  Object.assign(A.hooks, { shuttleActive, shuttleSlot, shuttleKeyDown, shuttleKeyUp, shuttlePause });
  for (const [id, view] of Object.entries(A.views)) if (view.mount) view.mount($('#view-' + id));
}

export { core, refreshReader };
