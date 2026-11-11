// 「配列」の画面（VIAL 式の配列エディタ）。
//   - キーを選ぶ（クリック・実際のキー・矢印）→ 下の一覧から文字を選ぶ。キー同士・一覧からキーへのドラッグでも変えられる
//   - 通常の面 / Shift と一緒の面、担当する指、プリセット 4 つと保存枠 5 つ、JSON・AutoHotkey の読み書き、配列分析
// 文字の割り当て・入れ替え・点検・分析の計算は Rust（core）。ここは画面の流れと、元に戻す（undo）。
import { core } from '../core.js';
import { S, bus, BUILTIN_LAYOUT_KEYS, CUSTOM_SLOT_KEYS, selectLayout, loadLayouts, refreshReader, saveLayoutToSlot, isCustomSlot, slotHasData, setSetting, currentWords, currentLang, clone } from '../model.js';
import { $, $$, html, setHtml, act, downloadText } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast, confirmDialog, choiceDialog, openModal } from '../ui/overlay.js';
import { flatKeyboard } from '../ui/flatkb.js';
import { FINGERS } from '../theme.js';
import { playSound } from '../sound.js';
import { pressKey } from '../app.js';

const E = {
  selected: 'KeyD',     // 選んでいるキー
  layer: 'base',        // 'base'（そのまま押したとき）| 'shift'（Shift と一緒に押したとき）
  undo: [],
  saves: 0,             // 保存した回数（保存のあとに戻すと、保存した内容と違うので「未保存」にする）
  active: false,
  applying: false,      // 自分で配列を変えている間（知らせを受けて描き直さない）
  analyzer: 'theory',   // 'theory' | 'live'
  target: 'custom1',    // 「別枠へ保存」の保存先
  theory: { key: '', data: null },
};
const UNDO_MAX = 50;
const SHIFT_CODES = ['ShiftLeft', 'ShiftRight'];
// キーに置ける文字（キーコードの一覧のようにまとめてある）
const PALETTE = [
  { label: '英字', chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('') },
  { label: '記号', chars: ['-', ',', '.', '/', ';', ':', '@', '[', ']', "'", '!', '?', '^', '\\', '=', '`', '¥', '|', '(', ')', '{', '}', '"', '&', '_', '+', '*', '#', '%', '$', '~', '<', '>'] },
  { label: '数字', chars: '1234567890'.split('') },
];
// ローマ字入力に要る文字：英字すべて・長音「ー」(-)・、。(, .)
const REQUIRED = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').concat(['-', ',', '.']));

const slotOf = (code) => S.rows.flat().find((s) => s.code === code) || null;
const isEditable = (code) => { const s = slotOf(code); return Boolean(s && !s.isModifier && S.layout.keys[code]); };
const isSelectable = (code) => { const s = slotOf(code); return Boolean(s && (!s.isModifier || SHIFT_CODES.includes(code)) && S.layout.keys[code]); };
const editableRows = () => S.rows.map((row) => row.filter((s) => !s.isModifier).map((s) => s.code)).filter((row) => row.length);
const qwertyLabel = (code) => { const s = slotOf(code); return s ? s.label : code; };
const shiftCharOf = (key) => key.shiftChar || core.shiftedChar(S.kind, key.char);
const shownChar = (code) => { const k = S.layout.keys[code]; return k ? (E.layer === 'shift' ? shiftCharOf(k) : k.char) : ''; };
const targetName = () => (S.layouts[E.target] && S.layouts[E.target].name) || E.target;

/** 文字 → その文字があるキー（通常の面）。 */
function charUsage() {
  const usage = {};
  for (const row of editableRows()) for (const code of row) {
    const k = S.layout.keys[code];
    const ch = k ? String(k.char || '').toUpperCase() : '';
    if (ch) (usage[ch] = usage[ch] || []).push(code);
  }
  return usage;
}

// ---------- 配列を変える・元に戻す・保存 ----------

function pushUndo() {
  const snap = JSON.stringify({ layout: S.layout, dirty: S.layoutDirty, saved: E.saves });
  if (E.undo.length && E.undo[E.undo.length - 1] === snap) return;
  E.undo.push(snap);
  if (E.undo.length > UNDO_MAX) E.undo.shift();
}

// 今の配列を入れ替える（練習の判定・ガイド・3D の刻印も合わせる）
function applyLayout(layout, dirty = true) {
  E.applying = true;
  S.layout = layout;
  S.layoutDirty = dirty;
  refreshReader();
  bus.emit('layout');
  E.applying = false;
}

function undo() {
  if (!E.undo.length) { toast('これ以上戻せる履歴がありません'); return; }
  const snap = JSON.parse(E.undo.pop());
  applyLayout(snap.layout, snap.saved === E.saves ? Boolean(snap.dirty) : true);
  fixSelection();
  renderAll();
  toast('配列の変更を一つ前に戻しました');
}

