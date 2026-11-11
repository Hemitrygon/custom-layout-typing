// 「データ」のダイアログ：保存の状態・バックアップの書き出し / 復元 / 上書き保存・保存容量と圧縮・すべて削除、
// と、記録がたまったときの「バックアップのおすすめ」。
// バックアップの形・確かめ方・声かけの条件は Rust（core）。ここは画面とファイルの出し入れ。
import { core } from '../core.js';
import { S } from '../model.js';
import { K, PREFIXES, rawGet, lsRead, lsRemove, storageAvailable, appEntries, compressionEnabled, setCompression, deleteAllAppData } from '../store.js';
import { $, html, setHtml, act, formatDate, downloadText } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast, confirmDialog, alertDialog, openModal, modalOpen } from '../ui/overlay.js';
import { cdnStatus } from '../fonts.js';

const STORAGE_LIMIT_CHARS = 5 * 1024 * 1024;   // localStorage は、多くのブラウザで約 500 万文字まで
const BACKUP_FILE_LIMIT = 20 * 1024 * 1024;
const HANDLE_DB = 'custom_typing_backup_handle';   // 上書き保存するファイルの場所（IndexedDB）
const SNOOZE_DAYS = 3, DAY_MS = 86400000;

let dialog = null;         // 開いている「データ」のダイアログ
let reminderTimer = 0;
let context = { tab: () => 'practice', screen: () => '', dirty: () => false };

const shuttleHistory = () => core.loadShuttleHistory(lsRead(K.shuttle));
const setRaw = (key, value) => { try { localStorage.setItem(key, value); return true; } catch { return false; } };
const fmtBytes = (bytes) => (bytes < 1024 ? bytes + ' B' : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1024 / 1024).toFixed(2) + ' MB');

// ---------- バックアップのおすすめ ----------
// 前のバックアップから完走が 20 回たまったとき、または 1 週間たって新しい記録が 5 回以上（か、配列・練習文の変更）あるとき。

function reminderInfo() {
  const enabled = storageAvailable() && rawGet(K.reminderOff) !== '1';
  const stamps = S.history.map((r) => r.timestamp).concat(shuttleHistory().map((r) => r.timestamp));
  return core.backupReminder(enabled, rawGet(K.lastBackup), rawGet(K.dataChanged), stamps, Date.now(), rawGet(K.snooze));
}

/** 落ち着いた場面（結果の画面など）でだけ出す。打っている最中には出さない。 */
export function maybeBackupReminder(delay, where) {
  clearTimeout(reminderTimer);
  if (!reminderInfo().due) return;
  reminderTimer = setTimeout(() => {
    if (where && context.screen() !== where) return;
    if (modalOpen() || !reminderInfo().due) return;
    openBackupReminder();
  }, delay);
}

function openBackupReminder() {
  const info = reminderInfo();
  const m = openModal({
    title: 'バックアップのおすすめ',
    id: 'backup-reminder',
    body: html`<p>${info.last ? '前回のバックアップ（' + formatDate(info.last) + '）以降、' : 'これまでに'}完走の記録が <strong>${info.count} 件</strong>たまりました${info.dataChanged ? '（配列や練習文も変更されています）' : ''}</p>
      <p>記録はこのブラウザ内にのみ保存されており、閲覧履歴を削除すると失われる場合があります<br>書き出したファイルは「データ」の「バックアップから復元」で復元できます</p>`,
    foot: html`<button class="btn btn-ghost" data-r="off">今後は表示しない</button><span class="grow"></span>
      <button class="btn" data-r="later">あとで</button>
      <button class="btn" data-r="overwrite" id="remOverwrite" hidden></button>
      <button class="btn btn-primary" data-r="export" autofocus>${icon.download}バックアップを書き出す</button>`,
  });
  if (overwriteSupported()) loadHandle().then((h) => { const b = $('#remOverwrite', m.root); if (h && b) { b.textContent = '「' + h.name + '」に上書き'; b.hidden = false; } });
  m.root.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-r]') : null;
    if (!b) return;
    m.close();
    if (b.dataset.r === 'later') setRaw(K.snooze, JSON.stringify({ until: Date.now() + SNOOZE_DAYS * DAY_MS, count: reminderInfo().count }));
    else if (b.dataset.r === 'off') { setRaw(K.reminderOff, '1'); toast('お知らせをオフにしました（「データ」からいつでも書き出せます）'); }
    else if (b.dataset.r === 'export') exportBackup(true);
    else if (b.dataset.r === 'overwrite') overwriteBackup(false);
  });
}

