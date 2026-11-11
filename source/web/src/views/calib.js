// 「キーボード調整」と「追加のキー」のダイアログ。
//   キーボード調整：キーボード本体（VIAL / QMK）や AutoHotkey などでキーの並びを変えている人向け。光る位置のキーを順に押してもらい、
//     「届いた信号 → キーの位置」の表を作る。Shift と一緒に押したときだけ別の信号を送るキーボード向けに、Shift の調整もある。
//   追加のキー：数字・記号・Shift をレイヤーや別のキーから打つ人向け。表示されたキーを実際に打ってもらい、その信号を覚える。
// 流れと文は旧版（v5.4.5）と同じ。信号の作り方と、保存したものの読み取りは Rust（core の KeyReader）。
import { core } from '../core.js';
import { S, bus, saveCalibration, saveExtraKeys, reloadInputTables, refreshReader } from '../model.js';
import { K } from '../store.js';
import { $, html, setHtml, act } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openModal, toast, banner, closeBanner } from '../ui/overlay.js';
import { flatKeyboard } from '../ui/flatkb.js';
import { practiceScreen, pause as pausePractice, clearVirtualShift } from './practice.js';

const SHIFT_ROLE = '@shift';
const SHIFTED = '+Shift';
const SHIFT_CODES = ['ShiftLeft', 'ShiftRight'];
// 調整では読み取らないキー（修飾キーなど）。Esc・Backspace は読み取る（文字の位置から送るキーボードがあるため）
const CALIB_IGNORED_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Enter', 'NumLock', 'Fn'];
// 練習の操作に使うので、追加のキーにはできないキー
const EXTRA_BLOCKED_KEYS = ['Escape', 'Enter', 'Tab', 'Backspace'];
const EXTRA_MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'NumLock', 'Fn', 'Process', 'Dead'];

let dlg = null;      // 開いているダイアログ（調整か追加のキーの、どちらか 1 つ）
let run = null;      // 調整の途中：{shift, order, idx, map: 信号 → 位置, byCode: 位置 → 信号, skipped}
let extra = null;    // 追加のキーの途中：{queue, idx, pending}

// ---------- 小さな道具 ----------

const slotOf = (code) => S.rows.flat().find((s) => s.code === code) || null;
const isCharSlot = (code) => { const s = slotOf(code); return Boolean(s && !s.isModifier); };
const qwertyLabel = (code) => { const s = slotOf(code); return s ? s.label : code; };
/** 文字のキーの位置（Shift・スペースをのぞく）を、画面の左上から順に。 */
const charCodes = () => S.rows.flatMap((row) => row.filter((s) => !s.isModifier).map((s) => s.code));
const signalOf = (e, withShift) => core.keySignalOf(e.code || '', e.key || '', Boolean(e.shiftKey), withShift);
const signalLabel = (sig) => String(sig).replace(/^key:/, '').replace(/\+Shift$/, ' + Shift');
const isShiftedTarget = (t) => typeof t === 'string' && t.endsWith(SHIFTED);
const targetCodeOf = (t) => (isShiftedTarget(t) ? t.slice(0, -SHIFTED.length) : t);
const shiftCharOf = (key) => (key ? (typeof key.shiftChar === 'string' && key.shiftChar ? key.shiftChar : core.shiftedChar(S.kind, String(key.char || ''))) : '');
const calibration = () => (S.reader ? S.reader.calibration() : null);
const extraMap = () => (S.reader ? S.reader.extraKeys() : {});

function pauseIfTyping() { if (practiceScreen() === 'typing') pausePractice(); }

function closeDialog() {
  if (dlg) dlg.close();
}

function openDialog(o) {
  closeDialog();
  pauseIfTyping();
  dlg = openModal({
    ...o, size: 'l', foot: ' ', keepOnBackdrop: true,
    onClose: () => { dlg = null; run = null; extra = null; },
  });
  dlg.foot = $('.modal-foot', dlg.root);
  dlg.root.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-c]') : null;
    if (!b || b.getAttribute('aria-disabled') === 'true') return;
    // マウスで押したボタンにフォーカスが残ると、このあと押すキー（Space・Enter）でもう一度押されてしまう
    if (e.detail > 0 && b.blur) b.blur();
    o.onAction(b.dataset.c, b);
  });
  return dlg;
}