function saveToSlot(slotKey) {
  const n = CUSTOM_SLOT_KEYS.indexOf(slotKey) + 1;
  let name = (S.layouts[slotKey] && S.layouts[slotKey].name) || '保存枠 ' + n;
  // プリセットを編集して、名前のない保存枠に入れるとき：元が分かる名前にする
  if (name === '保存枠 ' + n && !isCustomSlot(S.activeLayoutKey)) name = (S.layout.name + '（改）').slice(0, 24);
  const copy = clone(S.layout);
  copy.name = name;
  if (!saveLayoutToSlot(slotKey, copy)) { toast('保存できませんでした（保存容量が不足しているか、このブラウザでは保存できません）'); return; }
  E.undo = [];
  selectLayout(slotKey);
  toast('現在の配列を「' + name + '」に保存しました');
}

/** 保存する。プリセットは上書きしないので、「別枠へ保存」で選んだ保存枠に入れる。 */
async function save(skipConfirm = false) {
  const key = S.activeLayoutKey;
  if (!isCustomSlot(key)) {
    const name = targetName();
    if (!skipConfirm) {
      const ok = await confirmDialog({
        title: '保存枠に保存',
        text: 'プリセット配列「' + S.layout.name + '」は上書きできないため、変更を「' + name + '」に保存し、「' + name + '」の現在の配列は置き換わります（保存先は「現在の配置を別枠へ保存」で選択できます）',
        ok: '「' + name + '」に保存',
      });
      if (!ok) return;
    }
    saveToSlot(E.target);
    return;
  }
  if (!saveLayoutToSlot(key, S.layout)) { toast('保存できませんでした（保存容量が不足しているか、このブラウザでは保存できません）'); return; }
  E.saves++;
  S.layoutDirty = false;
  renderAll();
  toast('「' + S.layout.name + '」を保存しました');
}

async function confirmLeave() {
  if (!S.layoutDirty) return true;
  const custom = isCustomSlot(S.activeLayoutKey);
  const answer = await choiceDialog({
    title: '未保存の変更の確認',
    text: custom
      ? '「' + (S.layout.name || 'カスタム配列') + '」に未保存の変更がありますが、保存しますか？'
      : 'プリセット「' + S.layout.name + '」への変更は未保存で、保存すると「' + targetName() + '」に上書きされますが、保存しますか？',
    choices: [{ key: 'discard', label: '保存せずに移動', kind: 'danger' }, { key: 'save', label: 'はい、保存する', kind: 'primary' }],
  });
  if (answer === 'save') { await save(true); return true; }
  if (answer === 'discard') { E.undo = []; selectLayout(S.activeLayoutKey); return true; }
  return false;
}

async function pickLayout(key) {
  if (key === S.activeLayoutKey || !S.layouts[key]) return;
  if (!(await confirmLeave())) return;
  E.undo = [];
  selectLayout(key);
  toast('「' + S.layout.name + '」を編集対象に切り替えました');
}

async function copyToSlot() {
  const slotKey = E.target;
  if (slotKey === S.activeLayoutKey) { save(); return; }
  if (slotHasData(slotKey)) {
    const ok = await confirmDialog({ title: '別枠へ上書き保存', text: '「' + targetName() + '」の配列を現在の配置で置き換えますが、よろしいですか？', ok: '上書き保存する' });
    if (!ok) return;
  }
  saveToSlot(slotKey);
}

async function resetLayout() {
  const key = S.activeLayoutKey;
  const custom = isCustomSlot(key);
  const ok = await confirmDialog({
    title: '配列初期化の確認',
    text: custom ? '「' + S.layout.name + '」を初期状態（QWERTY）に戻しますか？' : 'プリセット「' + S.layouts[key].name + '」を初期配置に戻しますか？',
    ok: '初期配置に戻す', danger: true,
  });
  if (!ok || key !== S.activeLayoutKey) return;
  E.undo = [];
  if (custom) {
    const n = CUSTOM_SLOT_KEYS.indexOf(key) + 1;
    const fresh = core.presetLayout('qwerty', S.kind);
    fresh.name = '保存枠 ' + n;
    fresh.description = 'ユーザー保存配列 ' + n;
    saveLayoutToSlot(key, fresh);
    selectLayout(key);
    toast('「' + fresh.name + '」を QWERTY の初期配置に戻しました');
  } else {
    selectLayout(key);
    toast('「' + S.layout.name + '」の初期配置に戻しました');
  }
}

// ---------- キーを選ぶ・文字を割り当てる ----------

function fixSelection() {
  if (!isSelectable(E.selected)) E.selected = isSelectable('KeyD') ? 'KeyD' : (editableRows()[0] || [])[0] || 'KeyD';
  if (!isCustomSlot(E.target)) E.target = 'custom1';
}

function select(code) {
  if (!isSelectable(code)) return;
  E.selected = code;
  renderKeyboard();
  renderInspector();
  renderPalette();
}

// 読む順で次・前のキー（端までいったら反対の端へ）
function stepCode(code, dir) {
  const flat = editableRows().flat();
  const i = flat.indexOf(code);
  return i < 0 ? flat[0] : flat[(i + dir + flat.length) % flat.length];
}

// 上・下のキー（だいたい同じ列）
function verticalCode(code, dir) {
  const rows = editableRows();
  const r = rows.findIndex((row) => row.includes(code));
  const target = r < 0 ? null : rows[r + dir];
  return target ? target[Math.min(rows[r].indexOf(code), target.length - 1)] : code;
}