// ---------- バックアップ ----------

const backupText = () => core.buildBackupText(core.collectAppStorage(appEntries()), new Date().toISOString());
const warnUnsaved = () => { if (context.dirty()) toast('未保存の変更は含まれないため、先に「保存する」を押してください'); };

function markBackedUp() {
  setRaw(K.lastBackup, String(Date.now()));
  lsRemove(K.snooze);
}

function exportBackup(fromReminder = false) {
  warnUnsaved();
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  downloadText('typing_backup_' + stamp + '.json', backupText());
  markBackedUp();
  if (!fromReminder && dialog) renderData();
  toast('バックアップを書き出しました');
}

// 選んだファイルが使えないときは、消えるお知らせではなく、はっきりした注意を出す（何を変えていないかも伝える）
function fileAlert(fileName, reason, safeText) {
  return alertDialog({
    title: 'このファイルは使用できません',
    danger: true,
    text: html`<p>${fileName ? html`<strong>「${fileName}」</strong><br>` : ''}${reason}<br>このツールで書き出した .json ファイルを選択してください</p><p class="data-safe">${icon.check}${safeText}</p>`,
  });
}

function importBackup(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const keep = '現在のデータは変更されていません';
  if (file.size > BACKUP_FILE_LIMIT) { fileAlert(file.name, 'ファイルが大きすぎます', keep); return; }
  const reader = new FileReader();
  reader.onerror = () => fileAlert(file.name, 'ファイルを読み取れませんでした', keep);
  reader.onload = async () => {
    const v = core.validateBackup(String(reader.result), BACKUP_FILE_LIMIT);
    if (!v.ok) { fileAlert(file.name, v.reason, keep); return; }
    const when = v.exportedAt ? formatDate(v.exportedAt) : '日時不明';
    const ok = await confirmDialog({ title: 'バックアップから復元', text: when + ' のバックアップで現在のデータを全て置き換えます', ok: '復元する' });
    if (!ok) return;
    // 全部か、何もしないか：途中で書けなくなったら、今のデータに戻す
    const before = core.collectAppStorage(appEntries());
    const compress = compressionEnabled();
    try {
      for (const [k] of before) localStorage.removeItem(k);
      for (const [k, value] of v.entries) localStorage.setItem(k, core.encodeForStorage(compress, k, value));
      // 中身はファイルのものになったので、ファイルを書き出した時刻にバックアップ済みとして扱う
      localStorage.setItem(K.lastBackup, String(core.backedUpAt(v.exportedAt, Date.now())));
      localStorage.removeItem(K.dataChanged);
      localStorage.removeItem(K.snooze);
    } catch {
      try {
        for (const [k] of core.collectAppStorage(appEntries())) localStorage.removeItem(k);
        for (const [k, value] of before) localStorage.setItem(k, core.encodeForStorage(compress, k, value));
      } catch { /* 戻せるところまで戻す */ }
      toast('復元できませんでした（現在のデータは変更されていません）');
      return;
    }
    S.layoutDirty = false;
    S.wordsDirty = false;
    location.reload();
  };
  reader.readAsText(file);
}

// ---------- 以前のバックアップファイルへの上書き保存（File System Access API：Chrome・Edge） ----------

const overwriteSupported = () => typeof window.showOpenFilePicker === 'function' && window.isSecureContext !== false;

function handleDb() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(HANDLE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('handles');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}

