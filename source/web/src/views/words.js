// 「練習文」の画面：プリセット（練習文のまとまり）の編集と、グループ（プレイリスト）の編集。
//   - プリセット：並べ替え・追加・削除・名前・種類（日本語 / 英文）
//   - 貼り付け登録：1 行 1 文。自動改行・記号の削除・リストから戻す・元に戻す
//   - 行ごとの編集：問題文・よみがな・打鍵ローマ字。漢字かな変換（内蔵の辞書 → kuromoji）と変換ログ
//   - 変更は「保存する」で確定。「一つ前に戻る」で段階的に戻せる
// よみ・ローマ字の作り方は Rust（core）。ここは画面の流れ。
import { core } from '../core.js';
import { S, bus, saveWords, loadWords, loadGroups, loadDict, isBuiltinPreset, defaultPresetOf, groupById, presetById, startPlaylist, syncPlaylist, shuffled } from '../model.js';
import { K, lsWrite, newId, markDataChanged } from '../store.js';
import { $, $$, html, setHtml, act } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast, banner, confirmDialog, choiceDialog, openPop } from '../ui/overlay.js';
import { sortable, moveItem } from '../ui/sortable.js';
import { getKuromojiTokenizer, kuromojiTokenizer, kuromojiHadProblem, setKuromojiHooks } from '../kuromoji.js';
import { openDictDialog, dictReadingOf } from './dict.js';
import { switchTab } from '../app.js';

const W = {
  sub: 'presets',        // 'presets' | 'groups'
  edit: 0,               // 編集中のプリセットの番号
  undo: [],              // 「一つ前に戻る」の履歴（JSON の文字列）
  saves: 0,              // 保存した回数（履歴の dirty が古くなったかを見分ける）
  pasteHistory: [],      // 貼り付け欄の「元に戻す」
  autoBreak: null,       // 直前の自動改行 {source, result}（ほかの長さを選ぶと、改行する前の文からやり直す）
  active: false,
};
const UNDO_MAX = 50, PASTE_HISTORY_MAX = 20, TOOL_LOG_LINES = 120;
const AUTO_BREAK = [[6, '短'], [12, '中'], [18, '長']];
// 句読点と記号（「」、。！？・… など）。長音の ー・々・文字・数字は残る
const STRIP_SYMBOL_RE = /[\p{P}\p{S}‍︎️]/gu;

const autoReadings = new WeakMap();   // 文 → {kanji, segs}：自動変換が出したよみ（「辞書に登録」の候補を作る）
const kanaEdited = new WeakSet();     // よみがなを手で直した文
const readingGiven = new WeakSet();   // 貼り付けでよみを書いてきた文（変換し直さない）

const preset = () => S.presets[W.edit] || S.presets[0];
const words = () => preset().words;
const isEn = () => preset().lang === 'en';
const hasKanji = (s) => core.hasUnconvertedKanji(s);
const romajiOf = (kana) => core.primaryRomaji(kana, S.romajiStyle);
const readingOf = (segs) => core.normalizeReading(segs.map((x) => x.r).join(''));
const clip = (s, n) => { const t = [...String(s || '')]; return t.length > n ? t.slice(0, n).join('') + '…' : t.join(''); };
const BUILTIN_NOTE = '標準プリセット（いろは歌・こころ・日常）';

// ---------- 変換ログ（コマンドライン風） ----------
// 1 行ずつ順に出すので、一瞬で終わる変換も、処理が流れていくように読める。

const LOG_MAX = 300;
const logQueue = [];
let logTimer = 0;

function log(text, kind = 'out') {
  logQueue.push({ text: String(text), kind });
  if (!logTimer) pumpLog();
}

function pumpLog() {
  logTimer = 0;
  const host = $('#wLog');
  if (!host) { logQueue.length = 0; return; }
  const n = logQueue.length > 40 ? 6 : logQueue.length > 12 ? 2 : 1;   // たまっているときは速く出す
  for (let i = 0; i < n && logQueue.length; i++) {
    const { text, kind } = logQueue.shift();
    const line = document.createElement('div');
    line.className = 'term-line is-' + kind;
    line.textContent = text;
    host.appendChild(line);
  }
  while (host.children.length > LOG_MAX) host.firstChild.remove();
  host.scrollTop = host.scrollHeight;
  if (logQueue.length) logTimer = setTimeout(pumpLog, 28);
}

function logIdle() {
  const host = $('#wLog');
  if (host && !host.children.length && !logQueue.length) log('# 漢字かな変換やローマ字生成を行うと、ここに処理の流れが表示されます', 'dim');
}

function logClear() {
  logQueue.length = 0;
  clearTimeout(logTimer);
  logTimer = 0;
  setHtml('#wLog', '');
  logIdle();
}

// 「きょ=KYO う=U …」：よみが、打つ単位にどう分かれるか
function chunkTrace(kana) {
  const chunks = core.buildKanaChunks(kana, S.romajiStyle);
  const parts = chunks.slice(0, 12).map((c) => c.kana + '=' + (c.options[0] || '?') + (c.options.length > 1 ? '(+' + (c.options.length - 1) + ')' : ''));
  return parts.join(' ') + (chunks.length > 12 ? ' …' : '') + '  [' + chunks.length + '単位]';
}

function logRomaji(no, item) {
  log('  #' + no + ' ' + clip(item.kana, 22) + ' → ' + clip(item.romaji, 40), 'ok');
  log('      ' + chunkTrace(item.kana), 'dim');
}

// ---------- 元に戻す・保存 ----------

// 戻り先の状態。saved：その時点までに保存した回数（保存のあとに戻すと、保存した内容と違うので「未保存」にする）
const snapshot = () => JSON.stringify({ presets: S.presets, groups: S.groups, edit: W.edit, active: S.activePreset, dirty: S.wordsDirty, saved: W.saves });

function pushUndo() {
  const snap = snapshot();
  if (W.undo.length && W.undo[W.undo.length - 1] === snap) return;
  W.undo.push(snap);
  if (W.undo.length > UNDO_MAX) W.undo.shift();
  refreshHead();
}

function undo() {
  // 今と同じ状態の履歴は飛ばす（欄に入っただけで積んだものなど。押しても何も変わらない、をなくす）
  const now = snapshot();
  while (W.undo.length && W.undo[W.undo.length - 1] === now) W.undo.pop();
  if (!W.undo.length) { toast('これ以上戻せる履歴がありません'); refreshHead(); return; }
  const snap = JSON.parse(W.undo.pop());
  S.presets = snap.presets;
  if (Array.isArray(snap.groups)) S.groups = snap.groups;
  const last = Math.max(0, S.presets.length - 1);
  W.edit = Math.min(snap.edit, last);
  S.activePreset = Math.min(snap.active, last);
  S.wordsDirty = snap.saved === W.saves ? Boolean(snap.dirty) : true;
  if (!groupById(S.activeGroupId)) S.activeGroupId = S.groups[0] ? S.groups[0].id : null;
  renderAll();
  toast('練習文の変更を一つ前に戻しました');
}

function markDirty(dirty = true) {
  S.wordsDirty = Boolean(dirty);
  refreshHead();
}

function save() {
  if (!saveWords()) { toast('保存できませんでした（保存容量が不足しているか、このブラウザでは保存できません）'); return; }
  W.saves++;
  markDataChanged();
  markDirty(false);
  syncPractice();
  toast('「' + preset().name + '」を保存しました');
}

// 保存せずに捨てる：保存してあるものを読み直す
function discard() {
  const id = preset().id;
  loadWords(true);
  loadGroups();
  W.undo = [];
  S.wordsDirty = false;
  const idx = S.presets.findIndex((p) => p.id === id);
  W.edit = idx >= 0 ? idx : Math.min(S.activePreset, S.presets.length - 1);
  syncPractice();
  if (W.active) renderAll();
}