/** 文字をキーに割り当てる。「使用中の文字は入れ替える」がオンなら、その文字があったキーと入れ替わる。 */
function assign(code, ch, { advance = true } = {}) {
  if (!isEditable(code)) return;
  const shiftLayer = E.layer === 'shift';
  const r = core.assignChar(S.layout, S.kind, code, ch, shiftLayer, S.settings.editorSwapOnAssign);
  if (r.result === 'rejected') return;
  if (r.result === 'changed') {
    pushUndo();
    applyLayout(r.layout);
    playSound('key');
    if (r.swappedWith) toast('「' + r.layout.keys[code].char + '」と「' + r.old + '」を入れ替えました（' + qwertyLabel(code) + ' ⇄ ' + qwertyLabel(r.swappedWith) + ' の位置）');
  }
  E.selected = advance && S.settings.editorAutoAdvance ? stepCode(code, 1) : code;
  renderEdited();
}

function swap(codeA, codeB) {
  if (!isEditable(codeA) || !isEditable(codeB) || codeA === codeB) return;
  const shiftLayer = E.layer === 'shift';
  pushUndo();
  const before = [shownChar(codeA), shownChar(codeB)];
  applyLayout(core.swapKeys(S.layout, S.kind, codeA, codeB, shiftLayer));
  E.selected = codeB;
  playSound('key');
  renderEdited();
  toast((shiftLayer ? 'Shift と一緒の文字：' : '') + '「' + before[0] + '」と「' + before[1] + '」を入れ替えました');
}

function setFinger(finger) {
  const key = S.layout.keys[E.selected];
  if (!key || !(finger >= 0 && finger <= 9) || key.finger === finger) return;
  pushUndo();
  const layout = clone(S.layout);
  layout.keys[E.selected].finger = finger;
  applyLayout(layout);
  renderEdited();
}

function clearShift(all) {
  const keys = S.layout.keys;
  const codes = all ? Object.keys(keys).filter((c) => keys[c] && keys[c].shiftChar) : (keys[E.selected] && keys[E.selected].shiftChar ? [E.selected] : []);
  if (!codes.length) { toast(all ? 'Shift と一緒の文字は全て自動です' : 'このキーの Shift の文字は既に自動です'); return; }
  pushUndo();
  const layout = clone(S.layout);
  for (const c of codes) delete layout.keys[c].shiftChar;
  applyLayout(layout);
  renderEdited();
  toast(all ? codes.length + ' 個のキーの Shift と一緒の文字を自動に戻しました' : 'Shift と一緒の文字を自動（「' + shiftCharOf(layout.keys[E.selected]) + '」）に戻しました');
}

// ---------- ファイルの読み書き ----------

function parseLayoutText(text, preferAhk) {
  const rawText = String(text || '').trim();
  // JSON を AHK のタブに貼っても、JSON として読む
  if (!rawText.startsWith('{') && (preferAhk || rawText.includes('::'))) {
    const r = core.parseAhk(rawText, S.kind);
    if (!r.ok) throw new Error(r.error);
    return r.layout;
  }
  const parsed = JSON.parse(rawText);
  return parsed && typeof parsed === 'object' && parsed.keys ? core.ensureLayout(parsed, S.kind) : null;
}

function applyImported(layout, note) {
  if (!layout || !layout.keys) return false;
  pushUndo();
  if (isCustomSlot(S.activeLayoutKey)) layout.name = S.layout.name;
  applyLayout(layout);
  fixSelection();
  renderAll();
  toast(note);
  return true;
}

function importFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 1024 * 1024) { toast('ファイルが大きすぎます（配列のファイルは 1MB までです）'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      if (!applyImported(parseLayoutText(reader.result, file.name.toLowerCase().endsWith('.ahk')), file.name + ' を読み込みました（「保存する」で保存）')) toast('対応していないファイル構造です');
    } catch (err) {
      toast('読み込みエラー: ' + err.message);
    }
    input.value = '';
  };
  reader.onerror = () => { toast('ファイルを読み込めませんでした'); input.value = ''; };
  reader.readAsText(file);
}