/** フォーカスのあるボタンを Enter・Space で押せるようにする（どちらも、調整や登録では読み取らないキー）。 */
const pressingButton = (e) => (e.key === 'Enter' || e.code === 'Space' || e.key === ' ') && e.target instanceof Element && Boolean(e.target.closest('button[data-c], [data-modal-close]'));

// ---------- キーボード調整：はじめの画面 ----------

function statusText() {
  const cal = calibration();
  if (!cal) return '未調整（届いた信号をそのまま使用しています）';
  const d = new Date(Math.max(cal.at || 0, cal.shiftAt || 0) || Date.now());
  const shiftN = Object.keys(cal.shiftMap).length;
  // 句点は使わず、「、」でつなぐ
  return [
    d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' に調整済み',
    cal.remapped ? cal.remapped + ' 個のキーを読み替え中' : 'キーの位置はそのまま使用',
    cal.skipped.length ? '飛ばしたキーが ' + cal.skipped.length + ' 個' : '',
    shiftN ? 'Shift 併用時に ' + shiftN + ' 個のキーを読み替え中' : '',
  ].filter(Boolean).join('、');
}

function renderIntro() {
  if (!dlg) return;
  run = null;
  const cal = calibration();
  setHtml(dlg.body, html`
    <p>キーボード本体や AutoHotkey で配列を変更していると、二重に変換されてしまいます</p>
    <p>光る<strong>位置</strong>のキーを順に押すと、どの位置からどの信号が届くかを記憶して正しく読み取ります<br>キーボード側の設定は変更しなくて問題ありません</p>
    <p class="section-note">OS の配列設定は影響せず、キーボードを替えた場合は再度調整してください</p>
    <div class="cal-status ${cal ? 'is-on' : ''}" id="calStatus">${cal ? icon.check : icon.info}<span>${statusText()}</span></div>
    <p class="section-note">数字や記号のみをレイヤーから入力するなら、<button class="btn-link" data-c="extra">追加のキー</button>で十分です</p>
    <p class="section-note">「Shift も調整する」は、Shift と一緒に押すと別のキーを送信するキーボードで使います</p>`);
  setHtml(dlg.foot, html`
    ${cal ? html`<button class="btn btn-danger" data-c="clear">調整を解除</button>` : ''}<span class="grow"></span>
    <button class="btn" data-modal-close>閉じる</button>
    <button class="btn" data-c="startShift" title="キーボード側で Shift 併用時の動作を変更している場合に使います">Shift も調整する（任意）</button>
    <button class="btn btn-primary" data-c="start">調整を始める</button>`);
}

// ---------- キーボード調整：キーを順に押す ----------

function startRun(shift) {
  run = { shift, order: charCodes(), idx: 0, map: {}, byCode: {}, skipped: {} };
  // 開いたときにフォーカスのあるボタン（閉じる）が、このあと押すキーで押されないようにする
  if (document.activeElement instanceof HTMLElement && dlg && dlg.root.contains(document.activeElement)) document.activeElement.blur();
  renderRun('');
}

function renderRun(message) {
  if (!dlg || !run) return;
  const current = run.order[run.idx];
  setHtml(dlg.body, html`
    <div class="cal-head">
      <p class="cal-title">${run.shift ? html`<strong>Shift を押したまま</strong>、` : ''}光っている<strong>位置</strong>にあるキーを押してください</p>
      <span class="num muted" id="calProgress">${Math.min(run.idx + 1, run.order.length)} / ${run.order.length}</span>
    </div>
    <p class="section-note">キーの文字ではなく位置で選んでください（文字は QWERTY での目印です）</p>
    <div class="cal-kb" id="calKeyboard">${flatKeyboard(S.kind, (code) => {
      const slot = slotOf(code);
      if (!slot) return null;
      if (slot.isModifier) return { cls: 'fk-mod', body: 'Shift', disabled: true };
      const cls = code === current ? 'is-current' : run.byCode[code] ? 'is-done' : run.skipped[code] ? 'is-skipped' : '';
      return { cls, body: slot.label, disabled: true };
    }, { rows: 4 })}</div>
    <div class="cal-message" id="calMessage" role="status">${message || ''}</div>
    <p class="section-note">Esc と Backspace もキーとして読み取るため、戻る・中止はボタンで操作してください</p>`);
  setHtml(dlg.foot, html`
    <button class="btn" data-c="back" ${run.idx === 0 ? html`aria-disabled="true"` : ''}>1つ戻る</button>
    <button class="btn" data-c="skip">このキーはない（飛ばす）</button><span class="grow"></span>
    <button class="btn" data-c="cancel">中止</button>`);
}