/** 保存していない変更があるとき、どうするかを聞く。 @returns {Promise<boolean>} 先へ進んでよいか */
async function confirmLeave() {
  if (!S.wordsDirty) return true;
  const answer = await choiceDialog({
    title: '未保存の変更の確認',
    text: '練習文「' + preset().name + '」に未保存の変更がありますが、保存しますか？',
    choices: [{ key: 'discard', label: '保存せずに移動', kind: 'danger' }, { key: 'save', label: 'はい、保存する', kind: 'primary' }],
  });
  if (answer === 'save') { save(); return true; }
  if (answer === 'discard') { discard(); return true; }
  return false;
}

// 練習の画面に、練習文が変わったことを知らせる（グループで練習中なら、再生の並びも合わせ直す）
function syncPractice() {
  const note = syncPlaylist();
  if (note) toast(note);
  bus.emit('words');
}

// プリセットを足す・消す・並べ替えるとき、練習に使っているプリセットが同じものを指し続けるようにする
function keepingRefs(fn) {
  const activeRef = S.presets[S.activePreset], editRef = preset();
  fn();
  const last = Math.max(0, S.presets.length - 1);
  const a = S.presets.indexOf(activeRef), e = S.presets.indexOf(editRef);
  S.activePreset = a >= 0 ? a : Math.min(S.activePreset, last);
  W.edit = e >= 0 ? e : Math.min(W.edit, last);
}

// ---------- 骨組み ----------

