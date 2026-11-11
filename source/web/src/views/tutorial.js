// はじめての人への案内（チュートリアル）。6 つの画面で、キーボードの種類・練習する配列・キーボード側で配列を変えているかを聞き、
// 練習のしかたと画面の見方を伝える。初めて開いたとき（記録も保存した配列もないとき）に自動で出て、「ヘルプ」からいつでも見直せる。
// 流れと文は旧版（v5.4.5）をもとに、v6 の画面に合わせてある。
import { S, BUILTIN_LAYOUT_KEYS, selectLayout, setKind, setSetting } from '../model.js';
import { K, rawGet, lsWrite, storageAvailable } from '../store.js';
import { $, html, setHtml } from '../ui/dom.js';
import { openModal, toast, confirmDialog } from '../ui/overlay.js';
import { practiceScreen, pause as pausePractice, abandonForNewSelection } from './practice.js';

const STEPS = 6;
const LAYOUT_OPTIONS = [
  { key: 'oonishi', name: '大西配列', desc: '母音を左手、子音を右手に集約した日本語向けの配列です' },
  { key: 'qwerty', name: 'QWERTY', desc: '標準の配列で、まずはツールに慣れたいときに向いています' },
  { key: 'dvorak', name: 'Dvorak', desc: '母音を左手のホーム段に集めた配列です' },
  { key: 'colemak', name: 'Colemak', desc: 'QWERTY から移行しやすく、ホーム段を多用する配列です' },
  { key: 'custom', name: '自分で作る', desc: '配列エディタでキーに文字を割り当てます' },
]

const T = { step: 0, layout: null, remap: null, detected: null };
let dlg = null;
let hooks = { switchTab: () => {}, openCalibration: () => {}, openPrivacy: () => {}, wave: () => {} };

export const tutorialDone = () => Boolean(rawGet(K.tutorialDone));

/** 初めて開いたときだけ自動で出す（記録や保存した配列がもうある人のじゃまをしない）。 */
export function shouldAutoStartTutorial() {
  if (!storageAvailable() || tutorialDone()) return false;
  if (S.history.length) return false;
  for (let i = 1; i <= 5; i++) if (rawGet(K.slot(i))) return false;
  return true;
}

/** パソコンの設定から、キーボードの種類を見当づける（Chrome・Edge だけ。わからなければ null）。 */
async function detectKeyboardType() {
  try {
    if (!navigator.keyboard || !navigator.keyboard.getLayoutMap) return null;
    const map = await navigator.keyboard.getLayoutMap();
    const key = map.get('BracketLeft');
    if (key === '@') return 'jis';
    if (key === '[') return 'us';
  } catch { /* わからない */ }
  return null;
}

const option = (kind, value, title, desc, selected) => html`<button class="tut-option" data-t="choose" data-kind="${kind}" data-value="${value}" aria-pressed="${String(selected)}"><b>${title}</b><span>${desc}</span></button>`;