function forgetEntry(code) {
  const sig = run.byCode[code];
  if (sig) { delete run.map[sig]; delete run.byCode[code]; }
  delete run.skipped[code];
}

function advance() {
  run.idx++;
  if (run.idx >= run.order.length) { if (run.shift) finishShift(); else finishPositions(); } else renderRun('');
}

/** Shift なしで、その位置が送る信号（キーの位置の調整のあと）。 */
function plainSignalOfPosition(code) {
  const cal = calibration();
  if (cal) {
    const sig = Object.keys(cal.map).find((s) => cal.map[s] === code && !s.endsWith(SHIFTED));
    if (sig) return sig;
  }
  return code;
}

/** Shift なしの信号が、どの位置として読まれるか。 */
function plainPositionOfSignal(sig) {
  const cal = calibration();
  if (cal && cal.map[sig]) return cal.map[sig];
  return isCharSlot(sig) ? sig : null;
}

function shiftRunKey(e) {
  const code = run.order[run.idx];
  const sig = signalOf(e, true);
  if (!e.shiftKey && sig === plainSignalOfPosition(code)) { renderRun('Shift を押したまま光っている位置のキーを押してください'); return; }
  const owner = run.map[sig];
  if (owner && owner !== code) {
    renderRun('このキーは「' + qwertyLabel(owner) + '」の位置（Shift あり）と同じ信号だったため、光っている位置をもう一度押すか「1つ戻る」で修正してください');
    return;
  }
  const other = e.shiftKey ? null : plainPositionOfSignal(sig);
  if (other && other !== code) {
    renderRun('Shift と一緒に押すと「' + qwertyLabel(other) + '」の位置を Shift なしで押したときと同じ信号が届き区別できないため、キーボード側の設定を見直すか「このキーはない（飛ばす）」で飛ばしてください');
    return;
  }
  forgetEntry(code);
  run.map[sig] = code;
  run.byCode[code] = sig;
  advance();
}

/** 調整の途中のキー。 @returns {boolean} 受け取ったか（true なら、Esc でもダイアログを閉じない） */
function runKeyDown(e) {
  if (!run) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  if (e.key === 'Tab' || pressingButton(e)) return true;   // Tab でボタンへ動き、Enter・Space で押せる
  e.preventDefault();
  if (e.repeat) return true;
  if (CALIB_IGNORED_KEYS.includes(e.key) || e.code === 'Space' || e.key === ' ') return true;
  if (run.shift) { shiftRunKey(e); return true; }
  const code = run.order[run.idx];
  let sig = signalOf(e, false);
  const owner = run.map[sig];
  if (owner && owner !== code) {
    // 前のキーと同じ信号：Shift がちがうときだけ見分けられる
    const shifted = signalOf(e, true);
    if (e.shiftKey && !run.map[shifted]) sig = shifted;
    else {
      renderRun('このキーは「' + qwertyLabel(owner) + '」の位置と同じ信号だったため、光っている位置をもう一度押すか「1つ戻る」で修正してください');
      return true;
    }
  }
  forgetEntry(code);
  run.map[sig] = code;
  run.byCode[code] = sig;
  advance();
  return true;
}

// ---------- キーボード調整：終わり ----------