export const wordsView = {
  mount(root) {
    setHtml(root, html`
      <div class="panel glass">
        <div class="panel-head">
          <h1 class="panel-title">練習文</h1>
          <div class="seg seg-accent" role="group" aria-label="編集するもの">
            <button data-act="words.sub" data-arg="presets" aria-pressed="true">プリセット</button>
            <button data-act="words.sub" data-arg="groups" aria-pressed="false">グループ（プレイリスト）</button>
          </div>
          <span class="grow"></span>
          <span class="chip chip-accent" id="wDirty" hidden>未保存の変更あり</span>
          <button class="btn btn-s" data-act="words.undo" id="wUndo" disabled title="Ctrl+Z でも戻せます">${icon.undo}一つ前に戻る</button>
          <button class="btn btn-s" data-act="words.save" id="wSave">${icon.save}保存する</button>
          <button class="btn btn-s btn-ghost" data-act="nav" data-arg="practice">練習画面へ戻る</button>
        </div>
        <div class="panel-body w-body">
          <div class="w-cols" id="wPresets">
            <aside class="w-side">
              <div class="w-side-head"><h2 class="section-title">保存済みのプリセット</h2></div>
              <button class="btn btn-primary w-new" data-act="words.newPreset">${icon.plus}新しいプリセットを作る</button>
              <div class="w-plist" id="wPresetList"></div>
              <p class="section-note">選択すると右側で編集でき、つまみをドラッグすると並べ替えられます</p>
            </aside>
            <div class="w-main">
              <div class="w-edit-head">
                <label class="w-field">名前<input class="field" id="wName" type="text" maxlength="24" data-input="words.name" autocomplete="off"></label>
                <div class="w-field">種類<div class="seg" role="group" aria-label="練習文の種類">
                  <button data-act="words.lang" data-arg="ja" id="wLangJa">日本語</button><button data-act="words.lang" data-arg="en" id="wLangEn">英文</button></div></div>
                <span class="num muted w-count">全 <b id="wCount">0</b> 文</span>
                <span class="grow"></span>
                <button class="btn btn-s btn-danger" id="wDelete" data-act="words.deletePreset">${icon.trash}このプリセットを削除</button>
              </div>
              <div class="w-tools">
                <section class="card w-paste">
                  <div class="w-card-head"><h3 class="section-title">一括ペースト登録</h3><span class="chip num" id="wPasteCount">0 行</span></div>
                  <p class="section-note" id="wPasteHelp"></p>
                  <textarea class="field" id="wPaste" rows="6" spellcheck="false" data-input="words.pasteInput"></textarea>
                  <div class="w-paste-tools">
                    <button class="btn btn-s" data-act="words.listToPaste" title="現在の文をこの欄に戻します">リストから戻す</button>
                    <button class="btn btn-s" data-act="words.breakMenu" id="wBreak" aria-expanded="false">自動改行${icon.chevron}</button>
                    <button class="btn btn-s" data-act="words.strip" id="wStrip" title="「」、。！？などの記号をまとめて削除します（ー は残ります）　自動改行の前に行うのがおすすめです">記号を削除</button>
                    <button class="btn btn-s" data-act="words.clearPaste" title="この欄の文を全て削除します（「元に戻す」で復元できます）">欄をクリア</button>
                    <button class="btn btn-s btn-ghost w-paste-undo" data-act="words.pasteUndo" id="wPasteUndo" hidden>${icon.undo}元に戻す</button>
                  </div>
                  <div class="w-paste-go">
                    <button class="btn btn-primary" data-act="words.append">末尾に追加</button>
                    <button class="btn" data-act="words.replace">リストを置き換える</button>
                    <button class="btn" data-act="words.pasteNew" title="貼り付けた文で新しいプリセットを作成して保存します">新規プリセットに保存</button>
                  </div>
                </section>
                <section class="card w-log">
                  <div class="term-bar"><i></i><i></i><i></i><span title="最新の 300 行まで表示し、それより古い行は自動で削除されます">変換ログ</span><button data-act="words.logClear">クリア</button></div>
                  <div class="term" id="wLog" role="log" aria-live="polite" aria-label="変換の処理ログ"></div>
                </section>
              </div>
              <div class="w-actions">
                <button class="btn btn-s" id="wAutoKana" data-act="words.autoKana">漢字をかな自動変換</button>
                <button class="btn btn-s" id="wRegen" data-act="words.regen">ローマ字を再生成</button>
                <button class="btn btn-s" id="wDict" data-act="words.dict" title="正しく変換されない言葉の読みを登録し、次回から正しく変換します">${icon.book}変換辞書</button>
                <button class="btn btn-s" data-act="words.shuffle">${icon.shuffle}順序をシャッフル</button>
                <button class="btn btn-s" id="wRestore" data-act="words.restore">初期文に戻す</button>
                <span class="grow"></span>
                <button class="btn btn-s" data-act="words.addRow">${icon.plus}行追加</button>
                <button class="btn btn-s btn-danger" id="wClear" data-act="words.clearAll">リスト全削除</button>
              </div>
              <div class="w-rows-head" id="wRowsHead"></div>
              <div class="w-rows" id="wRows"></div>
            </div>
          </div>
          <div id="wGroups" hidden>
            <p class="w-ginfo">グループは、プリセットをまとめた<strong>プレイリスト</strong>で、練習画面でグループを選ぶと続けて練習できます</p>
            <div class="w-cols">
              <aside class="w-side">
                <div class="w-side-head"><h2 class="section-title">グループ一覧</h2></div>
                <button class="btn btn-primary w-new" data-act="words.groupNew">${icon.plus}新しいグループ</button>
                <div class="w-plist" id="wGroupList"></div>
              </aside>
              <div class="w-main" id="wGroupEditor"></div>
            </div>
          </div>
        </div>
      </div>`);

    act({
      'words.sub': (v) => { W.sub = v === 'groups' ? 'groups' : 'presets'; renderAll(); },
      'words.undo': () => undo(),
      'words.save': () => save(),
      'words.pick': (i) => pickPreset(Number(i)),
      'words.newPreset': () => newPreset(),
      'words.deletePreset': () => deletePreset(),
      'words.name': (v) => { preset().name = v.trim() || 'プリセット ' + (W.edit + 1); markDirty(); renderPresetList(); },
      'words.lang': (v) => setLang(v === 'en' ? 'en' : 'ja'),
      'words.pasteInput': () => { updatePasteCount(); forgetPasteHistory(); },
      'words.listToPaste': () => listToPaste(),
      'words.breakMenu': (_, node) => openPop(node, [
        ...AUTO_BREAK.map(([size, label]) => ({ text: label + '（' + size + ' 文字ごとに改行）', onPick: () => autoBreakPaste(size, label) })),
        { sep: true },
        { label: '記号を削除する場合は自動改行の前に（記号も 1 文字として数えます）' },
        { label: '別の長さを選ぶと、改行前の文から改行し直します' },
      ], { align: 'left' }),
      'words.strip': () => stripSymbols(),
      'words.clearPaste': () => clearPaste(),
      'words.pasteUndo': () => undoPasteTool(),
      'words.append': () => appendFromPaste(false),
      'words.replace': () => appendFromPaste(true),
      'words.pasteNew': () => pasteAsNewPreset(),
      'words.logClear': () => logClear(),
      'words.autoKana': () => autoConvert(words().map((_, i) => i), true),
      'words.regen': () => regenAllRomaji(),
      'words.dict': () => openDict(),
      'words.shuffle': () => { pushUndo(); preset().words = shuffled(words()); markDirty(); renderRows(); toast('練習文の順序をシャッフルしました'); },
      'words.restore': () => restoreDefault(),
      'words.addRow': () => addRow(),
      'words.clearAll': () => clearAll(),
      'words.field': (value, node) => updateField(rowIndex(node), node.dataset.f, value, node),
      'words.rowConvert': (_, node) => autoConvert([rowIndex(node)], true),
      'words.rowDict': (_, node) => { const sug = suggestDictEntry(words()[rowIndex(node)]); openDict(sug ? sug.word : '', sug ? sug.reading : ''); },
      'words.rowAuto': (_, node) => resetRowRomaji(rowIndex(node)),
      'words.rowKana': (_, node) => kanaFromKanji(rowIndex(node)),
      'words.rowDelete': (_, node) => { pushUndo(); words().splice(rowIndex(node), 1); markDirty(); renderRows(); renderPresetList(); },
      'words.groupPick': (id) => { S.activeGroupId = id; renderGroups(); },
      'words.groupNew': () => newGroup(),
      'words.groupName': (v) => { const g = groupById(S.activeGroupId); if (!g) return; g.name = v.trim() || '名前なしグループ'; markDirty(); renderGroupList(); },
      'words.groupAdd': (pid) => { const g = groupById(S.activeGroupId); if (!g || g.presetIds.includes(pid)) return; pushUndo(); g.presetIds.push(pid); markDirty(); renderGroups(); },
      'words.groupRemove': (i) => { const g = groupById(S.activeGroupId); if (!g) return; pushUndo(); g.presetIds.splice(Number(i), 1); markDirty(); renderGroups(); },
      'words.groupDelete': () => deleteGroup(),
      'words.groupPlay': () => playGroup(),
    });

    // 欄に入ったときの状態を「一つ前に戻る」の戻り先にする。欄を出たときに、名前の表示と漢字の変換を整える
    root.addEventListener('focusin', (e) => {
      if (e.target instanceof Element && e.target.matches('.w-row textarea, #wName, #wGroupName')) pushUndo();
    });
    root.addEventListener('focusout', (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.id === 'wName' && t.value !== preset().name) t.value = preset().name;
      else if (t.id === 'wGroupName') { const g = groupById(S.activeGroupId); if (g && t.value !== g.name) t.value = g.name; }
      else if (t.matches('.w-row textarea[data-f="kanji"]')) kanjiBlur(rowIndex(t));
    });

    sortable($('#wPresetList'), { item: '.w-pitem', handle: '.w-pgrip', onMove: (from, to) => movePreset(from, to) });
    sortable($('#wRows'), { item: '.w-row', handle: '.w-grip', onMove: (from, to) => moveRow(from, to) });
    sortable($('#wGroupEditor'), { item: '.w-gmember', handle: '.w-pgrip', onMove: (from, to) => moveGroupMember(from, to) });

    setKuromojiHooks({ log, onProblem: (text) => banner(text) });

    // 練習の画面などで練習文が選び直されたら、開いたときに合わせる
    bus.on('settings', (key) => { if (key === 'romajiStyle' && W.active) renderRows(); });
    // 別のウィンドウで保存されたものを読み直す（保存していない変更があるときは、上書きしないで知らせる）
    bus.on('storage', (key) => {
      if (key === null || key === K.userDict) loadDict();
      if (key !== null && key !== K.presets && key !== K.groups) return;
      if (S.wordsDirty) { toast('別のウィンドウで練習文が保存されたため、ここで保存すると上書きされます'); return; }
      const editId = preset() ? preset().id : null;
      const activeId = S.presets[S.activePreset] ? S.presets[S.activePreset].id : null;
      loadWords(true);
      loadGroups();
      const a = S.presets.findIndex((p) => p.id === activeId), e = S.presets.findIndex((p) => p.id === editId);
      if (a >= 0) S.activePreset = a;
      W.edit = e >= 0 ? e : S.activePreset;
      W.undo = [];
      syncPractice();
      if (W.active) renderAll();
    });
  },

  enter() {
    W.active = true;
    W.edit = Math.min(Math.max(0, S.activePreset), Math.max(0, S.presets.length - 1));
    renderAll();
    logIdle();
  },
  leave() { W.active = false; syncPractice(); },
  dirty: () => S.wordsDirty,
  confirmLeave,
  /** Ctrl+Z：文字を打つ欄の中ではブラウザの元に戻すを使い、それ以外では「一つ前に戻る」。 */
  undo(e) {
    if (e.target instanceof Element && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return false;
    e.preventDefault();
    undo();
    return true;
  },
  keyDown(e) {
    const t = document.activeElement;
    if (!(t instanceof Element) || !(e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    if (e.shiftKey && t.closest('.w-pitem') && W.sub === 'presets') {
      e.preventDefault();
      const i = Number(t.closest('.w-pitem').dataset.arg);
      if (movePreset(i, i + dir)) { const n = $('.w-pitem[data-arg="' + (i + dir) + '"]'); if (n) n.focus(); }
    } else if ((e.shiftKey || e.altKey) && t.closest('.w-grip')) {
      e.preventDefault();
      const i = rowIndex(t);
      if (moveRow(i, i + dir, true)) { const n = $('.w-row[data-i="' + (i + dir) + '"] .w-grip'); if (n) n.focus(); }
    }
  },
};

const rowIndex = (node) => Number(node.closest('.w-row').dataset.i);

function renderAll() {
  refreshHead();
  $('#wPresets').hidden = W.sub !== 'presets';
  $('#wGroups').hidden = W.sub !== 'groups';
  if (W.sub === 'groups') renderGroups();
  else { renderPresetList(); refreshEditorHead(); renderRows(); updatePasteCount(); }
}

function refreshHead() {
  for (const b of $$('[data-act="words.sub"]')) b.setAttribute('aria-pressed', String(b.dataset.arg === W.sub));
  const dirty = $('#wDirty'), undoBtn = $('#wUndo'), saveBtn = $('#wSave');
  if (!dirty) return;
  dirty.hidden = !S.wordsDirty;
  undoBtn.disabled = !W.undo.length;
  saveBtn.classList.toggle('btn-primary', S.wordsDirty);
}

// ---------- プリセットの一覧 ----------

function renderPresetList() {
  setHtml('#wPresetList', S.presets.map((p, i) => html`
    <button class="w-pitem" data-act="words.pick" data-arg="${i}" aria-pressed="${String(i === W.edit)}"
      title="${p.name}${p.builtinId ? '（標準プリセット：文の編集はできますが、削除はできません）' : ''}">
      <span class="w-pgrip" aria-hidden="true">${icon.grip}</span>
      <span class="w-pname">${p.name}</span>
      <span class="w-pmeta"><i class="${p.lang === 'en' ? 'is-en' : ''}">${p.lang === 'en' ? '英文' : '日本語'}</i>${p.words.length} 文${p.builtinId ? '・' + p.themeHint + '・標準' : ''}</span>
    </button>`));
  const count = $('#wCount');
  if (count) count.textContent = String(words().length);
}

function pickPreset(i) {
  if (i < 0 || i >= S.presets.length || i === W.edit) return;
  W.edit = i;
  // グループで練習中でなければ、練習するプリセットもこれにする
  if (!S.playlist) { S.activePreset = i; if (!S.wordsDirty) lsWrite(K.activePreset, String(i)); }
  forgetPasteHistory();
  renderPresetList();
  refreshEditorHead();
  renderRows();
}

function movePreset(from, to) {
  if (to < 0 || to >= S.presets.length || from === to) return false;
  pushUndo();
  keepingRefs(() => moveItem(S.presets, from, to));
  markDirty();
  renderPresetList();
  return true;
}

function newPreset() {
  pushUndo();
  const p = { id: newId('p_'), lang: 'ja', name: 'プリセット ' + (S.presets.length + 1), themeHint: 'ユーザー作成', words: [] };
  S.presets.push(p);
  W.edit = S.presets.length - 1;
  if (!S.playlist) S.activePreset = W.edit;
  markDirty();
  renderAll();
  $('#wPaste').focus();
  toast('「' + p.name + '」を追加しました（「保存する」で保存）');
}

async function deletePreset() {
  const p = preset();
  if (isBuiltinPreset(p)) { toast(BUILTIN_NOTE + 'は削除できません（文の編集はできます）'); return; }
  if (S.presets.length <= 1) { toast('プリセットは最低 1 つ必要です'); return; }
  const ok = await confirmDialog({ title: 'プリセット削除の確認', text: 'プリセット「' + p.name + '」を削除しますか？（「一つ前に戻る」で取り消し、「保存する」で確定できます）', ok: '削除する', danger: true });
  if (!ok || preset() !== p) return;
  pushUndo();
  const at = W.edit;
  for (const g of S.groups) g.presetIds = g.presetIds.filter((pid) => pid !== p.id);
  keepingRefs(() => S.presets.splice(at, 1));
  W.edit = Math.max(0, at - 1);
  if (!S.playlist) S.activePreset = W.edit;
  markDirty();
  renderAll();
  toast('「' + p.name + '」を削除しました（「保存する」で確定）');
}

// ---------- 編集中のプリセット ----------

function refreshEditorHead() {
  const p = preset();
  const en = isEn(), builtin = isBuiltinPreset(p);
  const name = $('#wName');
  if (document.activeElement !== name) name.value = p.name;
  $('#wCount').textContent = String(p.words.length);
  $('#wLangJa').setAttribute('aria-pressed', String(!en));
  $('#wLangEn').setAttribute('aria-pressed', String(en));
  $('#wLangEn').disabled = builtin;
  $('#wLangEn').title = builtin ? BUILTIN_NOTE + 'は日本語のみです' : '';
  $('#wDelete').hidden = builtin || S.presets.length <= 1;
  $('#wRestore').hidden = !builtin;
  $('#wClear').hidden = builtin;
  for (const id of ['wAutoKana', 'wRegen', 'wDict', 'wBreak', 'wStrip']) $('#' + id).hidden = en;
  $('#wPasteHelp').textContent = en
    ? '英文を 1 行に 1 文ずつ貼り付けてください'
    : '文章を貼り付けると 1 行が 1 文になり、「問題文|よみ」と書くとその読みを使用します';
  $('#wPaste').placeholder = en ? 'Example:\nThe quick brown fox jumps over the lazy dog.\nPractice makes perfect.' : '例：\n今日の天気は晴れです\nお疲れ様でした';
  setHtml('#wRowsHead', en
    ? html`<span></span><span>問題文（英文）</span>`
    : html`<span></span><span>問題文</span><span>よみがな</span><span>打鍵ローマ字</span><span></span>`);
  $('#wRowsHead').classList.toggle('is-en', en);
}

function setLang(lang) {
  const p = preset();
  if ((p.lang === 'en' ? 'en' : 'ja') === lang) return;
  if (isBuiltinPreset(p)) { toast(BUILTIN_NOTE + 'は日本語の練習文のため、英文は「新しいプリセットを作る」で作成したプリセットで使用してください'); return; }
  const apply = () => {
    pushUndo();
    p.lang = lang;
    if (lang === 'ja') {
      // 英文の行にはよみがないので、打てるように作っておく
      for (const w of p.words) if (!w.kana) { w.kana = S.dict.apply(w.kanji); w.isCustomRomaji = false; w.romaji = romajiOf(w.kana); }
    }
    markDirty();
    renderAll();
    toast('「' + p.name + '」を' + (lang === 'en' ? '英文' : '日本語') + 'の練習文に切り替えました（「保存する」で確定）');
  };
  if (!p.words.length) { apply(); return; }
  confirmDialog({
    title: '練習文の種類を変更',
    text: '「' + p.name + '」を' + (lang === 'en' ? '英文' : '日本語') + 'の練習文に切り替えます（登録済みの文はそのまま残ります）'
      + (lang === 'en' ? '　英文では問題文の欄だけを使用します' : '　よみがなは自動生成されるため確認してください'),
    ok: '切り替える',
  }).then((ok) => { if (ok && preset() === p) apply(); });
}

async function restoreDefault() {
  const p = preset();
  const def = isBuiltinPreset(p) ? defaultPresetOf(p.builtinId) : null;
  if (!def) return;
  const ok = await confirmDialog({ title: '初期文に戻す確認', text: '「' + p.name + '」の練習文を初期文（' + p.themeHint + '）に戻しますか？', ok: '初期文に戻す' });
  if (!ok || preset() !== p) return;
  pushUndo();
  p.words = def.words;
  p.lang = 'ja';
  markDirty();
  renderAll();
  toast('「' + p.name + '」を初期文（' + def.themeHint + '）に戻しました（「保存する」で確定）');
}

async function clearAll() {
  const p = preset();
  if (isBuiltinPreset(p)) { toast(BUILTIN_NOTE + 'のリストは全削除できません（文の編集はできます）'); return; }
  if (!p.words.length) { toast('リストは既に空です'); return; }
  const ok = await confirmDialog({ title: '全削除の確認', text: '現在のプリセットに登録されている練習文を全て削除しますか？', ok: '全削除する', danger: true });
  if (!ok || preset() !== p) return;
  pushUndo();
  p.words = [];
  markDirty();
  renderRows();
  renderPresetList();
  toast('現在のプリセットの練習文を全て削除しました（「保存する」で確定）');
}

// ---------- 貼り付け欄 ----------

const pasteBox = () => $('#wPaste');

function parsePaste(rawText) {
  if (!rawText) return [];
  return S.dict.parseMultiLine(rawText, isEn(), S.romajiStyle).map((p) => {
    const item = p.word;
    if (p.readingGiven) readingGiven.add(item);
    if (p.autoSegments) autoReadings.set(item, { kanji: item.kanji, segs: p.autoSegments });
    return item;
  });
}

function updatePasteCount() {
  const n = pasteBox().value.split(/\r?\n/).filter((line) => line.trim()).length;
  $('#wPasteCount').textContent = n + ' 行';
}

// 新しい文を欄に入れ、前の文は「元に戻す」のために取っておく
function setPasteWithHistory(text) {
  const box = pasteBox();
  W.pasteHistory.push({ text: box.value, autoBreak: W.autoBreak });
  if (W.pasteHistory.length > PASTE_HISTORY_MAX) W.pasteHistory.shift();
  box.value = text;
  updatePasteCount();
  $('#wPasteUndo').hidden = false;
}

// 欄に自分で打った（または欄の文を使った）ら、「元に戻す」の戻り先はなくなる
function forgetPasteHistory() {
  W.pasteHistory.length = 0;
  W.autoBreak = null;
  const b = $('#wPasteUndo');
  if (b) b.hidden = true;
}

function undoPasteTool() {
  if (!W.pasteHistory.length) return;
  const prev = W.pasteHistory.pop();
  pasteBox().value = prev.text;
  W.autoBreak = prev.autoBreak;
  updatePasteCount();
  if (!W.pasteHistory.length) $('#wPasteUndo').hidden = true;
  log('$ undo  一括ペースト欄を1つ前に戻しました', 'cmd');
  toast('一括ペースト欄を1つ前に戻しました');
}

function pasteTextOrHint() {
  const box = pasteBox();
  if (!box.value.trim()) { toast('先に文章を上のボックスに貼り付けてください'); box.focus(); return null; }
  return box.value;
}

function listToPaste() {
  const box = pasteBox();
  // 文の中の改行や | は、貼り付け直したときに文を分けてしまう
  const lines = words().map((w) => String(w.kanji || '').replace(/[\r\n\t]+/g, ' ').replace(/\|/g, '｜').trim()).filter(Boolean);
  if (!lines.length) { toast('このプリセットにはまだ練習文がありません'); return; }
  const text = lines.join('\n');
  if (box.value === text) { toast('一括ペースト欄には既にリストと同じ文が入っています'); return; }
  const replaced = Boolean(box.value.trim());
  setPasteWithHistory(text);
  W.autoBreak = null;
  log('$ list-to-paste --preset "' + clip(preset().name, 16) + '"  ' + lines.length + ' 文', 'cmd');
  for (const line of lines.slice(0, 5)) log('  ' + clip(line, 40), 'dim');
  if (lines.length > 5) log('  …ほか ' + (lines.length - 5) + ' 文', 'dim');
  toast('リストの ' + lines.length + ' 文を一括ペースト欄に戻しました' + (replaced ? '（前の文は「元に戻す」で復元できます）' : '') + '　修正後は「リストを置き換える」で反映できます');
  box.scrollTop = 0;
}

function clearPaste() {
  const box = pasteBox();
  if (!box.value) { toast('一括ペースト欄は既に空です'); return; }
  const n = box.value.split(/\r?\n/).filter((line) => line.trim()).length;
  setPasteWithHistory('');
  W.autoBreak = null;
  log('$ clear-paste  一括ペースト欄の ' + n + ' 行を削除しました', 'cmd');
  toast('一括ペースト欄をクリアしました（「元に戻す」で復元できます）');
  box.focus();
}

function toolLogger() {
  let logged = 0;
  return (text, kind) => {
    if (logged < TOOL_LOG_LINES) log(text, kind);
    else if (logged === TOOL_LOG_LINES) log('  …（ログが長いので省略します）', 'dim');
    logged++;
  };
}

function autoBreakPaste(size, label) {
  const current = pasteTextOrHint();
  if (current === null) return;
  const again = Boolean(W.autoBreak && W.autoBreak.result === current);
  const text = again ? W.autoBreak.source : current;
  log('$ auto-break --size ' + label + '（' + size + ' 文字・空白は数えない）', 'cmd');
  if (again) log('  前回の自動改行を取り消し、改行前の文から改行し直します', 'dim');
  const out = [];
  let before = 0, broken = 0, skipped = 0;
  const say = toolLogger();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    before++;
    if (core.isReadingSpecLine(line)) { out.push(line.trim()); skipped++; say('  行' + before + ' 読み付きの行のため変更しません', 'dim'); continue; }
    const pieces = core.autoBreakLine(line, size);
    out.push(...pieces);
    if (pieces.length < 2) continue;
    broken++;
    say('  行' + before + '（' + core.countedLength(line) + '字）→ ' + pieces.length + ' 行 [' + pieces.map((p) => core.countedLength(p)).join('・') + ']', 'ok');
    for (const piece of pieces) say('      ' + piece, 'dim');
  }
  const result = out.join('\n');
  if (result === current || (!again && !broken)) {
    const msg = again ? 'すでに' + label + '（' + size + ' 文字）で改行されています' : '改行する行はありませんでした（どの行も ' + size + ' 文字に収まっています）';
    log('  ' + msg, 'dim');
    toast(msg);
    return;
  }
  setPasteWithHistory(result);
  W.autoBreak = { source: text, result };
  log('done ' + before + ' 行 → ' + out.length + ' 行' + (skipped ? '（読み付きの ' + skipped + ' 行はそのまま）' : ''), 'done');
  toast((again ? '改行し直しました（' : '自動改行しました（') + label + '：' + before + ' 行 → ' + out.length + ' 行）　「元に戻す」で復元できます');
}

function stripSymbols() {
  const text = pasteTextOrHint();
  if (text === null) return;
  log('$ strip-symbols  （「」、。！？などを削除し、ー は残す）', 'cmd');
  const out = [];
  let removedTotal = 0, changedLines = 0, emptied = 0, lineNo = 0;
  const say = toolLogger();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    lineNo++;
    if (core.isReadingSpecLine(line)) { out.push(line.trim()); say('  行' + lineNo + ' 読み付きの行のため変更しません', 'dim'); continue; }
    const removed = line.match(STRIP_SYMBOL_RE) || [];
    const clean = line.replace(STRIP_SYMBOL_RE, '').replace(/[ 　]{2,}/g, ' ').trim();
    if (!removed.length) { out.push(clean); continue; }
    removedTotal += removed.length;
    changedLines++;
    if (clean) {
      out.push(clean);
      say('  行' + lineNo + ' ' + clip(clean, 24) + '  （−' + removed.length + '：' + clip([...new Set(removed)].join(' '), 16) + '）', 'ok');
    } else {
      emptied++;
      say('  行' + lineNo + ' 記号だけの行なので取り除きました', 'warn');
    }
  }
  if (!removedTotal) { log('  取り除く記号はありませんでした', 'dim'); toast('取り除く記号はありませんでした'); return; }
  setPasteWithHistory(out.join('\n'));
  log('done 記号 ' + removedTotal + ' 個を削除（' + changedLines + ' 行' + (emptied ? '・空になった ' + emptied + ' 行を削除' : '') + '）', 'done');
  toast('記号を ' + removedTotal + ' 個削除しました（「元に戻す」で復元できます）');
}