function openExport() {
  let format = 'json';
  const m = openModal({
    title: '配列ファイル入出力',
    size: 'l',
    body: html`
      <div class="row wrap"><div class="seg" role="group" aria-label="ファイルの形式">
        <button data-fmt="json" aria-pressed="true">.json</button><button data-fmt="ahk" aria-pressed="false">.ahk</button></div>
        <span class="section-note grow" id="exDesc"></span></div>
      <textarea class="field mono ex-text" id="exText" rows="12" spellcheck="false"></textarea>`,
    foot: html`<button class="btn" data-ex="import">テキストから読み込む</button><span class="grow"></span>
      <button class="btn" data-ex="copy">${icon.copy}コピー</button><button class="btn btn-primary" data-ex="download">${icon.download}ダウンロード</button>`,
  });
  const text = $('#exText', m.root);
  const show = (f) => {
    format = f === 'ahk' ? 'ahk' : 'json';
    for (const b of m.root.querySelectorAll('[data-fmt]')) b.setAttribute('aria-pressed', String(b.dataset.fmt === format));
    $('#exDesc', m.root).textContent = format === 'json'
      ? '標準的な JSON 形式で、保存や再読み込みに使用できます'
      : 'Windows でこの配列をどこでも使える AutoHotkey のスクリプトです（起動したまま練習する場合はキーボード調整を行ってください）';
    text.value = format === 'json' ? JSON.stringify(S.layout, null, 2) : core.generateAhk(S.layout, S.kind);
  };
  m.root.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const fmt = t && t.closest('[data-fmt]');
    const ex = t && t.closest('[data-ex]');
    if (fmt) { show(fmt.dataset.fmt); return; }
    if (!ex) return;
    if (ex.dataset.ex === 'copy') {
      const fallback = () => { text.select(); try { document.execCommand('copy'); toast('クリップボードにコピーしました'); } catch { toast('コピーできなかったため、テキストを選択してコピーしてください'); } };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text.value).then(() => toast('クリップボードにコピーしました'), fallback);
      else fallback();
    } else if (ex.dataset.ex === 'download') {
      const safe = (S.layout.name || 'custom_layout').replace(/[\s\\/:*?"<>|]+/g, '_') || 'custom_layout';
      downloadText(safe + '.' + format, text.value, 'text/plain;charset=utf-8');
      toast(safe + '.' + format + ' をダウンロードしました');
    } else if (ex.dataset.ex === 'import') {
      if (!text.value.trim()) return;
      try {
        if (applyImported(parseLayoutText(text.value, format === 'ahk'), '配列データを適用しました（「保存する」で保存）')) m.close();
        else toast('有効な配列データが見つかりませんでした');
      } catch (err) {
        toast('解析エラー: ' + err.message);
      }
    }
  });
  show('json');
}

// ---------- 骨組み ----------