function finishPositions() {
  const map = run.map;
  const remapped = Object.keys(map).filter((sig) => sig !== map[sig]).length;
  const skipped = Object.keys(run.skipped);
  // 前にした Shift の調整は残す
  const prev = calibration();
  const shiftMap = prev ? prev.shiftMap : {};
  const shiftAt = prev ? prev.shiftAt || 0 : 0;
  const keepShift = Object.keys(shiftMap).length > 0;
  let text;
  if (remapped === 0) {
    // 標準どおりの信号：直すものがないので、表は持たない
    saveCalibration(keepShift ? { map: {}, at: Date.now(), remapped: 0, skipped: [], shiftMap, shiftAt } : null);
    text = '全てのキーが通常の信号だったため、調整なしで使用します';
  } else {
    saveCalibration({ map, at: Date.now(), remapped, skipped, shiftMap, shiftAt });
    text = remapped + ' 個のキーで信号と位置が異なっていたため、今後は押したキーの位置を正しく読み取ります'
      + (skipped.length ? '　飛ばしたキー（' + skipped.map(qwertyLabel).join(' ') + '）は位置として使用しません' : '');
  }
  if (keepShift) text += '　以前の Shift の調整はそのまま使用します';
  closeBanner('hint');
  renderDone(text, remapped > 0);
}

function finishShift() {
  const shiftMap = {};
  for (const sig of Object.keys(run.map)) {
    const code = run.map[sig];
    if (sig !== plainSignalOfPosition(code) + SHIFTED) shiftMap[sig] = code;   // 「同じキー＋Shift」でないものだけ残す
  }
  const n = Object.keys(shiftMap).length;
  const skipped = Object.keys(run.skipped);
  const prev = calibration();
  const cal = prev ? { map: prev.map, at: prev.at, remapped: prev.remapped, skipped: prev.skipped } : { map: {}, at: 0, remapped: 0, skipped: [] };
  cal.shiftMap = shiftMap;
  cal.shiftAt = Date.now();
  const text = (n
    ? n + ' 個のキーで Shift 併用時に別の信号が届いていました（'
      + Object.keys(shiftMap).map((sig) => qwertyLabel(shiftMap[sig]) + '：' + signalLabel(sig)).join('、')
      + '）　今後はその位置を Shift と一緒に押したものとして読み取ります'
    : 'Shift と一緒でも全て通常の信号だったため、読み替えは不要です')
    + (skipped.length ? '　飛ばしたキー（' + skipped.map(qwertyLabel).join(' ') + '）は読み替えません' : '');
  saveCalibration(Object.keys(cal.map).length || n ? cal : null);
  renderDone(text, n > 0);
}

function renderDone(text, changed) {
  run = null;
  if (!dlg) return;
  setHtml(dlg.body, html`<div class="cal-done ${changed ? 'is-on' : ''}">${changed ? icon.check : icon.info}<p id="calDoneText">${text}</p></div>`);
  setHtml(dlg.foot, html`
    <button class="btn" data-c="start">キーの位置をやり直す</button>
    <button class="btn" data-c="startShift">Shift も調整する（任意）</button><span class="grow"></span>
    <button class="btn btn-primary" data-modal-close>閉じる</button>`);
}

/** キーボード調整を開く。start：説明を飛ばして、すぐキーを押してもらう（チュートリアルから）。 */
export function openCalibration({ start = false } = {}) {
  openDialog({
    title: 'キーボード調整（キャリブレーション）',
    id: 'calib',
    body: '',
    onKey: runKeyDown,
    onAction: (kind) => {
      if (kind === 'start') startRun(false);
      else if (kind === 'startShift') startRun(true);
      else if (kind === 'clear') { saveCalibration(null); renderIntro(); toast('キーボード調整を解除しました'); }
      else if (kind === 'extra') openExtraKeys();
      else if (kind === 'cancel') renderIntro();
      else if (kind === 'skip' && run) { const code = run.order[run.idx]; forgetEntry(code); run.skipped[code] = true; advance(); }
      else if (kind === 'back' && run && run.idx > 0) { run.idx--; forgetEntry(run.order[run.idx]); renderRun(''); }
    },
  });
  if (start) startRun(false); else renderIntro();
}

// ---------- 追加のキー ----------

/** その位置のキーが、今の配列で打つ文字（案内に出す）。 */
function targetLabel(target) {
  if (target === SHIFT_ROLE) return 'Shift';
  const code = targetCodeOf(target);
  const k = S.layout.keys[code];
  const base = k && k.char ? String(k.char) : qwertyLabel(code);
  return isShiftedTarget(target) ? (k ? shiftCharOf(k) : core.shiftedChar(S.kind, base)) : base;
}