async function loadHandle() {
  try {
    const db = await handleDb();
    try {
      return await new Promise((resolve) => {
        const req = db.transaction('handles', 'readonly').objectStore('handles').get('last');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } finally { db.close(); }
  } catch { return null; }
}

async function saveHandle(handle) {
  try {
    const db = await handleDb();
    try {
      await new Promise((resolve) => { const tx = db.transaction('handles', 'readwrite'); tx.objectStore('handles').put(handle, 'last'); tx.oncomplete = resolve; tx.onerror = resolve; });
    } finally { db.close(); }
  } catch { /* 覚えられなくても、保存はできている */ }
}

async function forgetHandle() {
  try {
    const db = await handleDb();
    try {
      await new Promise((resolve) => { const tx = db.transaction('handles', 'readwrite'); tx.objectStore('handles').delete('last'); tx.oncomplete = resolve; tx.onerror = resolve; });
    } finally { db.close(); }
  } catch { /* なくてもよい */ }
}

/** pick = true：ファイルを選ぶ。false：前回のファイル。 */
async function overwriteBackup(pick) {
  if (!overwriteSupported()) { toast('このブラウザでは上書き保存できません'); return; }
  warnUnsaved();
  let handle = null;
  try {
    if (!pick) handle = await loadHandle();
    if (!handle) {
      const picked = await window.showOpenFilePicker({
        id: 'typing-backup', multiple: false, excludeAcceptAllOption: true,
        types: [{ description: 'このツールのバックアップ (.json)', accept: { 'application/json': ['.json'] } }],
      });
      handle = picked && picked[0];
    }
  } catch (e) {
    if (!(e && e.name === 'AbortError')) toast('ファイルを選択できませんでした');
    return;
  }
  if (!handle) return;
  const untouched = 'ファイルは書き換えていません';
  let info;
  try {
    // 先に許可：覚えているファイルも、ブラウザを開き直したあとは許可が要る
    if (handle.queryPermission && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted'
      && (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
      toast('書き込みが許可されなかったため、上書きしませんでした');
      return;
    }
    const file = await handle.getFile();
    info = file.size > BACKUP_FILE_LIMIT ? { ok: false, reason: 'ファイルが大きすぎます' } : core.validateBackup(await file.text(), BACKUP_FILE_LIMIT);
  } catch {
    if (!pick) { await forgetHandle(); if (dialog) renderOverwrite(); toast('前回のファイルが見つからなかったため、もう一度選択してください'); }
    else fileAlert(handle.name, 'ファイルを読み取れませんでした', 'ファイルは書き換えていません');
    return;
  }
  if (!info.ok) {
    if (!pick) { await forgetHandle(); if (dialog) renderOverwrite(); }   // 覚えていたファイルがバックアップでなくなった：もうすすめない
    fileAlert(handle.name, info.reason, untouched);
    return;
  }
  const nowScores = S.history.length, nowShuttle = shuttleHistory().length;
  const fewer = info.scores > nowScores || info.shuttle > nowShuttle;
  const ok = await confirmDialog({
    title: 'バックアップファイルに上書き保存',
    text: html`<p>「${handle.name}」を現在のデータで書き換えます</p>
      <p>記録数はファイルが ${info.scores + info.shuttle} 件、現在のデータが ${nowScores + nowShuttle} 件です</p>
      ${fewer ? html`<p class="data-warn">${icon.warn}ファイルの方が記録が多く、上書きするとファイルにしかない記録は失われます</p>` : ''}`,
    ok: '上書き保存する', danger: fewer,
  });
  if (!ok) return;
  try {
    const writable = await handle.createWritable();
    await writable.write(backupText());
    await writable.close();
  } catch {
    toast('書き込めなかったため、ファイルを開いていないか確認してください');
    return;
  }
  await saveHandle(handle);
  markBackedUp();
  if (dialog) renderData();
  toast('「' + handle.name + '」に上書き保存しました');
}

// ---------- 「データ」のダイアログ ----------

function storageBreakdown() {
  const groups = [
    { label: '練習文・グループ', color: '#4a8dff', test: (k) => /word_presets|word_groups|active_preset|user_dict/.test(k), n: 0 },
    { label: '配列', color: '#bb8cff', test: (k) => k.startsWith('typecraft_') || /last_layout|calibration|extra_keys/.test(k), n: 0 },
    { label: 'スコア記録', color: '#57d69b', test: (k) => /score_history/.test(k), n: 0 },
    { label: 'シャトルラン記録', color: '#2fe0c8', test: (k) => /shuttle_history/.test(k), n: 0 },
    { label: '設定など', color: '#8a8f99', test: () => true, n: 0 },
  ];
  let other = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      const len = k.length + (localStorage.getItem(k) || '').length;
      if (PREFIXES.some((p) => k.startsWith(p))) groups.find((g) => g.test(k)).n += len;
      else other += len;
    }
  } catch { /* 読めなければ 0 のまま */ }
  return { groups, other, total: groups.reduce((a, g) => a + g.n, 0) };
}

async function renderOverwrite() {
  const box = dialog ? $('#dataOverwrite', dialog.root) : null;
  if (!box) return;
  if (!overwriteSupported()) {
    setHtml(box, html`<p class="section-note">前回のファイルへの上書き保存は Chrome と Edge で使用できます</p>`);
    return;
  }
  const handle = await loadHandle();
  if (!dialog) return;
  setHtml(box, html`<div class="row wrap">
      ${handle ? html`<button class="btn btn-teal" data-d="overwriteLast">「${handle.name}」に上書き保存</button>` : ''}
      <button class="btn" data-d="overwritePick">前のファイルを選んで上書き保存</button></div>
    <p class="section-note">ファイルを増やさずに前回のバックアップを書き換えます（他のファイルは変更しません）</p>`);
}

function renderData() {
  if (!dialog) return;
  const ok = storageAvailable();
  const slots = [1, 2, 3, 4, 5].filter((i) => rawGet(K.slot(i))).length;
  const sentences = S.presets.reduce((n, p) => n + p.words.length, 0);
  const info = reminderInfo();
  const b = storageBreakdown();
  const pct = Math.min(100, ((b.total + b.other) / STORAGE_LIMIT_CHARS) * 100);
  const compressed = compressionEnabled();
  const fonts = { ok: '確認済み・使用中', loading: '読み込み中', unreachable: '接続できないため端末の標準フォントを使用', unverified: '内容を確認できないため未使用', blocked: '想定外の内容のため未使用' }[cdnStatus.fonts];
  const kuro = { idle: '未使用（漢字かな変換の使用時のみ読み込みます）', ok: '確認済み・使用中', unreachable: '接続できません（内蔵の簡易辞書で変換します）', blocked: '想定外の内容のため未使用（内蔵の簡易辞書で変換します）' }[cdnStatus.kuromoji];
  const problems = cdnStatus.problems || [];
  setHtml(dialog.body, html`
    <div class="data-status ${ok ? 'is-ok' : 'is-bad'}">${ok ? icon.check : icon.warn}${ok
      ? '自動で保存しており、ブラウザを閉じても残ります'
      : '現在保存できないため、閉じると変更が失われます'}</div>
    <div class="data-counts">
      <div><i>保存した配列</i><b class="num">${slots} 枠</b></div>
      <div><i>練習文</i><b class="num">${S.presets.length}組・${sentences}文</b></div>
      <div><i>スコア記録</i><b class="num">${S.history.length} 件</b></div>
    </div>
    <h3>バックアップ</h3>
    <div class="row wrap">
      <button class="btn btn-primary" data-d="export">${icon.download}バックアップを書き出す（.json）</button>
      <button class="btn" data-d="import">${icon.upload}バックアップから復元</button>
      <input type="file" id="dataFile" accept=".json,application/json" hidden>
    </div>
    <div class="data-overwrite" id="dataOverwrite"></div>
    <p class="section-note">${info.last ? '前回の書き出しは ' + formatDate(info.last) + ' で、その後の記録は ' + info.count + ' 件です' : 'まだ書き出していません'}</p>
    <label class="check data-check"><input type="checkbox" id="dataReminder" ${rawGet(K.reminderOff) !== '1' ? html`checked` : ''}>記録がたまったら書き出しを勧める</label>

    <h3>ブラウザの保存容量</h3>
    <div class="data-storage">
      <div class="data-storage-head"><span>このツール <b class="num">${fmtBytes(b.total * 2)}</b></span><span class="muted">目安の上限 約 ${fmtBytes(STORAGE_LIMIT_CHARS * 2)}</span></div>
      <div class="data-bar" title="${pct.toFixed(1)}%">${b.groups.filter((g) => g.n).map((g) => html`<i style="width:${Math.max(0.6, (g.n / STORAGE_LIMIT_CHARS) * 100).toFixed(2)}%;background:${g.color}"></i>`)}</div>
      <div class="data-legend">${b.groups.map((g) => html`<span><i style="background:${g.color}"></i>${g.label} ${fmtBytes(g.n * 2)}</span>`)}${b.other ? html`<span><i></i>ほかのページ ${fmtBytes(b.other * 2)}</span>` : ''}</div>
      <div class="row wrap"><span class="section-note grow">大きなデータの圧縮：<strong>${compressed ? 'オン' : 'オフ'}</strong></span>
        <button class="btn btn-s" data-d="compress">${compressed ? '圧縮をやめる（元に戻す）' : '圧縮して容量を減らす'}</button></div>
      <p class="section-note" id="dataEstimate">漢字変換の辞書（約 17MB）は使用時のみ読み込み、保存はしません</p>
    </div>

    <h3>外部から読み込むファイル</h3>
    <p>フォント（Google Fonts）：${fonts || '-'}<br>漢字かな変換の辞書（jsDelivr / unpkg）：${kuro || '-'}</p>
    <p class="section-note">どちらも内容を確認してから使用し、異常がある場合は画面上部でお知らせします</p>
    ${problems.length ? html`<p class="data-warn">${icon.warn}${problems.join(' ')}</p>` : ''}

    <h3>データはどこに保存されている？</h3>
    <p>このブラウザ内に自動で保存され、同じブラウザで同じアドレスを開けば残っています</p>
    <p>次の場合は表示されなくなります</p>
    <ul>
      <li>別のブラウザや、別のパソコンで開いたとき</li>
      <li>閲覧履歴からサイトデータを削除したとき</li>
      <li>シークレットウィンドウで開いたとき</li>
      <li>ページのアドレスが変わったとき</li>
    </ul>
    <p>定期的にバックアップを書き出すと安心です（旧版（v5 まで）のバックアップも復元できます）</p>

    <div class="data-danger">
      <b>サイトのデータを削除</b>
      <p>このツールが保存したデータを全て削除します（元に戻せません）</p>
      <button class="btn btn-danger" data-d="deleteAll">${icon.trash}全てのデータを削除</button>
    </div>`);
  renderOverwrite();
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((est) => {
      const node = dialog ? $('#dataEstimate', dialog.root) : null;
      if (node && est && est.usage) node.textContent += '　他に、このページでブラウザが使用している領域：約 ' + fmtBytes(est.usage);
    }).catch(() => {});
  }
}