export const editorView = {
  mount(root) {
    setHtml(root, html`
      <div class="panel glass">
        <div class="panel-head">
          <h1 class="panel-title">配列</h1>
          <span class="chip" id="edNow"></span>
          <span class="grow"></span>
          <span class="chip chip-accent" id="edDirty" hidden>未保存の変更あり</span>
          <button class="btn btn-s btn-teal" data-act="ed.toAnalyze" title="この配列の打ちやすさを数値で確認します">${icon.chart}<span>配列分析</span></button>
          <button class="btn btn-s" data-act="ed.undo" id="edUndo" disabled title="Ctrl+Z でも戻せます">${icon.undo}一つ前に戻る</button>
          <button class="btn btn-s" data-act="ed.save" id="edSave">${icon.save}<span>保存する</span></button>
          <button class="btn btn-s btn-ghost" data-act="nav" data-arg="practice">練習画面へ戻る</button>
        </div>
        <div class="panel-body ed-body">
          <section class="card ed-bar">
            <div class="ed-bar-row"><span class="ed-label" title="プリセット配列は上書きされず、編集した内容は保存枠に保存されます">プリセット</span><div class="ed-chips" id="edPresets"></div></div>
            <div class="ed-bar-row"><span class="ed-label">保存枠</span><div class="ed-chips" id="edSlots"></div><span class="grow"></span><span class="ed-copy" id="edCopy"></span></div>
            <div class="ed-bar-row ed-tools" id="edTools"></div>
          </section>
          <div class="ed-work">
            <div class="ed-kb">
              <div class="ed-legend" id="edLegend"></div>
              <div id="edKeyboard"></div>
              <p class="section-note">キーはクリックか実際のキー入力で選択し、ドラッグで入れ替えられます</p>
            </div>
            <aside class="card ed-inspect" id="edInspect"></aside>
          </div>
          <section class="card ed-palette">
            <div class="ed-card-head">
              <div class="seg" role="group" aria-label="編集する面">
                <button data-act="ed.layer" data-arg="base" aria-pressed="true">通常</button><button data-act="ed.layer" data-arg="shift" aria-pressed="false">Shift と一緒</button></div>
              <h2 class="section-title" id="edLayerLabel">割り当てる文字を選ぶ</h2>
              <span class="row" id="edShiftTools" hidden>
                <button class="btn btn-s" data-act="ed.shiftClear">このキーを自動に戻す</button><button class="btn btn-s" data-act="ed.shiftClearAll">全て自動に戻す</button></span>
              <span class="grow"></span>
              <label class="check"><input type="checkbox" id="edOptAdvance" data-change="ed.optAdvance">割り当てたら次のキーへ進む</label>
              <label class="check" title="オンなら 2 つのキーの文字を入れ替え、オフなら上書きします"><input type="checkbox" id="edOptSwap" data-change="ed.optSwap">使用中の文字は入れ替える</label>
            </div>
            <div class="kc-groups" id="edPalette"></div>
            <div class="ed-health" id="edHealth"></div>
          </section>
          <section class="card ed-analyze" id="edAnalyze">
            <div class="ed-card-head">
              <h2 class="section-title">配列分析</h2><span class="section-note" id="edPulse"></span><span class="grow"></span>
              <div class="seg" role="group" aria-label="分析のもと">
                <button data-act="ed.analyzer" data-arg="theory" aria-pressed="true" title="選択中の練習文をガイドどおりに打った場合の計算値です">理論値</button>
                <button data-act="ed.analyzer" data-arg="live" aria-pressed="false" title="直前の練習で実際に正しく打ったキーの集計です">実測</button></div>
            </div>
            <div class="ed-metrics" id="edMetrics"></div>
          </section>
          <input type="file" id="edFile" accept=".json,.ahk,application/json,text/plain" hidden data-change="ed.file">
        </div>
      </div>`);

    act({
      'ed.pick': (key) => pickLayout(key),
      'ed.undo': () => undo(),
      // 配列分析は、文字の一覧の下にあって見つけにくいので、上のボタンから移れるようにする
      'ed.toAnalyze': () => {
        const box = $('#edAnalyze');
        if (!box) return;
        box.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        box.classList.remove('is-flash'); void box.offsetWidth; box.classList.add('is-flash');
      },
      'ed.save': () => save(),
      'ed.name': (v) => {
        if (!isCustomSlot(S.activeLayoutKey)) return;
        S.layout.name = v.trim() || '保存枠 ' + (CUSTOM_SLOT_KEYS.indexOf(S.activeLayoutKey) + 1);
        S.layoutDirty = true;
        refreshHead();
        renderBar();
      },
      'ed.nameReset': () => {
        if (!isCustomSlot(S.activeLayoutKey)) return;
        pushUndo();
        const name = '保存枠 ' + (CUSTOM_SLOT_KEYS.indexOf(S.activeLayoutKey) + 1);
        S.layout.name = name;
        S.layoutDirty = true;
        renderAll();
        toast('配列名を「' + name + '」に戻しました（「保存する」で確定）');
      },
      'ed.reset': () => resetLayout(),
      'ed.import': () => $('#edFile').click(),
      'ed.file': (_, node) => importFile(node),
      'ed.export': () => openExport(),
      'ed.target': (v) => { if (isCustomSlot(v)) E.target = v; },
      'ed.copy': () => copyToSlot(),
      'ed.layer': (v) => { E.layer = v === 'shift' ? 'shift' : 'base'; renderEdited(); },
      'ed.finger': (i) => setFinger(Number(i)),
      'ed.optAdvance': (v) => setSetting('editorAutoAdvance', v === 'true'),
      'ed.optSwap': (v) => setSetting('editorSwapOnAssign', v === 'true'),
      'ed.shiftClear': () => clearShift(false),
      'ed.shiftClearAll': () => clearShift(true),
      'ed.analyzer': (v) => { E.analyzer = v === 'live' ? 'live' : 'theory'; renderAnalyzer(); },
    });

    // 名前の欄：入ったときの状態を戻り先にし、出たときに保存される名前を見せる
    root.addEventListener('focusin', (e) => { if (e.target instanceof Element && e.target.id === 'edName') pushUndo(); });
    root.addEventListener('focusout', (e) => { const t = e.target; if (t instanceof HTMLInputElement && t.id === 'edName' && t.value !== S.layout.name) t.value = S.layout.name; });
    wirePointer(root);

    // 配列・キーボードの種類・練習文が、ほかの場所で変わったとき
    bus.on('layout', () => { if (E.active && !E.applying) { fixSelection(); renderAll(); } });
    bus.on('settings', (key) => { if (E.active && key === 'showQwertySub') renderKeyboard(); });
    // 別のウィンドウで保存枠が保存されたとき
    bus.on('storage', (key) => {
      if (key !== null && !/^typecraft_qwerty_base_custom[1-5]$/.test(key)) return;
      const mine = isCustomSlot(S.activeLayoutKey) && (key === null || key.endsWith(S.activeLayoutKey));
      const name = S.layout.name;
      // 保存枠を読み直す（編集中の配列 S.layout は、そのまま残る）
      loadLayouts();
      if (S.layoutDirty && mine) toast('別のウィンドウで配列「' + name + '」が保存されたため、ここで保存するとその変更は上書きされます');
      else if (mine) selectLayout(S.activeLayoutKey);
      else if (E.active) renderBar();
    });
  },

  enter() { E.active = true; fixSelection(); renderAll(); },
  leave() { E.active = false; },
  dirty: () => S.layoutDirty,
  confirmLeave,
  undo(e) {
    if (e.target instanceof Element && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return false;
    e.preventDefault();
    undo();
    return true;
  },
  keyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const arrows = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 };
    if (e.key in arrows) {
      e.preventDefault();
      const base = isEditable(E.selected) ? E.selected : 'KeyD';
      select(e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? stepCode(base, arrows[e.key]) : verticalCode(base, arrows[e.key]));
      return;
    }
    // 実際のキーを押すと、その位置を選ぶ（手さぐりでキーを探せる。Shift も）
    const physical = S.reader ? S.reader.physicalCode(e) : null;
    if (!physical || !isSelectable(physical)) return;
    e.preventDefault();
    if (e.repeat) return;
    select(physical);
    pressKey(e, physical, 'neutral');
  },
};