/** ふつうのキーボードでの場所（案内に出す）。 */
function targetWhere(target) {
  if (target === SHIFT_ROLE) return 'Shift キー';
  const where = 'QWERTY の ' + qwertyLabel(targetCodeOf(target)) + ' の位置のキー';
  return isShiftedTarget(target) ? '通常は Shift ＋ ' + where : where;
}

/** 今の配列で、Shift と一緒に打つ文字（! ? など）。文字ごとに 1 つ。 */
function shiftedTargets() {
  const seen = new Set();
  const out = [];
  for (const code of charCodes()) {
    const k = S.layout.keys[code];
    if (!k || !k.char) continue;
    const sh = shiftCharOf(k);
    if (sh === String(k.char) || seen.has(sh)) continue;
    seen.add(sh);
    out.push(code + SHIFTED);
  }
  return out;
}

function batchTargets(kind) {
  if (kind === 'shift') return [SHIFT_ROLE];
  if (kind === 'shifted') return shiftedTargets();
  const codes = charCodes();
  if (kind === 'digits') return codes.filter((c) => /^Digit\d$/.test(c));
  return codes.filter((c) => !/^Digit\d$/.test(c) && !/^Key[A-Z]$/.test(c));   // 記号：英字でも数字でもないキー
}

const signalsFor = (target) => { const ex = extraMap(); return Object.keys(ex).filter((sig) => ex[sig] === target); };

function describeReading(r) {
  if (!r) return '';
  if (r.code === SHIFT_ROLE) return 'Shift として登録済みのキー';
  if (r.code === 'Space') return 'スペースキー';
  if (SHIFT_CODES.includes(r.code)) return 'Shift キー';
  return '「' + targetLabel(r.shift ? r.code + SHIFTED : r.code) + '」（' + (r.shift ? 'Shift ＋ ' : '') + 'QWERTY の ' + qwertyLabel(r.code) + ' の位置）';
}

/** そのキーが、何も登録しなくても、もうその文字を打てているか。 */
function readingTypesTarget(r, target, e) {
  if (!r) return false;
  if (target === SHIFT_ROLE) return r.code === SHIFT_ROLE;
  if (r.code !== targetCodeOf(target)) return false;
  if (!isShiftedTarget(target)) return !r.shift;
  return r.shift || (e.shiftKey && !/\+Shift$/.test(r.sig || ''));
}

function registerSignal(sig, target) {
  const ex = extraMap();
  // Shift あり・なしは、Shift として登録するなら同じキー。文字なら、Shift なしで 1 つ・Shift ありで記号を 1 つ持てる
  const bare = sig.replace(/\+Shift$/, '');
  for (const s of [bare, bare + SHIFTED]) {
    if (s === sig || !ex[s]) continue;
    const keepsPair = ex[s] !== SHIFT_ROLE && target !== SHIFT_ROLE && isShiftedTarget(ex[s]) !== isShiftedTarget(target);
    if (!keepsPair) delete ex[s];
  }
  ex[sig] = target;
  saveExtraKeys(ex);
}