function appendFromPaste(replaceAll) {
  const box = pasteBox();
  const items = parsePaste(box.value);
  if (!items.length) { toast('上のボックスに練習したい文章を入力またはペーストしてください'); return; }
  pushUndo();
  const p = preset();
  const start = replaceAll ? 0 : p.words.length;
  p.words = replaceAll ? items : [...p.words, ...items];
  markDirty();
  renderRows();
  renderPresetList();
  box.value = '';
  updatePasteCount();
  forgetPasteHistory();
  toast(items.length + '文を' + (replaceAll ? '上書き作成' : '末尾に追加') + 'しました（「保存する」で保存）');
  if (!isEn()) {
    const added = items.map((item, i) => (readingGiven.has(item) ? -1 : start + i)).filter((i) => i >= 0);
    if (added.length) autoConvert(added, false);
  }
}

// 貼り付けた行から新しいプリセットを作り、すぐに保存する
async function pasteAsNewPreset() {
  const box = pasteBox();
  const lang = isEn() ? 'en' : 'ja';
  const items = parsePaste(box.value);
  if (!items.length) { toast('先に練習したい文章を上のボックスに貼り付けてください'); box.focus(); return; }
  pushUndo();
  const p = { id: newId('p_'), lang, name: 'プリセット ' + (S.presets.length + 1), themeHint: 'ユーザー作成', words: items };
  S.presets.push(p);
  W.edit = S.presets.length - 1;
  if (!S.playlist) S.activePreset = W.edit;
  box.value = '';
  updatePasteCount();
  forgetPasteHistory();
  markDirty();
  renderAll();
  if (lang === 'ja') {
    const toConvert = items.map((item, i) => (readingGiven.has(item) ? -1 : i)).filter((i) => i >= 0);
    if (toConvert.length) await autoConvert(toConvert, false);
  }
  save();
  renderPresetList();
  const name = $('#wName');
  if (W.active && preset() === p) { name.focus(); name.select(); }
  toast('「' + p.name + '」（' + items.length + ' 文）を作成して保存しました（名前は上の「名前」で変更できます）');
}