// キーと一覧の文字：クリックで選ぶ・割り当てる、ドラッグで入れ替える・割り当てる（マウスでも指でも）
function wirePointer(root) {
  root.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target.closest('.fk-key[data-code], .kc-chip') : null;
    if (!t || !root.contains(t)) return;
    if (e.detail > 0) t.blur();
    if (t.classList.contains('kc-chip')) assign(E.selected, t.dataset.char);
    else select(t.dataset.code);
  });
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const t = e.target instanceof Element ? e.target.closest('.fk-key[data-code], .kc-chip') : null;
    if (!t || !root.contains(t)) return;
    const from = t.classList.contains('kc-chip') ? { ch: t.dataset.char } : { code: t.dataset.code };
    if (from.code && !isEditable(from.code)) return;
    const x0 = e.clientX, y0 = e.clientY;
    let ghost = null, over = null;
    const move = (ev) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        ghost = document.createElement('div');
        ghost.className = 'ed-ghost';
        ghost.textContent = from.ch || shownChar(from.code);
        document.body.appendChild(ghost);
        document.body.classList.add('is-sorting');
      }
      ev.preventDefault();
      ghost.style.left = ev.clientX + 'px';
      ghost.style.top = ev.clientY + 'px';
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const key = under ? under.closest('.fk-key[data-code]') : null;
      const ok = key && isEditable(key.dataset.code) && key.dataset.code !== from.code ? key : null;
      if (over !== ok) { if (over) over.classList.remove('is-over'); over = ok; if (over) over.classList.add('is-over'); }
    };
    const end = (commit) => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove('is-sorting');
      // ドラッグのあとの「クリック」で、キーが選ばれたり文字が割り当てられたりしないようにする
      const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener('click', stop, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', stop, true), 0);
      const target = over ? over.dataset.code : null;
      if (over) over.classList.remove('is-over');
      if (!commit || !target) return;
      if (from.ch) assign(target, from.ch, { advance: false });
      else swap(from.code, target);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
  });
}

// ---------- 描く ----------

function renderAll() {
  refreshHead();
  renderBar();
  renderTools();
  setHtml('#edLegend', FINGERS.filter((_, i) => i !== 4 && i !== 5).map((f) => html`<span class="ed-finger-chip" style="--fc:${f.color}"><i></i>${f.name}</span>`));
  $('#edOptAdvance').checked = Boolean(S.settings.editorAutoAdvance);
  $('#edOptSwap').checked = Boolean(S.settings.editorSwapOnAssign);
  renderEdited();
}

// 配列の中身が変わったあと
function renderEdited() {
  refreshHead();
  renderBar();
  renderKeyboard();
  renderInspector();
  renderPalette();
  renderHealth();
  scheduleAnalyzer();
}

function refreshHead() {
  const custom = isCustomSlot(S.activeLayoutKey);
  $('#edNow').textContent = '編集中：' + S.layout.name;
  $('#edDirty').hidden = !S.layoutDirty;
  $('#edUndo').disabled = !E.undo.length;
  const saveBtn = $('#edSave');
  saveBtn.classList.toggle('btn-primary', S.layoutDirty);
  saveBtn.querySelector('span').textContent = custom ? '保存する' : '保存枠に保存';
}

function renderBar() {
  const chip = (key, lock) => {
    const current = key === S.activeLayoutKey;
    const name = current ? S.layout.name : S.layouts[key].name;
    return html`<button class="ed-slot ${lock ? 'is-preset' : ''}" data-act="ed.pick" data-arg="${key}" aria-pressed="${String(current)}" title="${lock ? 'プリセット（上書きされません）' : ''}">
      ${lock ? icon.lock : ''}<span>${name}</span>${current ? html`<em>${S.layoutDirty ? '未保存' : '選択中'}</em>` : ''}</button>`;
  };
  setHtml('#edPresets', BUILTIN_LAYOUT_KEYS.map((k) => chip(k, true)));
  setHtml('#edSlots', CUSTOM_SLOT_KEYS.map((k) => chip(k, false)));
  for (const o of $$('#edTarget option')) o.textContent = S.layouts[o.value] ? (o.value === S.activeLayoutKey ? S.layout.name : S.layouts[o.value].name) : o.value;
}

function renderTools() {
  const custom = isCustomSlot(S.activeLayoutKey);
  setHtml('#edTools', html`
    ${custom
      ? html`<label class="ed-name">配列の名前<input class="field" id="edName" type="text" maxlength="24" value="${S.layout.name}" data-input="ed.name" autocomplete="off"></label>
          <button class="btn btn-s btn-ghost" data-act="ed.nameReset">名前を初期に戻す</button>`
      : html`<p class="section-note ed-preset-note">プリセットは上書きされず、変更内容は保存枠に保存されます</p>`}
    <span class="grow"></span>
    <button class="btn btn-s" data-act="ed.import">${icon.upload}ファイル読み込み（.json / .ahk）</button>
    <button class="btn btn-s" data-act="ed.export">${icon.download}ファイル出力</button>
    <button class="btn btn-s btn-danger" data-act="ed.reset">初期配置に戻す</button>`);
  setHtml('#edCopy', html`<span class="ed-label">現在の配置を別枠へ保存</span>
    <select class="field" id="edTarget" data-change="ed.target" aria-label="保存先の保存枠">${CUSTOM_SLOT_KEYS.map((k) => html`<option value="${k}" ${k === E.target ? html`selected` : ''}>${S.layouts[k].name}</option>`)}</select>
    <button class="btn btn-s" data-act="ed.copy">別枠へ上書き保存</button>`);
}