function renderExtra(message, ok = false) {
  if (!dlg || !extra) return;
  const current = extra.queue[extra.idx] || null;
  const n = Object.keys(extraMap()).length;
  const pick = (target, body, title, style) => {
    const sigs = signalsFor(target);
    return {
      cls: 'is-pick' + (target === current ? ' is-current' : sigs.length ? ' is-extra' : ''),
      title: title + (sigs.length ? '：' + sigs.map(signalLabel).join('、') + ' を登録済み' : '：クリックで登録'),
      body: html`${body}${sigs.length ? html`<i class="cal-dot"></i>` : ''}`, style,
    };
  };
  const label = current ? targetLabel(current) : '';
  setHtml(dlg.body, html`
    <p class="section-note">数字や記号、Shift をレイヤーから入力する場合に使い、表示されたキーを普段どおりに打って登録します<br>キーをクリックすると 1 つずつ登録し直せます</p>
    <div class="ex-prompt ${current ? 'is-waiting' : ''}" id="exPrompt">${current
      ? html`<span class="ex-cap ${label.length > 1 ? 'is-wide' : ''}">${label}</span>
          <div class="grow"><b>「${label}」を入力してください</b><span>${targetWhere(current)}${extra.queue.length > 1 ? '　' + (extra.idx + 1) + ' / ' + extra.queue.length : ''}</span></div>
          <span class="row">${extra.queue.length > 1 ? html`<button class="btn btn-s" data-c="exSkip">飛ばす</button>` : ''}<button class="btn btn-s" data-c="exStop">やめる</button></span>`
      : html`<span class="muted">下のボタンでまとめて登録するか、キーをクリックしてください（通常どおり打てるキーは登録不要です）</span>`}</div>
    <div class="cal-kb" id="exKeyboard">${flatKeyboard(S.kind, (code) => {
      const slot = slotOf(code);
      if (!slot) return null;
      if (SHIFT_CODES.includes(code)) return pick(SHIFT_ROLE, 'Shift', 'Shift');
      if (slot.isModifier) return { cls: 'fk-mod', body: '', disabled: true };
      return pick(code, targetLabel(code), '「' + targetLabel(code) + '」（QWERTY の ' + slot.label + ' の位置）');
    }, { rows: 4 })}</div>
    <div class="ex-shifted" id="exShifted"><span class="ex-shifted-label">Shift で打つ記号</span>${shiftedTargets().map((target) => {
      const f = pick(target, targetLabel(target), '「' + targetLabel(target) + '」（' + targetWhere(target) + '）');
      return html`<button class="fk-key ex-chip ${f.cls}" data-target="${target}" title="${f.title}">${f.body}</button>`;
    })}</div>
    <div class="cal-message ${ok ? 'is-ok' : ''}" id="exMessage" role="status">${message || ''}</div>
    ${extra.pending ? html`<div class="ex-conflict" id="exConflict">${icon.warn}<p>${extra.pending.text}</p>
      <span class="row"><button class="btn btn-s" data-c="exRetry">別のキーを押し直す</button><button class="btn btn-s btn-primary" data-c="exReplace">置き換えて登録</button></span></div>` : ''}
    <div class="row wrap ex-batch">
      <button class="btn btn-s btn-primary" data-c="exBatch" data-kind="digits">数字をまとめて登録</button>
      <button class="btn btn-s" data-c="exBatch" data-kind="symbols">記号をまとめて登録</button>
      <button class="btn btn-s" data-c="exBatch" data-kind="shifted">！？などをまとめて登録</button>
      <button class="btn btn-s" data-c="exBatch" data-kind="shift">Shift を確認</button>
    </div>`);
  setHtml(dlg.foot, html`<span class="section-note" id="exSummary">${n ? n + ' 個のキーを登録済み' : 'まだ登録はありません'}</span><span class="grow"></span>
    ${n ? html`<button class="btn btn-danger" data-c="exClear">登録を全て削除</button>` : ''}<button class="btn btn-primary" data-modal-close>閉じる</button>`);
}