function stepHtml(step) {
  if (step === 0) {
    return html`
      <h3>カスタム配列タイピングへようこそ</h3>
      <p>好きなキー配列でローマ字入力を練習できます<br>準備は 1 分ほどで終わります</p>
      <ul>
        <li>今のキーボードのまま、他の配列を練習できます</li>
        <li>配列エディタで独自の配列を作成できます</li>
        <li>スコアの記録や、制限時間に挑むシャトルランもあります</li>
      </ul>
      <div class="tut-note">データはこのブラウザ内にのみ保存し、外部には送信しません
        <button class="btn-link" data-t="privacy">プライバシーポリシー</button></div>`;
  }
  if (step === 1) {
    return html`
      <h3>キーボードの種類は？</h3>
      <p>後から「設定」でも変更できます</p>
      <div class="tut-options">
        ${option('kb', 'jis', 'JIS（日本語キーボード）', 'P の右が @ で、スペースの横に「変換」キーがあります', S.kind === 'jis')}
        ${option('kb', 'us', 'US（英語キーボード）', 'P の右が [ で、Enter キーが横長です', S.kind === 'us')}
      </div>
      ${T.detected ? html`<div class="tut-note is-hint">このパソコンは ${T.detected === 'us' ? 'US' : 'JIS'} 配列のようです</div>` : ''}`;
  }
  if (step === 2) {
    return html`
      <h3>練習する配列を選んでください</h3>
      <p>後から練習画面でいつでも変更できます</p>
      <div class="tut-options">${LAYOUT_OPTIONS.map((o) => option('layout', o.key, o.name, o.desc, T.layout === o.key))}</div>`;
  }
  if (step === 3) {
    return html`
      <h3>キーボード側で配列を変更していますか？</h3>
      <p>VIAL や AutoHotkey で並べ替えている場合は二重に変換されてしまうため、「キーボード調整」を行います<br>レイヤーで数字を入力しているだけなら「変更していない」で問題ありません</p>
      <div class="tut-options">
        ${option('remap', 'no', '変更していない', 'そのまま使用します', T.remap === 'no')}
        ${option('remap', 'yes', '変更している', 'この後キーボード調整を始めます（約 1 分）', T.remap === 'yes')}
        ${option('remap', 'unknown', '分からない', 'そのまま始め、必要なときに案内を表示します', T.remap === 'unknown')}
      </div>`;
  }
  if (step === 4) {
    return html`
      <h3>練習の仕方</h3>
      <ul>
        <li><kbd>Space</kbd> で開始、<kbd>Esc</kbd> で一時停止します</li>
        <li>次に押すキーと使う指が光ります</li>
        <li>ローマ字は SI でも SHI でも正解になります</li>
        <li>「シャトルランに挑戦」で制限時間に挑戦できます</li>
      </ul>`;
  }
  const custom = T.layout === 'custom';
  return html`
    <h3>画面の使い方</h3>
    <ul>
      <li>右上の「設定」でテーマや表示を変更できます</li>
      <li>上部のタブで練習文・配列・記録の画面に移動できます</li>
      <li>右上の「データ」から記録を書き出せます</li>
      <li>この案内は右上の「ヘルプ」からいつでも確認できます</li>
    </ul>
    <div class="tut-note tut-low">
      <div class="grow"><b>軽い表示</b><span>動作が重いときやパソコンが熱くなるときに使います<br>「設定」でも切り替えられます</span></div>
      <button class="switch" role="switch" aria-checked="${String(Boolean(S.settings.lowQuality))}" aria-label="軽い表示" data-t="lowq"></button>
    </div>
    ${T.remap === 'yes' ? html`<div class="tut-note is-hint">「完了」を押すとキーボード調整を始めます</div>`
      : custom ? html`<div class="tut-note is-hint">「完了」を押すと配列エディタを開きます</div>` : ''}`;
}

function render() {
  if (!dlg) return;
  const step = T.step;
  const last = step === STEPS - 1;
  setHtml(dlg.body, html`
    <div class="tut-top">
      <span class="num tut-step" id="tutStep">${step + 1} / ${STEPS}</span>
      <div class="tut-dots" aria-hidden="true">${Array.from({ length: STEPS }, (_, i) => html`<i class="${i <= step ? 'is-on' : ''}"></i>`)}</div>
      <button class="btn btn-s btn-ghost" data-t="skip">スキップ</button>
    </div>
    <div class="tut-body" id="tutBody">${stepHtml(step)}</div>`);
  const next = step === 0 ? 'はじめる' : last
    ? (T.remap === 'yes' ? '完了して調整へ' : T.layout === 'custom' ? '完了して配列エディタへ' : '完了して練習へ')
    : '次へ';
  setHtml($('.modal-foot', dlg.root), html`
    <button class="btn" data-t="back" ${step === 0 ? html`hidden` : ''}>戻る</button><span class="grow"></span>
    <span class="tut-hint"><kbd>Enter</kbd>次へ</span>
    <button class="btn btn-primary" data-t="next" id="tutNext">${next}</button>`);
  // 中身を入れ替えるとフォーカスが外れるので、「次へ」に置き直す
  const focus = $('#tutNext', dlg.root);
  if (focus) { try { focus.focus({ preventScroll: true }); } catch { /* なくてもよい */ } }
  dlg.body.scrollTop = 0;
}