// ---------- 漢字かな変換 ----------

function rememberAuto(item, segs) {
  autoReadings.set(item, { kanji: item.kanji, segs });
  kanaEdited.delete(item);
}

/** 漢字をよみに変換する（内蔵の辞書 → 足りなければ kuromoji）。feedback：ボタンから呼んだとき（お知らせを出し、戻せるようにする） */
async function autoConvert(indices, feedback = false) {
  // 文そのものを覚えておく：辞書の読み込みに数秒かかる間に、利用者が先へ進むことがある
  const list = words();
  const t0 = performance.now();
  const sec = () => ((performance.now() - t0) / 1000).toFixed(2);
  const valid = indices.filter((i) => { const item = list[i]; return item && (hasKanji(item.kanji) || hasKanji(item.kana) || S.dict.hasWordIn(item.kanji)); });
  log('$ kana-convert --preset "' + clip(preset().name, 16) + '" --lines ' + indices.length, 'cmd');
  if (!valid.length) {
    log('  変換が必要な漢字はありません', 'dim');
    if (feedback) toast('変換が必要な漢字はありません');
    return;
  }
  log('[1/3] 内蔵辞書で変換（' + valid.length + ' 文）', 'step');
  if (feedback) pushUndo();

  // 1. すぐ終わる：内蔵の辞書と変換辞書
  const remaining = [];
  for (const i of valid) {
    const item = list[i];
    const segs = S.dict.segments(item.kanji);
    const converted = readingOf(segs);
    item.kana = converted;
    if (!hasKanji(converted)) {
      rememberAuto(item, segs);
      if (!item.isCustomRomaji) item.romaji = romajiOf(item.kana);
      const userWords = segs.filter((x) => x.user).map((x) => x.s);
      log('  #' + (i + 1) + ' ' + clip(item.kanji, 20) + ' → ' + clip(item.kana, 24) + '  ✓' + (userWords.length ? '  （変換辞書：' + clip(userWords.join('・'), 20) + '）' : ''), 'ok');
    } else {
      remaining.push(item);
      log('  #' + (i + 1) + ' ' + clip(item.kanji, 20) + ' → 内蔵辞書にない漢字があります（形態素解析へ）', 'warn');
    }
  }
  markDirty();
  // 行を作り直さない：欄を出たときにも動くので、作り直すと、いま押したボタンや打っている欄が消えてしまう
  refreshRows(list, valid.map((i) => list[i]));

  if (!remaining.length) {
    log('done ' + valid.length + ' 文（' + sec() + '秒）', 'done');
    if (feedback) toast('漢字をひらがなに自動変換しました');
    return;
  }
  const loaded = Boolean(kuromojiTokenizer());
  log('[2/3] 形態素解析エンジン kuromoji 0.1.2 を準備' + (loaded ? '（読み込み済み）' : ''), 'step');
  if (!loaded && feedback) toast('漢字かな変換辞書を読み込んでいます（初回のみ数秒かかります）');

  // 2. 残りは形態素解析（このブラウザの中で動く）
  const sources = remaining.map((item) => item.kanji);
  const before = remaining.map((item) => item.kana);
  const tokenizer = await getKuromojiTokenizer();
  if (!tokenizer) {
    log('  ✗ 辞書を使えませんでした（' + (kuromojiHadProblem() ? '内容が一致しない' : '接続できない') + '）ため、内蔵辞書の結果を残します', 'err');
    if (feedback) toast(kuromojiHadProblem()
      ? '外部の辞書が使用できなかったため内蔵辞書で変換しました　残りはよみがな欄で修正してください'
      : '内蔵辞書で変換しました　残りの漢字はよみがな欄で調整してください');
    return;
  }
  const results = sources.map((sentence, si) => {
    if (!sentence) return { reading: '', segs: [] };
    const segs = S.dict.tokenizeWith(sentence, tokenizer);
    log('  ' + (si + 1) + '/' + sources.length + ' 「' + clip(sentence, 20) + '」 → '
      + segs.map((x) => x.s + (x.user ? '[辞書:' + x.r + ']' : hasKanji(x.s) ? '(' + x.r + ')' : '')).join('|'), 'out');
    return { reading: readingOf(segs), segs };
  });
  log('[3/3] 読みを組み立てて、ローマ字を生成', 'step');
  const updated = [];
  remaining.forEach((item, i) => {
    // 読み込みを待つ間に直された文・よみは、利用者のものを残す
    if (!results[i].reading || item.kanji !== sources[i] || item.kana !== before[i]) return;
    updated.push(item);
    item.kana = results[i].reading;
    rememberAuto(item, results[i].segs);
    if (!item.isCustomRomaji) item.romaji = romajiOf(item.kana);
    logRomaji(list.indexOf(item) + 1, item);
  });
  log('done ' + valid.length + ' 文（' + sec() + '秒）', 'done');
  markDirty();
  refreshRows(list, updated);
  toast('ローカル辞書で漢字をひらがなに変換しました');
}