/** 追加のキーの登録中のキー。 @returns {boolean} 受け取ったか */
function extraKeyDown(e) {
  const current = extra && extra.queue[extra.idx];
  if (!current || extra.pending) return false;   // 待っていないとき：Esc で閉じられる
  if (e.ctrlKey || e.metaKey) return true;
  if (e.key === 'Tab' || pressingButton(e)) return true;
  e.preventDefault();
  if (e.repeat) return true;
  const advance = (message) => { extra.idx++; renderExtra(message, true); };

  if (current === SHIFT_ROLE) {
    if (e.key === 'Shift') { advance('通常の Shift のため、登録しなくても使えます'); return true; }
    if (EXTRA_MODIFIER_KEYS.includes(e.key)) return true;
  } else if (EXTRA_MODIFIER_KEYS.includes(e.key)) return true;   // そのキーへ行く途中で押している Shift・レイヤーキー
  if (EXTRA_BLOCKED_KEYS.includes(e.key) || e.code === 'Space' || e.key === ' ') {
    renderExtra('「' + (e.key === ' ' ? 'Space' : e.key) + '」は練習の操作に使うため登録できません');
    return true;
  }

  const sig = current === SHIFT_ROLE ? signalOf(e, false) : signalOf(e, true);
  const reading = S.reader.reading(e);
  if (readingTypesTarget(reading, current, e)) {
    advance(reading.via === 'extra' ? '既に登録済みのキーです' : 'このキーはそのまま「' + targetLabel(current) + '」として使えます');
    return true;
  }
  const owned = reading && reading.via !== 'extra' && (reading.code === SHIFT_ROLE || Boolean(slotOf(reading.code)));
  if (owned) {
    // その信号は、もう別のキーを打っている：置き換えると、そのキーが打てなくなる。
    // Shift と一緒に登録する記号は、そのキーの Shift の側だけを置き換える
    const shiftSideOnly = isShiftedTarget(current) && /\+Shift$/.test(sig) && reading.code !== SHIFT_ROLE;
    extra.pending = {
      sig, target: current,
      text: shiftSideOnly
        ? 'このキーは Shift と一緒だと「' + targetLabel(reading.code + SHIFTED) + '」ですが、置き換えると Shift 併用時に「' + targetLabel(current) + '」を入力します'
        : 'このキーは ' + describeReading(reading) + ' として使用中のため、置き換えると ' + describeReading(reading) + 'を入力できなくなります',
    };
    renderExtra('');
    return true;
  }
  const moved = reading && reading.via === 'extra' ? reading : null;
  registerSignal(sig, current);
  advance(moved ? '登録しました（以前は ' + describeReading(moved) + ' として登録していた信号です）' : '「' + targetLabel(current) + '」を ' + signalLabel(sig) + ' で登録しました');
  return true;
}

const idleExtra = () => ({ queue: [], idx: 0, pending: null });

/** 追加のキーを開く。 */
export function openExtraKeys() {
  const d = openDialog({
    title: '追加のキーを登録',
    id: 'extra',
    body: '',
    onKey: extraKeyDown,
    onAction: (kind, node) => {
      if (kind === 'exBatch') { extra = { queue: batchTargets(node.dataset.kind), idx: 0, pending: null }; renderExtra(''); }
      else if (kind === 'exSkip') { extra.pending = null; extra.idx++; renderExtra(''); }
      else if (kind === 'exStop') { extra = idleExtra(); renderExtra(''); }
      else if (kind === 'exRetry') { extra.pending = null; renderExtra('光っているキーをもう一度押してください'); }
      else if (kind === 'exReplace' && extra.pending) {
        const p = extra.pending;
        extra.pending = null;
        registerSignal(p.sig, p.target);
        extra.idx++;
        renderExtra('置き換えて登録しました', true);
      } else if (kind === 'exClear') {
        clearVirtualShift();
        saveExtraKeys({});
        extra = idleExtra();
        renderExtra('登録を全て削除しました', true);
      }
    },
  });
  // キーボードのキー・「Shift で打つ記号」をクリック：その 1 つを登録し直す
  d.root.addEventListener('click', (e) => {
    const key = e.target instanceof Element ? e.target.closest('#exKeyboard .fk-key.is-pick, #exShifted .ex-chip') : null;
    if (!key || !extra) return;
    if (e.detail > 0) key.blur();
    const target = key.dataset.target || (SHIFT_CODES.includes(key.dataset.code) ? SHIFT_ROLE : key.dataset.code);
    extra = { queue: [target], idx: 0, pending: null };
    renderExtra('');
  });
  extra = idleExtra();
  renderExtra('');
}

// ---------- 調整のおすすめ ----------

/** 練習中のミスのかたよりから、キーボード側で配列を変えていそうなときに、上の帯で調整をすすめる。 */
export function suggestCalibration() {
  banner('ミスの多くが QWERTY でその文字があるキーだったため、キーボード側で配列を変更している場合はキーボード調整を行ってください',
    { tone: 'hint', action: { label: 'キーボード調整をする', act: 'calib.open' } });
}

/** 起動のときに 1 回：ボタンと、別のウィンドウでの変更をつなぐ。 */
export function wireCalib() {
  act({
    'calib.open': () => { closeBanner('hint'); openCalibration(); },
    'extra.open': () => openExtraKeys(),
  });
  // 別のウィンドウで調整・追加のキーが変わったら、読み直す
  bus.on('storage', (key) => {
    if (key !== null && key !== K.calibration && key !== K.extraKeys) return;
    reloadInputTables();
    refreshReader();
    bus.emit('reader');
  });
}