async function choose(kind, value) {
  if (kind === 'kb') {
    if (value !== S.kind) {
      if (S.layoutDirty) {
        const ok = await confirmDialog({ title: '保存していない配列の変更があります', text: 'キーボードの種類を変更すると編集中の配列が読み込み直されますが、続行しますか？', ok: '続行する', danger: true });
        if (!ok) return;
      }
      abandonForNewSelection();
      setKind(value);
      hooks.wave();
    } else lsWrite(K.kind, S.kind);   // はっきり選んだので、このあとパソコンの設定で変えない
  } else if (kind === 'layout') {
    T.layout = value;
    // 選んだ配列を、うしろのキーボードですぐ見せる（編集中の配列があるときは、変えない）
    if (BUILTIN_LAYOUT_KEYS.includes(value) && value !== S.activeLayoutKey && !S.layoutDirty) {
      abandonForNewSelection();
      selectLayout(value);
      hooks.wave();
    }
  } else if (kind === 'remap') T.remap = value;
  render();
}

function go(dir) {
  const next = T.step + dir;
  if (next >= STEPS) { finish(false); return; }
  T.step = Math.max(0, next);
  render();
}

function finish(skipped) {
  lsWrite(K.tutorialDone, String(Date.now()));
  const d = dlg;
  dlg = null;
  if (d) d.close();
  if (skipped) return;
  if (T.layout === 'custom') {
    if (!S.activeLayoutKey.startsWith('custom') && !S.layoutDirty) { abandonForNewSelection(); selectLayout('custom1'); }
    hooks.switchTab('editor');
  }
  if (T.remap === 'yes') hooks.openCalibration({ start: true });
  else if (T.layout !== 'custom') toast('準備ができました　Space で始めましょう');
}

function keyDown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); if (!e.repeat) go(1); return true; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); if (!e.repeat) go(-1); return true; }
  if (e.key === 'Escape') { e.preventDefault(); finish(true); return true; }
  // ボタンの上の Space・Tab は、そのままブラウザに任せる
  return true;
}

export function openTutorial() {
  if (dlg) return;
  if (practiceScreen() === 'typing') pausePractice();
  T.step = 0;
  T.layout = BUILTIN_LAYOUT_KEYS.includes(S.activeLayoutKey) ? S.activeLayoutKey : 'custom';
  T.remap = S.reader && S.reader.hasCalibration() ? 'yes' : null;
  dlg = openModal({
    title: 'はじめに', id: 'tutorial', body: '', foot: ' ', dismissable: false, onKey: keyDown,
    onClose: () => { if (dlg) { dlg = null; lsWrite(K.tutorialDone, String(Date.now())); } },
  });
  dlg.root.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-t]') : null;
    if (!b) return;
    const kind = b.dataset.t;
    if (kind === 'next') go(1);
    else if (kind === 'back') go(-1);
    else if (kind === 'skip') finish(true);
    else if (kind === 'privacy') hooks.openPrivacy();
    else if (kind === 'choose') choose(b.dataset.kind, b.dataset.value);
    else if (kind === 'lowq') { setSetting('lowQuality', !S.settings.lowQuality); render(); }
  });
  render();
  detectKeyboardType().then((type) => {
    T.detected = type;
    // まだ何も選んでいなければ、パソコンの設定から始める
    if (type && rawGet(K.kind) === null && type !== S.kind && !S.layoutDirty) { abandonForNewSelection(); setKind(type); }
    if (dlg && T.step === 1) render();
  });
}

/** 起動のときに 1 回：ほかの画面へのつなぎを受け取る。 @param {{switchTab: Function, openCalibration: Function, openPrivacy: Function, wave: Function}} h */
export function wireTutorial(h) { hooks = { ...hooks, ...h }; }