function regenAllRomaji() {
  pushUndo();
  const list = words();
  log('$ romaji --style ' + S.romajiStyle + ' --lines ' + list.length, 'cmd');
  list.forEach((item, i) => {
    item.isCustomRomaji = false;
    item.romaji = romajiOf(item.kana);
    if (!isEn()) logRomaji(i + 1, item);
  });
  log('done ' + list.length + ' 文', 'done');
  markDirty();
  renderRows();
  toast('現在のプリセットの打鍵ローマ字を一括再生成しました');
}

// よみを手で直したあと：変換が出したよみと比べて、よみが変わった言葉と、その新しいよみ（生憎 → あいにく）を見つける
function suggestDictEntry(item) {
  if (!item || !kanaEdited.has(item) || !item.kanji || !item.kana || hasKanji(item.kana)) return null;
  let rec = autoReadings.get(item);
  if (!rec || rec.kanji !== item.kanji) {
    // このページを開く前に変換した文：もう一度読む
    const tok = kuromojiTokenizer();
    rec = { kanji: item.kanji, segs: tok ? S.dict.tokenizeWith(item.kanji, tok) : S.dict.segments(item.kanji) };
    autoReadings.set(item, rec);
  }
  const base = rec.segs.map((x) => x.r).join('');
  const typed = item.kana;
  if (base === typed) return null;
  // 違う部分：変換のよみの [p, base.length - q)。その前と後ろは、打ったよみと同じ
  const maxLen = Math.min(base.length, typed.length);
  let p = 0;
  while (p < maxLen && base[p] === typed[p]) p++;
  let q = 0;
  while (q < maxLen - p && base[base.length - 1 - q] === typed[typed.length - 1 - q]) q++;
  let lo = p, hi = base.length - q;
  if (lo === hi) { lo = Math.max(0, lo - 1); hi = Math.min(base.length, hi + 1); }   // 足しただけ
  // 変わった部分にかかる、文の区切り
  let pos = 0, first = -1, last = -1, segStart = 0, segEnd = 0;
  rec.segs.forEach((seg, i) => {
    const start = pos, end = pos + seg.r.length;
    pos = end;
    if (!seg.r.length || end <= lo || start >= hi) return;
    if (first < 0) { first = i; segStart = start; }
    last = i;
    segEnd = end;
  });
  if (first < 0) return null;
  let word = core.cleanDictWord(rec.segs.slice(first, last + 1).map((x) => x.s).join(''));
  let reading = core.cleanDictReading(typed.slice(segStart, typed.length - (base.length - segEnd)));
  // 活用した 1 語（憚ら）：辞書形（憚る）を候補にする。ほかの活用にも効く
  const one = first === last ? rec.segs[first] : null;
  const tails = one && one.b && reading ? core.okuriganaTails(one.b, one.s) : null;
  if (tails && reading.endsWith(tails.surfTail)) {
    word = core.cleanDictWord(one.b);
    reading = core.cleanDictReading(reading.slice(0, reading.length - tails.surfTail.length) + tails.baseTail);
  }
  // かなの言葉は書いたとおりに読むので、登録するものがない
  if (!word || !reading || !(hasKanji(word) || /[A-Za-z0-9Ａ-Ｚａ-ｚ０-９]/.test(word))) return null;
  return { word, reading };
}

