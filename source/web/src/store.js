// 保存（ブラウザの localStorage）。キーの名前と中身の形は旧版（v5.4.5）と同じにしてあるので、
// 旧版（v5）のデータやバックアップをそのまま読める。大きなデータの圧縮（設定でオン）は Rust の core で行う。
import { core } from './core.js';

export const K = {
  presets: 'custom_typing_word_presets_v2',
  presetsUnreadable: 'custom_typing_word_presets_v2_unreadable',
  groups: 'custom_typing_word_groups_v1',
  activePreset: 'custom_typing_active_preset_idx_v2',
  source: 'custom_typing_practice_source_v1',
  lastLayout: 'custom_typing_last_layout_v1',
  slot: (i) => 'typecraft_qwerty_base_custom' + i,
  settings: 'custom_typing_settings_v1',
  romaji: 'custom_typing_romaji_style_v1',
  kind: 'custom_typing_keyboard_type_v1',
  shiftGuide: 'custom_typing_shift_guide_v1',
  calibration: 'custom_typing_calibration_v1',
  extraKeys: 'custom_typing_extra_keys_v1',
  userDict: 'custom_typing_user_dict_v1',
  tutorialDone: 'custom_typing_tutorial_done_v1',
  dateAxis: 'custom_typing_history_date_axis_v1',
  compress: 'custom_typing_compress_v1',
  history: 'custom_typing_score_history_v1',
  historyUnreadable: 'custom_typing_score_history_v1_unreadable',
  shuttle: 'custom_typing_shuttle_history_v1',
  trophies: 'custom_typing_shuttle_trophies_v1',
  lastBackup: 'custom_typing_last_backup_v1',
  snooze: 'custom_typing_backup_snooze_v1',
  reminderOff: 'custom_typing_backup_reminder_off_v1',
  dataChanged: 'custom_typing_data_changed_v1',
};
export const PREFIXES = ['custom_typing_', 'typecraft_'];
export const COMPRESSIBLE = [K.presets, K.groups, K.history, K.shuttle];

let available = true;
let failureTold = false;
let onFailure = () => {};

/** 保存できなかったときに呼ぶ関数を決める（画面に注意を出す）。 */
export function onStorageFailure(fn) { onFailure = fn; }
export function storageAvailable() { return available; }

/** 生の値（圧縮されたままのことがある）。 */
export function rawGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** 読める形の値（圧縮されていれば展開する。読めなければ null）。 */
export function lsRead(key) {
  const raw = rawGet(key);
  if (raw === null) return null;
  try { return core.decodeStored(raw); } catch { return null; }
}

export function compressionEnabled() { return rawGet(K.compress) === '1'; }

/** 保存する（圧縮の設定がオンなら、大きな 4 つのキーは圧縮して入れる）。 @returns {boolean} 保存できたか */
export function lsWrite(key, value) {
  try {
    localStorage.setItem(key, core.encodeForStorage(compressionEnabled(), key, String(value)));
    return true;
  } catch (e) {
    available = false;
    if (!failureTold) {
      failureTold = true;
      const quota = e && (e.name === 'QuotaExceededError' || e.code === 22);
      onFailure(quota
        ? '保存容量が不足しているため変更を保存できませんでした（古いスコア履歴を削除するか、バックアップを書き出してください）'
        : 'このブラウザ環境では変更を保存できません（シークレットウィンドウ・保存が無効なブラウザなど）');
    }
    return false;
  }
}

export function lsRemove(key) {
  try { localStorage.removeItem(key); } catch { /* 消せなくても続ける */ }
}

/** 保存できるかを確かめる（最初に 1 回）。 */
export function checkStorage() {
  let quota = false;
  try {
    const k = 'custom_typing__probe';
    localStorage.setItem(k, '1');
    available = localStorage.getItem(k) === '1';
    localStorage.removeItem(k);
  } catch (e) {
    available = false;
    quota = Boolean(e && (e.name === 'QuotaExceededError' || e.code === 22));
  }
  if (!available) {
    failureTold = true;
    onFailure(quota
      ? '保存容量が不足しているため変更を保存できません（古いスコア履歴を削除するか、バックアップを書き出してください）'
      : 'この画面ではデータを保存できません（プレビュー表示・シークレットウィンドウ・保存が無効なブラウザなど）');
  }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch { /* なくてもよい */ }
  return available;
}

/** このツールが保存したすべてのキー。 */
export function appKeys() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && PREFIXES.some((p) => k.startsWith(p))) keys.push(k);
    }
  } catch { /* 読めなければ空 */ }
  return keys;
}

/** このツールが使っている文字数（キー＋値。UTF-16 の単位）。 */
export function appStorageChars() {
  return appKeys().reduce((n, k) => n + k.length + (rawGet(k) || '').length, 0);
}

/** バックアップ用：[キー, 展開した値] の一覧。 */
export function appEntries() {
  return appKeys().map((k) => [k, lsRead(k)]);
}

/** 圧縮の設定を変え、今ある大きなデータを入れ直す。 @returns {{ok: boolean, before: number, after: number}|null} */
export function setCompression(on) {
  const before = appStorageChars();
  try {
    if (on) localStorage.setItem(K.compress, '1');
    else localStorage.removeItem(K.compress);
  } catch { return null; }
  let ok = true;
  for (const k of COMPRESSIBLE) {
    const raw = rawGet(k);
    if (raw === null) continue;
    const plain = lsRead(k);
    if (plain === null) { ok = false; continue; }
    if (core.encodeForStorage(on, k, plain) !== raw && !lsWrite(k, plain)) ok = false;
  }
  return { ok, before, after: appStorageChars() };
}

/** 記録や保存が増えたことを覚える（バックアップの声かけに使う）。 */
export function markDataChanged() { lsWrite(K.dataChanged, String(Date.now())); }

/** このツールのデータをすべて消す。 */
export function deleteAllAppData() {
  for (const k of appKeys()) lsRemove(k);
}

/** 乱数の id（旧版（v5）と同じ形：接頭辞＋時刻＋乱数）。 */
export function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 保存データから来た id を安全な文字だけにする（だめなら新しく作る）。 */
export function safeId(id, prefix) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : newId(prefix);
}