function renderKeyboard() {
  const usage = charUsage();
  const shiftLayer = E.layer === 'shift';
  setHtml('#edKeyboard', flatKeyboard(S.kind, (code) => {
    const slot = slotOf(code);
    const key = S.layout.keys[code];
    if (!slot) return null;
    if (code === 'Space') return { cls: 'fk-mod', body: 'space', disabled: true };
    const finger = FINGERS[key ? key.finger : slot.finger] || FINGERS[0];
    const selected = code === E.selected ? ' is-selected' : '';
    if (SHIFT_CODES.includes(code)) return { cls: 'fk-mod fk-finger' + selected, style: '--fc:' + finger.color, body: 'Shift', title: 'Shift（担当する指を変えられます）' };
    if (!key) return null;
    const ch = String(key.char || '');
    const dup = !shiftLayer && (usage[ch.toUpperCase()] || []).length > 1;
    return {
      cls: 'fk-finger' + selected + (shiftLayer && !key.shiftChar ? ' is-auto' : ''),
      style: '--fc:' + finger.color,
      title: dup ? '「' + ch + '」は ' + usage[ch.toUpperCase()].length + ' つのキーに割り当てられています' : '',
      body: html`${S.settings.showQwertySub && ch.toUpperCase() !== String(slot.label).toUpperCase() ? html`<span class="fk-sub">${slot.label}</span>` : ''}
        ${!shiftLayer && key.shiftChar ? html`<span class="fk-shift">⇧${key.shiftChar}</span>` : ''}
        <span class="fk-main">${shiftLayer ? shiftCharOf(key) : ch}</span>${dup ? html`<i class="fk-dup"></i>` : ''}${slot.homeBump ? html`<i class="fk-bump"></i>` : ''}`,
    };
  }));
  $('#edKeyboard').classList.toggle('is-shift', shiftLayer);
}

function renderInspector() {
  const code = E.selected;
  const key = S.layout.keys[code];
  if (!key) { setHtml('#edInspect', ''); return; }
  const isShift = SHIFT_CODES.includes(code);
  const finger = FINGERS[key.finger] || FINGERS[0];
  const sh = isShift ? '' : shiftCharOf(key);
  const line = isShift
    ? 'Shift キーで、ガイドではこの指を光らせます（' + finger.name + '）'
    : 'このキーを押すと「' + key.char + '」' + (sh !== key.char || key.shiftChar ? '、Shift と一緒なら「' + sh + '」' + (key.shiftChar ? '（Shift と一緒の面で設定）' : '') : '') + 'を入力します（' + finger.name + '）';
  setHtml('#edInspect', html`
    <div class="ed-ins-top">
      <div class="ed-preview" style="--fc:${finger.color}">${isShift ? '⇧' : shownChar(code)}</div>
      <div><b>${isShift ? (code === 'ShiftLeft' ? '左 Shift' : '右 Shift') : 'QWERTY の ' + qwertyLabel(code) + ' の位置'}</b><p>${line}</p></div>
    </div>
    <div class="ed-label">担当指</div>
    <div class="ed-fingers">${FINGERS.map((f, i) => html`<button data-act="ed.finger" data-arg="${i}" aria-pressed="${String(i === key.finger)}" style="--fc:${f.color}" title="${f.name}">${f.short}</button>`)}</div>`);
}

function renderPalette() {
  for (const b of $$('[data-act="ed.layer"]')) b.setAttribute('aria-pressed', String(b.dataset.arg === E.layer));
  $('#edShiftTools').hidden = E.layer !== 'shift';
  $('#edLayerLabel').textContent = E.layer === 'shift' ? 'Shift と一緒に押したときの文字を選ぶ' : '割り当てる文字を選ぶ';
  if (SHIFT_CODES.includes(E.selected)) {
    setHtml('#edPalette', html`<p class="section-note">Shift キーには文字を割り当てられませんが、上で担当指を変更できます</p>`);
    return;
  }
  const usage = charUsage();
  const reach = S.reach;
  const selected = S.layout.keys[E.selected];
  const selectedChar = selected ? String(E.layer === 'shift' ? shiftCharOf(selected) : selected.char).toUpperCase() : '';
  // 配列にあって、一覧にない文字（読み込んだファイルの文字など）
  const listed = new Set(PALETTE.flatMap((g) => g.chars));
  const extra = Object.keys(usage).filter((ch) => !listed.has(ch));
  const groups = extra.length ? PALETTE.concat([{ label: 'その他', chars: extra }]) : PALETTE;
  setHtml('#edPalette', groups.map((group) => html`<div class="kc-group"><span class="ed-label">${group.label}</span><div class="kc-chips">${group.chars.map((ch) => {
    const where = usage[ch] || [];
    const via = !where.length && reach[ch] ? reach[ch] : null;
    let cls = '', title;
    if (ch === selectedChar) { cls = 'is-current'; title = E.layer === 'shift' ? '選択中のキーを Shift と一緒に押したときの文字' : '選択中のキーの文字'; }
    else if (!where.length) {
      const missing = REQUIRED.has(ch) && !via;
      cls = missing ? 'is-missing' : via ? 'is-shift' : 'is-unused';
      title = missing ? '未配置（ローマ字入力に必要な文字）' : via ? '未配置（' + (via.shift ? 'Shift + ' : '') + qwertyLabel(via.code) + ' の位置で打てます）' : '未配置';
    } else title = 'QWERTY の ' + where.map(qwertyLabel).join(' / ') + ' の位置に配置済み';
    const whereLabel = where.length ? qwertyLabel(where[0]) + (where.length > 1 ? '+' : '') : via ? (via.shift ? '⇧' : '') + qwertyLabel(via.code) : '';
    return html`<button class="kc-chip ${cls} ${where.length > 1 ? 'is-dup' : ''}" data-char="${ch}" title="${title}">${ch}${whereLabel ? html`<span>${whereLabel}</span>` : ''}</button>`;
  })}</div></div>`));
}