function openDict(word = '', reading = '') {
  openDictDialog({
    word, reading, log,
    sentencesWith: (w) => (!w || isEn() ? [] : words().map((x, i) => ((x.kanji || '').includes(w) ? i : -1)).filter((i) => i >= 0)),
    apply: (indices) => autoConvert(indices, true),
    onChange: () => { if (!isEn()) words().forEach((_, i) => updateSuggest(i)); },
  });
}

// ---------- 行 ----------

const rowNode = (i) => $('#wRows .w-row[data-i="' + i + '"]');

function autoResize(node) {
  if (!node) return;
  node.style.height = 'auto';
  node.style.height = Math.max(36, node.scrollHeight + 2) + 'px';
}

function autoResizeAll() {
  const nodes = $$('#wRows textarea');
  for (const n of nodes) n.style.height = 'auto';
  const heights = nodes.map((n) => Math.max(36, n.scrollHeight + 2));
  nodes.forEach((n, i) => { n.style.height = heights[i] + 'px'; });
}

function renderRows() {
  const host = $('#wRows');
  const list = words();
  const en = isEn();
  // 描き直しても、文字を打つ場所（カーソル）を元の欄に戻す
  const focused = document.activeElement;
  const keep = focused instanceof HTMLTextAreaElement && host.contains(focused)
    ? { i: rowIndex(focused), f: focused.dataset.f, start: focused.selectionStart, end: focused.selectionEnd } : null;
  $('#wRowsHead').hidden = !list.length;
  if (!list.length) {
    setHtml(host, html`<div class="w-empty"><b>このプリセットにはまだ練習文がありません</b>
      <span>上のボックスに${en ? '英文' : '文章'}を貼り付けて一括作成するか、下のボタンから追加してください</span>
      <div class="row wrap"><button class="btn btn-primary" data-act="words.addRow">${icon.plus}行を追加</button>
        ${isBuiltinPreset(preset()) ? html`<button class="btn" data-act="words.restore">初期文に戻す</button>` : ''}</div></div>`);
    return;
  }
  setHtml(host, list.map((item, i) => {
    const grip = html`<button class="w-grip" title="ドラッグして順序を入れ替え（Shift＋↑↓ でも動かせます）" aria-label="${i + 1} 番目の文を動かす">${icon.grip}<span class="num">${i + 1}</span></button>`;
    const del = html`<button class="icon-btn w-del" data-act="words.rowDelete" aria-label="この文を削除" title="この文を削除">${icon.trash}</button>`;
    if (en) {
      return html`<div class="w-row is-en" data-i="${i}">${grip}
        <textarea class="field" rows="1" spellcheck="false" data-f="kanji" data-input="words.field" placeholder="Type an English sentence">${item.kanji}</textarea>${del}</div>`;
    }
    const warn = hasKanji(item.kana);
    return html`<div class="w-row" data-i="${i}">${grip}
      <textarea class="field w-kanji" rows="1" data-f="kanji" data-input="words.field" placeholder="問題文を入力">${item.kanji}</textarea>
      <div class="w-cell">
        <textarea class="field ${warn ? 'is-warn' : ''}" rows="1" data-f="kana" data-input="words.field" placeholder="よみがなを入力">${item.kana}</textarea>
        <button class="w-warn" data-act="words.rowConvert" ${warn ? '' : html`hidden`}>漢字をかな変換</button>
        <button class="w-suggest" data-act="words.rowDict" title="このよみを変換辞書に登録して、次から同じように変換します" hidden></button>
      </div>
      <div class="w-cell">
        <textarea class="field mono w-romaji" rows="1" spellcheck="false" data-f="romaji" data-input="words.field" placeholder="打鍵ローマ字">${core.effectiveWordRomaji(item, S.romajiStyle)}</textarea>
        <button class="w-auto" data-act="words.rowAuto" title="自動生成ローマ字に戻す" ${item.isCustomRomaji ? '' : html`hidden`}>自動に戻す</button>
      </div>
      <div class="w-row-acts"><button class="icon-btn" data-act="words.rowKana" aria-label="問題文からよみがなを作り直す" title="問題文からよみがなを作り直す">${icon.retry}</button>${del}</div>
    </div>`;
  }));
  if (!en) list.forEach((item, i) => { if (kanaEdited.has(item)) updateSuggest(i); });
  requestAnimationFrame(() => {
    autoResizeAll();
    if (!keep) return;
    const node = $('#wRows .w-row[data-i="' + keep.i + '"] textarea[data-f="' + keep.f + '"]');
    if (!node || (document.activeElement && document.activeElement !== document.body)) return;
    node.focus({ preventScroll: true });
    try { node.setSelectionRange(Math.min(keep.start, node.value.length), Math.min(keep.end, node.value.length)); } catch { /* 置けなくてもよい */ }
  });
}

// いくつかの文のよみ・ローマ字だけを、行を作り直さずに表示し直す（利用者が押している・打っているものを動かさない）
function refreshRows(list, items) {
  if (!W.active || list !== words() || !items.length) return;
  if ($$('#wRows .w-row').length !== list.length) { renderRows(); return; }
  const en = isEn();
  for (const item of items) {
    const i = list.indexOf(item);
    const row = i >= 0 ? rowNode(i) : null;
    if (!row) continue;
    const setField = (f, value) => {
      const node = $('textarea[data-f="' + f + '"]', row);
      if (!node || node.value === value) return;
      node.value = value;
      autoResize(node);
    };
    setField('kanji', item.kanji);
    if (en) continue;
    setField('kana', item.kana);
    setField('romaji', core.effectiveWordRomaji(item, S.romajiStyle));
    updateRowMarks(i);
  }
}

function updateRowMarks(i) {
  const item = words()[i], row = rowNode(i);
  if (!item || !row || isEn()) return;
  const warn = hasKanji(item.kana);
  $('textarea[data-f="kana"]', row).classList.toggle('is-warn', warn);
  $('.w-warn', row).hidden = !warn;
  $('.w-auto', row).hidden = !item.isCustomRomaji;
  updateSuggest(i);
}

function updateSuggest(i) {
  const row = rowNode(i);
  const btn = row ? $('.w-suggest', row) : null;
  if (!btn) return;
  const sug = isEn() ? null : suggestDictEntry(words()[i]);
  const show = Boolean(sug && dictReadingOf(sug.word) !== sug.reading);
  btn.hidden = !show;
  btn.textContent = show ? '辞書に登録：' + sug.word + ' → ' + sug.reading : '';
}