async function toggleCompression() {
  const on = !compressionEnabled();
  if (on) {
    const ok = await confirmDialog({
      title: 'データを圧縮する',
      text: '大きなデータを圧縮して保存します（内容は変わりませんが、5.0 より古い版では読み込めなくなります）',
      ok: '圧縮する',
    });
    if (!ok) return;
  }
  const r = setCompression(on);
  renderData();
  if (!r) { toast('設定を保存できませんでした'); return; }
  toast((on ? '圧縮しました' : '圧縮を元に戻しました') + '（' + fmtBytes(r.before * 2) + ' → ' + fmtBytes(r.after * 2) + '）' + (r.ok ? '' : '　一部のデータはそのままです'));
}

async function deleteAll() {
  const ok = await confirmDialog({
    title: '全てのデータを削除しますか？',
    text: 'このツールが保存したデータを全て削除します（元に戻せないため、残したい場合は先にバックアップを書き出してください）',
    ok: 'はい、全て削除する', danger: true,
  });
  if (!ok) return;
  // このツールのキーだけを消す
  deleteAllAppData();
  try {
    const keys = [];
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k && PREFIXES.some((p) => k.startsWith(p))) keys.push(k); }
    for (const k of keys) sessionStorage.removeItem(k);
  } catch { /* なくてもよい */ }
  try { indexedDB.deleteDatabase(HANDLE_DB); } catch { /* なくてもよい */ }
  S.layoutDirty = false;
  S.wordsDirty = false;
  location.reload();
}

export function openDataDialog() {
  if (dialog) return;
  dialog = openModal({
    title: 'データの保存・バックアップ',
    size: 'l',
    id: 'data',
    body: '',
    foot: html`<button class="btn" data-modal-close>閉じる</button>`,
    onClose: () => { dialog = null; },
  });
  dialog.root.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-d]') : null;
    if (!b) return;
    const kind = b.dataset.d;
    if (kind === 'export') exportBackup();
    else if (kind === 'import') $('#dataFile', dialog.root).click();
    else if (kind === 'overwriteLast') overwriteBackup(false);
    else if (kind === 'overwritePick') overwriteBackup(true);
    else if (kind === 'compress') toggleCompression();
    else if (kind === 'deleteAll') deleteAll();
  });
  dialog.root.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.id === 'dataFile') importBackup(t);
    else if (t.id === 'dataReminder') { if (t.checked) lsRemove(K.reminderOff); else setRaw(K.reminderOff, '1'); }
  });
  renderData();
}

/** 起動のときに 1 回：ボタンと、画面の状態の調べ方をつなぐ。 */
export function wireData(ctx) {
  context = { ...context, ...ctx };
  act({ 'data.open': () => openDataDialog() });
}