function renderHealth() {
  const h = core.layoutHealth(S.layout, S.kind);
  const node = $('#edHealth');
  const warn = h.missing.length || h.duplicates.length;
  node.classList.toggle('is-warn', Boolean(warn));
  setHtml(node, warn
    ? html`${h.missing.length ? html`<p>${icon.warn}未配置の文字：<code>${h.missing.join(' ')}</code>（この文字は入力できません）</p>` : ''}
        ${h.duplicates.length ? html`<p>${icon.info}複数のキーにある文字：${h.duplicates.map(([ch, codes], i) => html`${i ? '、' : ''}<code>${ch}</code>（${codes.map(qwertyLabel).join('、')} の位置）`)}（ガイドは最初のキーを光らせます）</p>` : ''}`
    : html`<p>${icon.check}ローマ字入力に必要な文字（A〜Z、ー、、。）が揃っています</p>`);
}

// ---------- 配列分析 ----------

let analyzerTimer = 0;
function scheduleAnalyzer() {
  clearTimeout(analyzerTimer);
  analyzerTimer = setTimeout(renderAnalyzer, 120);
}

function theoryData() {
  // 配列・練習文・ローマ字方式が実際に変わったときだけ計算し直す
  const key = JSON.stringify([S.layout, currentWords(), S.romajiStyle, currentLang(), S.kind]);
  if (E.theory.key !== key) E.theory = { key, data: core.theoreticalTelemetry(S.layout, S.kind, currentWords(), S.romajiStyle, currentLang() === 'en') };
  return E.theory.data;
}

function renderAnalyzer() {
  if (!E.active) return;
  for (const b of $$('[data-act="ed.analyzer"]')) b.setAttribute('aria-pressed', String(b.dataset.arg === E.analyzer));
  const live = E.analyzer === 'live';
  const data = live ? (S.liveTelemetry ? S.liveTelemetry.data : null) : theoryData();
  const empty = { totalHits: 0, rowHits: [0, 0, 0, 0], leftHandHits: 0, rightHandHits: 0, pairs: 0, alternationCount: 0, sameFingerCount: 0, sameKeyCount: 0, skippedChars: {} };
  const d = data || empty;
  const total = d.totalHits, pairs = d.pairs;
  const pct = (n, of) => (of > 0 ? (n / of) * 100 : 0);
  let pulse;
  if (live) pulse = data ? '実測 ' + total + ' 打鍵（直前の練習で正しく打ったキーのみ・' + S.liveTelemetry.layoutName + '）' : 'まだ実測がありません（練習すると、ここに集計が表示されます）';
  else {
    pulse = '理論値・' + (currentLang() === 'en' ? '英文' : S.romajiStyle === 'nihon' ? '日本式' : 'ヘボン式') + '（' + total + ' 打鍵）';
    const skipped = Object.keys(d.skippedChars || {});
    if (skipped.length) pulse += '・配列にない文字 ' + skipped.join(' ') + ' を除外';
  }
  $('#edPulse').textContent = pulse;
  const home = pct(d.rowHits[2], total);
  const left = total > 0 ? pct(d.leftHandHits, total) : 50, right = total > 0 ? pct(d.rightHandHits, total) : 50;
  const alt = pct(d.alternationCount, pairs), same = pct(d.sameFingerCount, pairs);
  const bar = (v, cls = '') => html`<div class="ed-meter ${cls}"><i style="width:${Math.max(0, Math.min(100, v)).toFixed(1)}%"></i></div>`;
  setHtml('#edMetrics', html`
    <div class="ed-metric"><span>ホーム段の使用率</span><b class="num">${home.toFixed(1)}<em>%</em></b>${bar(home)}
      <small>${d.rowHits[0] > 0 ? '数字段 ' + pct(d.rowHits[0], total).toFixed(1) + '% / ' : ''}上段 ${pct(d.rowHits[1], total).toFixed(1)}% / 中段 ${home.toFixed(1)}% / 下段 ${pct(d.rowHits[3], total).toFixed(1)}%</small></div>
    <div class="ed-metric"><span>左右の手のバランス</span><b class="num">${Math.round(left)}<em> : </em>${Math.round(right)}</b>
      <div class="ed-meter is-split"><i style="width:${left.toFixed(1)}%"></i><i style="width:${right.toFixed(1)}%"></i></div>
      <small>左手 ${left.toFixed(1)}% / 右手 ${right.toFixed(1)}%</small></div>
    <div class="ed-metric"><span>左右交互打鍵率</span><b class="num">${alt.toFixed(1)}<em>%</em></b>${bar(alt)}<small>交互打鍵 ${d.alternationCount} / ${pairs} 回</small></div>
    <div class="ed-metric"><span>同じ指の連続率</span><b class="num">${same.toFixed(1)}<em>%</em></b>${bar(same * 3, 'is-low')}
      <small title="同じ指で別のキーを続けて打った回数です">同指連続 ${d.sameFingerCount} / ${pairs} 回・低いほど快適</small></div>`);
}