function updateField(i, field, value, node) {
  autoResize(node);
  const item = words()[i];
  if (!item) return;
  const row = rowNode(i);
  const setOther = (f, v) => { const n = row ? $('textarea[data-f="' + f + '"]', row) : null; if (n) { n.value = v; autoResize(n); } };
  if (field === 'kanji' && isEn()) { item.kanji = value; markDirty(); return; }
  if (field === 'kanji') {
    item.kanji = value;
    const segs = S.dict.segments(value);
    const converted = readingOf(segs);
    if (!hasKanji(converted)) {
      item.kana = converted;
      rememberAuto(item, segs);
      setOther('kana', item.kana);
      if (!item.isCustomRomaji) { item.romaji = romajiOf(item.kana); setOther('romaji', item.romaji); }
    }
  } else if (field === 'kana') {
    item.kana = core.normalizeReading(value);
    kanaEdited.add(item);
    item.isCustomRomaji = false;
    item.romaji = romajiOf(item.kana);
    setOther('romaji', item.romaji);
  } else if (field === 'romaji') {
    const cleaned = core.normalizeRomajiInput(value);
    item.romaji = cleaned;
    item.isCustomRomaji = Boolean(cleaned && cleaned !== romajiOf(item.kana));
  }
  markDirty();
  updateRowMarks(i);
}

function kanjiBlur(i) {
  const item = words()[i];
  if (!item) return;
  if (isEn()) {
    const clean = core.normalizeEnglishText(item.kanji);
    if (clean === item.kanji) return;
    item.kanji = clean;
    markDirty();
    const node = rowNode(i) ? $('textarea[data-f="kanji"]', rowNode(i)) : null;
    if (node && node !== document.activeElement) { node.value = clean; autoResize(node); }
    return;
  }
  if (hasKanji(item.kanji)) autoConvert([i], false);
}

function kanaFromKanji(i) {
  const item = words()[i];
  if (!item) return;
  pushUndo();
  const segs = S.dict.segments(item.kanji);
  item.kana = readingOf(segs);
  rememberAuto(item, segs);
  item.isCustomRomaji = false;
  item.romaji = romajiOf(item.kana);
  markDirty();
  renderRows();
  if (hasKanji(item.kana)) autoConvert([i], true);
  else toast('問題文からよみがなを生成しました');
}

function resetRowRomaji(i) {
  const item = words()[i];
  if (!item) return;
  pushUndo();
  item.isCustomRomaji = false;
  item.romaji = romajiOf(item.kana);
  markDirty();
  renderRows();
  toast('自動生成ローマ字に戻しました');
}

function moveRow(from, to, quiet = false) {
  const list = words();
  if (to < 0 || to >= list.length || from === to) return false;
  pushUndo();
  moveItem(list, from, to);
  markDirty();
  renderRows();
  if (!quiet) toast('練習文の順序を入れ替えました');
  return true;
}

function addRow() {
  pushUndo();
  const kana = 'あたらしいれんしゅうぶん';
  words().push(isEn() ? { kanji: 'New sentence', kana: '', romaji: '', isCustomRomaji: false } : { kanji: '新しい練習文', kana, romaji: romajiOf(kana), isCustomRomaji: false });
  markDirty();
  renderRows();
  renderPresetList();
  requestAnimationFrame(() => { const last = $('#wRows .w-row:last-child'); if (last) last.scrollIntoView({ block: 'nearest' }); });
  toast('新しい行を追加しました（「保存する」で保存）');
}

// ---------- グループ（プレイリスト） ----------

// 左の一覧だけ。グループ名を打っている間は、名前の欄そのものを作り直さない（日本語の変換が途切れてしまう）
function renderGroupList() {
  const playing = S.playlist ? S.playlist.groupId : null;
  setHtml('#wGroupList', S.groups.length
    ? S.groups.map((g) => html`<button class="w-pitem is-group" data-act="words.groupPick" data-arg="${g.id}" aria-pressed="${String(g.id === S.activeGroupId)}">
        <span class="w-pname">${g.name}</span>${g.id === playing ? html`<span class="chip chip-accent w-playing">${icon.play}練習中</span>` : ''}
        <span class="w-pmeta">${g.presetIds.length} プリセット</span></button>`)
    : html`<p class="w-none">グループはまだありません</p>`);
}

function renderGroups() {
  if (!groupById(S.activeGroupId)) S.activeGroupId = S.groups[0] ? S.groups[0].id : null;
  renderGroupList();
  const g = groupById(S.activeGroupId);
  if (!g) { setHtml('#wGroupEditor', html`<div class="w-empty"><b>グループがありません</b><span>左の「新しいグループ」から作成してください</span></div>`); return; }
  const members = g.presetIds.map((pid, i) => ({ p: presetById(pid), i })).filter((x) => x.p);
  const addable = S.presets.filter((p) => !g.presetIds.includes(p.id));
  setHtml('#wGroupEditor', html`
    <div class="w-edit-head">
      <label class="w-field">グループ名<input class="field" id="wGroupName" type="text" maxlength="24" value="${g.name}" data-input="words.groupName" autocomplete="off"></label>
      <span class="grow"></span>
      <button class="btn btn-s btn-primary" data-act="words.groupPlay">${icon.play}このグループで練習</button>
      <button class="btn btn-s btn-danger" data-act="words.groupDelete">${icon.trash}グループを削除</button>
    </div>
    <h3 class="section-title">練習する順番</h3>
    <p class="section-note">順番どおり・シャッフル・全シャッフルから選択できます</p>
    ${members.length
      ? html`<div class="w-gmembers">${members.map(({ p, i }) => html`<div class="w-gmember" data-i="${i}">
          <span class="w-pgrip" title="ドラッグで並べ替え" aria-hidden="true">${icon.grip}</span><span class="num w-gno">${i + 1}</span>
          ${p.lang === 'en' ? html`<span class="chip chip-accent">EN</span>` : ''}<b>${p.name}</b><span class="num muted">${p.words.length} 文</span>
          <button class="btn btn-s btn-ghost" data-act="words.groupRemove" data-arg="${i}">外す</button></div>`)}</div>`
      : html`<p class="w-none is-box">まだプリセットが登録されていないため、下から追加してください</p>`}
    <h3 class="section-title w-gadd-title">プリセットを追加</h3>
    ${addable.length
      ? html`<div class="w-gadd">${addable.map((p) => html`<button class="btn btn-s" data-act="words.groupAdd" data-arg="${p.id}">${icon.plus}${p.name}<span class="num muted">${p.words.length} 文</span></button>`)}</div>`
      : html`<p class="w-none">全てのプリセットが登録済みです</p>`}`);
}

function newGroup() {
  pushUndo();
  const g = { id: newId('g_'), name: 'グループ ' + (S.groups.length + 1), presetIds: [] };
  S.groups.push(g);
  S.activeGroupId = g.id;
  markDirty();
  renderGroups();
  toast('「' + g.name + '」を作成しました（プリセットを追加して「保存する」で保存）');
}

function moveGroupMember(from, to) {
  const g = groupById(S.activeGroupId);
  if (!g) return;
  pushUndo();
  if (moveItem(g.presetIds, from, to)) { markDirty(); renderGroups(); }
}

async function deleteGroup() {
  const g = groupById(S.activeGroupId);
  if (!g) return;
  const ok = await confirmDialog({ title: 'グループの削除', text: 'グループ「' + g.name + '」を削除しますか？（中のプリセットは削除されません）', ok: '削除する', danger: true });
  if (!ok) return;
  pushUndo();
  S.groups = S.groups.filter((x) => x.id !== g.id);
  S.activeGroupId = S.groups[0] ? S.groups[0].id : null;
  markDirty();
  renderGroups();
  toast('グループを削除しました（「保存する」で確定）');
}

async function playGroup() {
  const id = S.activeGroupId;
  if (!(await confirmLeave())) return;
  const problem = startPlaylist(id);
  if (problem) { toast(problem); return; }
  switchTab('practice');
}
