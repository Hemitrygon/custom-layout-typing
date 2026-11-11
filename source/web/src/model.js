// データの中心：設定・配列・練習文・グループ・練習する文の選び方・過去のスコア。
// 画面（DOM）にはさわらない。変わったことは bus で知らせる（'settings'・'layout'・'words'・'source'・'history' など）。
// 保存の形は旧版（v5.4.5）と同じ。計算は Rust（core）に任せる。
import { core, KeyReader, UserDictionary } from './core.js';
import { K, lsRead, lsWrite, lsRemove, rawGet, newId, safeId, markDataChanged, storageAvailable } from './store.js';
import PRESET_DATA from '../../core/data/word_presets.json';

// ---------- 知らせ ----------

const listeners = new Map();
export const bus = {
  on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); },
  emit(name, payload) { for (const fn of listeners.get(name) || []) { try { fn(payload); } catch (e) { console.error(e); } } },
};

// ---------- 状態 ----------

export const BUILTIN_LAYOUT_KEYS = ['oonishi', 'qwerty', 'dvorak', 'colemak'];
export const CUSTOM_SLOT_KEYS = ['custom1', 'custom2', 'custom3', 'custom4', 'custom5'];
export const DEFAULT_PRESETS = PRESET_DATA.presets;
const SENTENCE_FIXES = PRESET_DATA.fixes || [];
export const ORDER_LABELS = { seq: '順番どおり', shuffle: 'シャッフル', mix: '全シャッフル' };
export const SHIFT_GUIDE_LABELS = { left: '左', right: '右', opposite: '反対の手' };

export const S = {
  settings: {
    showFingerColors: true,
    showKeyGuide: true,
    showQwertySub: true,
    showRomaji: true,
    minimalMode: false,
    showKana: true,
    soundEnabled: true,
    panelSeeThrough: 50,       // 旧版（v5）の透過率。v6 では使わない（旧版（v5）に戻ったときのために、値だけ残す）
    editorAutoAdvance: true,
    editorSwapOnAssign: true,
    // v6 で足したもの
    theme: 'dark',             // 'dark' | 'light' | 'auto'（パソコンの設定に合わせる）
    keyboardView: '3d',        // 練習の画面のキーボード：'3d' | 'flat'（平らな図）
    lowQuality: false,         // 3D を軽い設定にする
  },
  kind: 'jis',
  romajiStyle: 'nihon',
  shiftGuide: 'left',
  layouts: Object.create(null),   // 組み込み 4 つ ＋ 保存枠 5 つ（元からある項目を持たない入れ物。保存データの名前が constructor などでも当たらない）
  activeLayoutKey: 'oonishi',
  layout: null,                // 今の配列（配列エディタはこれを書き換える）
  layoutDirty: false,
  reach: {},                   // 文字 → {code, shift}
  reader: null,                // KeyReader
  rows: [],                    // キーボードの行（kind ごと）
  presets: [],
  activePreset: 0,
  groups: [],
  activeGroupId: null,
  playlist: null,              // {groupId, order, queue, pos, sig, mix}
  sentenceShuffle: false,
  wordsDirty: false,
  history: [],
  dict: null,                  // UserDictionary
  liveTelemetry: null,         // 直前の練習の実測 {data, layoutName}（配列分析に出す）
};

const clone = (v) => JSON.parse(JSON.stringify(v));
const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

// ---------- 設定 ----------

export function loadSettings() {
  try {
    const parsed = JSON.parse(rawGet(K.settings) || 'null');
    if (parsed && typeof parsed === 'object') {
      for (const k of Object.keys(S.settings)) {
        if (typeof S.settings[k] === 'boolean' && typeof parsed[k] === 'boolean') S.settings[k] = parsed[k];
      }
      const see = parsed.panelSeeThrough;
      if (typeof see === 'number' && Number.isFinite(see)) S.settings.panelSeeThrough = Math.min(100, Math.max(0, Math.round(see / 5) * 5));
      if (['dark', 'light', 'auto'].includes(parsed.theme)) S.settings.theme = parsed.theme;
      if (['3d', 'flat'].includes(parsed.keyboardView)) S.settings.keyboardView = parsed.keyboardView;
      else if (parsed.flatGuide === true) S.settings.keyboardView = 'flat';   // 前のv6 の「平面のキーボードガイド」
    }
  } catch { /* 読めなければ既定のまま */ }
  const g = rawGet(K.shiftGuide);
  S.shiftGuide = Object.prototype.hasOwnProperty.call(SHIFT_GUIDE_LABELS, g || '') ? g : 'left';
  const kind = rawGet(K.kind);
  S.kind = kind === 'us' ? 'us' : 'jis';
  const style = rawGet(K.romaji);
  S.romajiStyle = style === 'hepburn' ? 'hepburn' : 'nihon';
}

export function setSetting(key, value) {
  if (!(key in S.settings)) return;
  S.settings[key] = value;
  lsWrite(K.settings, JSON.stringify(S.settings));
  bus.emit('settings', key);
}

export function setShiftGuide(v) {
  S.shiftGuide = Object.prototype.hasOwnProperty.call(SHIFT_GUIDE_LABELS, v) ? v : 'left';
  lsWrite(K.shiftGuide, S.shiftGuide);
  bus.emit('settings', 'shiftGuide');
}

export function setRomajiStyle(style) {
  S.romajiStyle = style === 'hepburn' ? 'hepburn' : 'nihon';
  lsWrite(K.romaji, S.romajiStyle);
  // 自分で決めていないローマ字は、表示用の綴りを作り直す
  for (const p of S.presets) for (const w of p.words) if (!w.isCustomRomaji) w.romaji = core.primaryRomaji(w.kana, S.romajiStyle);
  bus.emit('settings', 'romajiStyle');
  bus.emit('words');
}

// ---------- 配列 ----------

/** 組み込みの配列と保存枠を読む（キーボードの種類を変えたときも呼ぶ）。 */
export function loadLayouts() {
  S.rows = core.keyboardRows(S.kind);
  for (const key of BUILTIN_LAYOUT_KEYS) S.layouts[key] = core.presetLayout(key, S.kind);
  CUSTOM_SLOT_KEYS.forEach((key, i) => {
    let layout = null;
    try {
      const parsed = JSON.parse(rawGet(K.slot(i + 1)) || 'null');
      if (parsed && parsed.keys) layout = core.ensureLayout(parsed, S.kind);
    } catch { /* こわれていたら初期の配置 */ }
    if (!layout) {
      layout = core.presetLayout('qwerty', S.kind);
      layout.name = '保存枠 ' + (i + 1);
      layout.description = 'ユーザー保存配列 ' + (i + 1);
    }
    S.layouts[key] = layout;
  });
}

export const isCustomSlot = (key) => CUSTOM_SLOT_KEYS.includes(key);
export const slotHasData = (key) => isCustomSlot(key) && rawGet(K.slot(CUSTOM_SLOT_KEYS.indexOf(key) + 1)) !== null;

/** 配列を選ぶ（今の配列を、保存してある配列の写しにする）。 */
export function selectLayout(key, { silent = false } = {}) {
  if (!S.layouts[key]) key = 'oonishi';
  S.activeLayoutKey = key;
  S.layout = clone(S.layouts[key]);
  S.layoutDirty = false;
  lsWrite(K.lastLayout, key);
  refreshReader();
  if (!silent) bus.emit('layout');
}

// キーボード調整・追加のキーの保存データ。保存できない環境でも、この画面を開いている間は効くように、ここにも持つ
const inputTables = { loaded: false, calibration: null, extra: null };

/** 保存してあるキーボード調整・追加のキーを読み直す（起動のときと、別のウィンドウで変わったとき）。 */
export function reloadInputTables() {
  inputTables.loaded = true;
  inputTables.calibration = rawGet(K.calibration);
  inputTables.extra = rawGet(K.extraKeys);
}

/** 配列・キーボード調整・追加のキーが変わったら、文字の打ち方と読み取りを作り直す。 */
export function refreshReader() {
  if (!inputTables.loaded) reloadInputTables();
  S.reach = core.charReach(S.layout, S.kind);
  if (S.reader) S.reader.free();
  S.reader = new KeyReader(S.layout, S.kind, inputTables.calibration, inputTables.extra);
}

/**
 * キーボード調整を保存して、読み取りに反映する（null で解除）。
 * @param {{map: Object<string, string>, at: number, remapped: number, skipped: string[], shiftMap: Object<string, string>, shiftAt: number}|null} cal
 */
export function saveCalibration(cal) {
  inputTables.loaded = true;
  inputTables.calibration = cal ? JSON.stringify(cal) : null;
  if (cal) lsWrite(K.calibration, inputTables.calibration); else lsRemove(K.calibration);
  markDataChanged();
  refreshReader();
  bus.emit('reader');
}

/** 追加のキー（信号 → 位置か '@shift'）を保存して、読み取りに反映する（空なら消す）。 */
export function saveExtraKeys(map) {
  inputTables.loaded = true;
  const has = Object.keys(map).length > 0;
  inputTables.extra = has ? JSON.stringify({ map, at: Date.now() }) : null;
  if (has) lsWrite(K.extraKeys, inputTables.extra); else lsRemove(K.extraKeys);
  markDataChanged();
  refreshReader();
  bus.emit('reader');
}

/** 保存枠に保存する。 */
export function saveLayoutToSlot(slotKey, layout) {
  if (!isCustomSlot(slotKey)) return false;
  S.layouts[slotKey] = clone(layout);
  const ok = lsWrite(K.slot(CUSTOM_SLOT_KEYS.indexOf(slotKey) + 1), JSON.stringify(S.layouts[slotKey]));
  markDataChanged();
  return ok;
}

export function setKind(kind) {
  S.kind = kind === 'us' ? 'us' : 'jis';
  lsWrite(K.kind, S.kind);
  loadLayouts();
  selectLayout(S.activeLayoutKey, { silent: true });
  bus.emit('kind');
  bus.emit('layout');
}

/**
 * その文字を打つキー（ガイド用）。
 * @returns {{code: string, shift: boolean, shiftCode: string|null, finger: number}|null}
 */
export function guideFor(ch) {
  if (!ch) return null;
  const path = ch === ' ' ? { code: 'Space', shift: false } : S.reach[String(ch).toUpperCase()];
  if (!path) return null;
  const def = S.layout.keys[path.code];
  const finger = def ? def.finger : (path.code === 'Space' ? 5 : 0);
  let shiftCode = null;
  if (path.shift) shiftCode = S.shiftGuide === 'right' || (S.shiftGuide === 'opposite' && finger <= 4) ? 'ShiftRight' : 'ShiftLeft';
  return { code: path.code, shift: Boolean(path.shift), shiftCode, finger };
}

// ---------- 練習文 ----------

function buildDefaultPreset(def) {
  return {
    id: 'builtin-' + def.builtinId,
    builtinId: def.builtinId,
    name: def.name,
    themeHint: def.themeHint,
    lang: 'ja',
    words: def.words.map((w) => ({ kanji: w.kanji, kana: w.kana, romaji: core.primaryRomaji(w.kana, S.romajiStyle), isCustomRomaji: false })),
  };
}

export const isBuiltinPreset = (p) => Boolean(p && p.builtinId);
export const defaultPresetOf = (builtinId) => { const d = DEFAULT_PRESETS.find((x) => x.builtinId === builtinId); return d ? buildDefaultPreset(d) : null; };

function fixBuiltinSentences(presets) {
  let changed = false;
  for (const p of presets) {
    for (const [id, from, to] of SENTENCE_FIXES) {
      if (p.builtinId !== id) continue;
      for (const w of p.words) if (w.kanji === from) { w.kanji = to; changed = true; }
    }
  }
  return changed;
}

// 古い保存データ：標準のプリセットを足し、順番と名前の番号をそろえる（旧版（v5）の ensureBuiltinPresets と同じ）
function ensureBuiltinPresets() {
  const presets = S.presets;
  const activeRef = presets[S.activePreset];
  let changed = false;
  if (!presets.some((p) => p.builtinId === 'iroha')) {
    const first = presets[0];
    if (first && !first.builtinId && (first.themeHint === 'いろは歌' || first.name === 'プリセット 1')) first.builtinId = 'iroha';
    else presets.unshift(buildDefaultPreset(DEFAULT_PRESETS[0]));
    changed = true;
  }
  if (!presets.some((p) => p.builtinId === 'kokoro')) {
    presets.push(buildDefaultPreset(DEFAULT_PRESETS[1]));
    changed = true;
  }
  if (!changed) {
    for (const def of DEFAULT_PRESETS) {
      if (presets.some((p) => p.builtinId === def.builtinId)) continue;
      const added = buildDefaultPreset(def);
      added.name = 'プリセット ' + (presets.length + 1);
      presets.push(added);
      changed = true;
    }
    for (const p of presets) {
      if (!p.id) { p.id = p.builtinId ? 'builtin-' + p.builtinId : newId('p_'); changed = true; }
      if (p.builtinId) p.lang = 'ja';
    }
    return changed;
  }
  const ordered = [
    ...DEFAULT_PRESETS.map((def) => presets.find((p) => p.builtinId === def.builtinId) || buildDefaultPreset(def)),
    ...presets.filter((p) => !p.builtinId),
  ];
  ordered.forEach((p, i) => {
    if (!p.id) p.id = p.builtinId ? 'builtin-' + p.builtinId : newId('p_');
    if (p.builtinId) p.lang = 'ja';
    else if (/^プリセット \d+$/.test(p.name) && p.name !== 'プリセット ' + (i + 1)) p.name = 'プリセット ' + (i + 1);
  });
  S.presets = ordered;
  const idx = ordered.indexOf(activeRef);
  S.activePreset = idx >= 0 ? idx : 0;
  return true;
}

/** 保存されていた練習文の 1 つを整える。 */
export function normalizeWord(w) {
  const kana = core.normalizeReading(str(w.kana));
  const custom = Boolean(w.isCustomRomaji) && Boolean(str(w.romaji));
  return {
    kanji: str(w.kanji),
    kana,
    isCustomRomaji: custom,
    romaji: custom ? core.normalizeRomajiInput(str(w.romaji)) : core.primaryRomaji(kana, S.romajiStyle),
  };
}

export function loadWords(readOnly = false) {
  try {
    const saved = lsRead(K.presets);
    if (saved) {
      const parsed = JSON.parse(saved);
      const list = Array.isArray(parsed) ? parsed.filter((p) => p && typeof p === 'object') : [];
      if (list.length >= 1) {
        const used = new Set();
        S.presets = list.map((p, i) => {
          let id = typeof p.id === 'string' && p.id ? safeId(p.id, 'p_') : undefined;
          if (id && used.has(id)) id = newId('p_');
          if (id) used.add(id);
          return {
            name: str(p.name).slice(0, 40) || 'プリセット ' + (i + 1),
            themeHint: str(p.themeHint).slice(0, 40) || 'カスタム',
            lang: p.lang === 'en' ? 'en' : 'ja',
            builtinId: DEFAULT_PRESETS.some((d) => d.builtinId === p.builtinId) ? p.builtinId : undefined,
            id,
            words: Array.isArray(p.words) ? p.words.filter((w) => w && typeof w === 'object').map(normalizeWord) : [],
          };
        });
        const idx = parseInt(rawGet(K.activePreset) || '0', 10);
        S.activePreset = !Number.isNaN(idx) && idx >= 0 && idx < S.presets.length ? idx : 0;
        const fixed = fixBuiltinSentences(S.presets);
        if ((ensureBuiltinPresets() || fixed) && !readOnly) saveWords();
        S.wordsDirty = false;
        return;
      }
    }
  } catch { /* 読めなければ初期の練習文 */ }
  S.presets = DEFAULT_PRESETS.map(buildDefaultPreset);
  S.activePreset = 0;
  if (!readOnly) {
    // 読めなかった練習文は別のキーに残す（初期の文で上書きして失わない）
    const old = rawGet(K.presets);
    if (old && old !== '[]') { try { localStorage.setItem(K.presetsUnreadable, old); } catch { /* 残せなくても続ける */ } }
    saveWords();
  }
}

/** 練習文・グループを保存する。 @returns {boolean} 全部保存できたか */
export function saveWords() {
  let ok = lsWrite(K.presets, JSON.stringify(S.presets));
  if (S.groupsLoaded) ok = lsWrite(K.groups, JSON.stringify(S.groups)) && ok;
  ok = lsWrite(K.activePreset, String(S.activePreset)) && ok;
  ok = lsWrite(K.romaji, S.romajiStyle) && ok;
  return ok;
}

export const currentPreset = () => S.presets[S.activePreset] || null;
export const currentWords = () => (currentPreset() ? currentPreset().words : []);
export const currentLang = () => (currentPreset() && currentPreset().lang === 'en' ? 'en' : 'ja');
export const presetById = (id) => S.presets.find((p) => p.id === id) || null;
export const presetIndexById = (id) => S.presets.findIndex((p) => p.id === id);

export function loadGroups() {
  let groups = null;
  try { const raw = lsRead(K.groups); if (raw) groups = JSON.parse(raw); } catch { /* 既定のグループ */ }
  const ids = new Set(S.presets.map((p) => p.id));
  if (!Array.isArray(groups)) groups = [{ id: 'g_default', name: '標準セット', presetIds: DEFAULT_PRESETS.map((d) => 'builtin-' + d.builtinId) }];
  const used = new Set();
  S.groups = groups.filter((g) => g && typeof g === 'object').map((g) => {
    let id = safeId(g.id, 'g_');
    if (used.has(id)) id = newId('g_');
    used.add(id);
    return {
      id,
      name: (typeof g.name === 'string' || typeof g.name === 'number' ? String(g.name).trim().slice(0, 40) : '') || 'グループ',
      presetIds: Array.isArray(g.presetIds) ? g.presetIds.filter((pid) => ids.has(pid)) : [],
    };
  });
  S.groupsLoaded = true;
  if (!S.groups.some((g) => g.id === S.activeGroupId)) S.activeGroupId = S.groups[0] ? S.groups[0].id : null;
}

export const groupById = (id) => S.groups.find((g) => g.id === id) || null;

// ---------- 練習する文の選び方（プリセットのくり返し／グループ） ----------

export function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const normOrder = (o) => (o === 'shuffle' || o === 'mix' ? o : 'seq');
const playableIds = (group) => group.presetIds.filter((pid) => { const p = presetById(pid); return p && p.words.length > 0; });

function buildQueue(group, order, firstId) {
  let ids = playableIds(group);
  if (order === 'shuffle') {
    ids = shuffled(ids);
    if (firstId && ids.includes(firstId)) ids = [firstId, ...ids.filter((x) => x !== firstId)];
  }
  return ids;
}

const groupSentenceTotal = (group) => playableIds(group).reduce((n, pid) => n + presetById(pid).words.length, 0);

// 全シャッフル：グループのすべての文を混ぜ、プリセット 1 つ分の平均の数ずつ出す
function newMix(group) {
  const ids = playableIds(group);
  const pool = [];
  for (const pid of ids) for (const w of presetById(pid).words) pool.push({ pid, w });
  return { pool: shuffled(pool), cursor: 0, size: ids.length ? Math.max(1, Math.round(pool.length / ids.length)) : 0, total: pool.length };
}

function ensureMix(pl, group) {
  const mix = pl.mix;
  let valid = Boolean(mix && mix.pool.length && mix.total === groupSentenceTotal(group));
  if (valid) {
    const sets = {};
    const playable = playableIds(group);
    valid = mix.pool.every((e) => {
      if (!sets[e.pid]) { const p = presetById(e.pid); sets[e.pid] = new Set(p && playable.includes(e.pid) ? p.words : []); }
      return sets[e.pid].has(e.w);
    });
  }
  if (!valid) pl.mix = newMix(group);
  return pl.mix;
}

export const isMix = () => Boolean(S.playlist && S.playlist.order === 'mix' && S.playlist.mix);
export const mixChunk = () => { const m = S.playlist && S.playlist.mix; return m ? m.pool.slice(m.cursor, m.cursor + m.size) : []; };
const savedOrder = () => { try { return normOrder(JSON.parse(rawGet(K.source) || '{}').order); } catch { return 'seq'; } };

function saveSource() {
  const data = S.playlist ? { type: 'group', groupId: S.playlist.groupId, order: S.playlist.order } : { type: 'preset', order: savedOrder() };
  lsWrite(K.source, JSON.stringify(data));
}

/** 記録に残すコース（練習文のまとまり）。 */
export function courseInfo() {
  if (isMix()) {
    const g = groupById(S.playlist.groupId);
    return { key: 'g:' + S.playlist.groupId + ':mix', name: (g ? g.name : 'グループ') + '（全シャッフル）' };
  }
  const p = currentPreset();
  return { key: p && p.id ? 'p:' + p.id : 'name:' + (p ? p.name : ''), name: p ? p.name : 'プリセット' };
}

function setActivePresetSilently(presetId) {
  const idx = presetIndexById(presetId);
  if (idx < 0) return;
  S.activePreset = idx;
  if (!S.wordsDirty) lsWrite(K.activePreset, String(idx));
}

/** プリセットを選ぶ（くり返し練習）。 */
export function selectPreset(idx) {
  if (idx < 0 || idx >= S.presets.length) return;
  S.playlist = null;
  S.activePreset = idx;
  if (!S.wordsDirty) lsWrite(K.activePreset, String(idx));
  saveSource();
  bus.emit('source');
}

/** グループを選ぶ（プレイリスト）。 @returns {string|null} だめなときの理由 */
export function startPlaylist(groupId, order) {
  const g = groupById(groupId);
  if (!g) return 'グループが見つかりません';
  const ord = normOrder(order ?? (S.playlist ? S.playlist.order : savedOrder()));
  const queue = buildQueue(g, ord);
  if (!queue.length) return 'このグループには練習文を含むプリセットがありません';
  S.playlist = { groupId, order: ord, queue, pos: 0, sig: g.presetIds.join(','), mix: ord === 'mix' ? newMix(g) : null };
  saveSource();
  setActivePresetSilently(queue[0]);
  bus.emit('source');
  return null;
}

export function restoreSource() {
  try {
    const raw = JSON.parse(rawGet(K.source) || 'null');
    if (raw && raw.type === 'group' && groupById(raw.groupId)) startPlaylist(raw.groupId, raw.order);
  } catch { /* プリセットのくり返しのまま */ }
}

/** グループや練習文が変わったあと、再生の並びを合わせ直す。 @returns {string|null} 知らせる文 */
export function syncPlaylist() {
  const pl = S.playlist;
  if (!pl) return null;
  const g = groupById(pl.groupId);
  if (!g) { S.playlist = null; saveSource(); bus.emit('source'); return 'グループが見つからないため、プリセットの繰り返し練習に戻しました'; }
  const current = pl.queue[pl.pos];
  const playable = playableIds(g);
  if (g.presetIds.join(',') !== pl.sig || !playable.includes(current) || pl.queue.some((id) => !playable.includes(id))) {
    const q = buildQueue(g, pl.order, playable.includes(current) ? current : null);
    if (!q.length) { S.playlist = null; saveSource(); bus.emit('source'); return 'グループに練習文がないため、プリセットの繰り返し練習に戻しました'; }
    pl.queue = q;
    pl.pos = Math.max(0, q.indexOf(current));
    pl.sig = g.presetIds.join(',');
  }
  if (pl.order === 'mix') ensureMix(pl, g);
  if (currentPreset() !== presetById(pl.queue[pl.pos])) setActivePresetSilently(pl.queue[pl.pos]);
  return null;
}

/** 練習の順番（順番に・シャッフル・全シャッフル）。同じものをもう一度選ぶと引き直す。 @returns {string} 知らせる文 */
export function setPlaylistOrder(order) {
  const pl = S.playlist;
  const g = pl ? groupById(pl.groupId) : null;
  if (!pl || !g) return '';
  const current = pl.queue[pl.pos];
  const ord = normOrder(order);
  const again = pl.order === ord;
  pl.order = ord;
  pl.mix = null;
  if (ord === 'seq') {
    pl.queue = buildQueue(g, 'seq');
    pl.pos = Math.max(0, pl.queue.indexOf(current));
  } else {
    pl.queue = buildQueue(g, ord);
    pl.pos = 0;
    if (ord === 'mix') pl.mix = newMix(g);
  }
  if (!pl.queue.length) return syncPlaylist() || '';
  saveSource();
  setActivePresetSilently(pl.queue[pl.pos]);
  bus.emit('source');
  return ord === 'seq' ? 'グループの順番どおりに練習します'
    : ord === 'shuffle' ? (again ? 'プリセットの順番を引き直しました' : 'プリセットをシャッフルして練習します')
      : (again ? '文の順番を引き直しました' : 'グループ内の全ての文を混ぜて練習します');
}

export function playlistJump(pos) {
  const pl = S.playlist;
  if (!pl || pl.order === 'mix' || pos < 0 || pos >= pl.queue.length) return;
  pl.pos = pos;
  setActivePresetSilently(pl.queue[pos]);
  bus.emit('source');
}

export function nextTrackName() {
  const pl = S.playlist;
  if (!pl) return '';
  if (pl.order === 'mix' && pl.mix) {
    const left = pl.mix.pool.length - (pl.mix.cursor + pl.mix.size);
    return left > 0 ? '次の ' + Math.min(left, pl.mix.size) + ' 文' : '新しい順番で最初へ';
  }
  const nextId = pl.pos + 1 < pl.queue.length ? pl.queue[pl.pos + 1] : (pl.order === 'seq' ? pl.queue[0] : null);
  const p = nextId ? presetById(nextId) : null;
  return p ? p.name : '新しい順番で最初へ';
}

/** グループの次へ進む。 @returns {string|null} 知らせる文 */
export function playlistAdvance() {
  const pl = S.playlist;
  if (!pl) return null;
  const g = groupById(pl.groupId);
  let note = null;
  if (pl.order === 'mix') {
    const before = pl.mix;
    if (g) ensureMix(pl, g);
    if (pl.mix && pl.mix === before) {
      pl.mix.cursor += pl.mix.size;
      if (pl.mix.cursor >= pl.mix.pool.length) {
        pl.mix = g ? newMix(g) : null;
        note = 'グループの全ての文を一巡したため、新しい順番で続けます';
      }
    }
  } else {
    pl.pos++;
    if (pl.pos >= pl.queue.length) {
      const last = pl.queue[pl.queue.length - 1];
      const q = g ? buildQueue(g, pl.order) : [];
      if (pl.order === 'shuffle' && q.length > 1 && q[0] === last) q.push(q.shift());
      pl.queue = q;
      pl.pos = 0;
      note = 'グループを一巡したため、' + (pl.order === 'shuffle' ? '新しい順番で' : '最初から') + '続けます';
    }
  }
  const lost = syncPlaylist();
  bus.emit('source');
  return lost || note;
}

/** 今から練習する文の並び（1 回分）。 */
export function sessionWords() {
  if (isMix()) {
    const chunk = mixChunk();
    return {
      words: chunk.map((e) => e.w),
      langs: chunk.map((e) => { const p = presetById(e.pid); return p && p.lang === 'en' ? 'en' : 'ja'; }),
      lang: currentLang(),
    };
  }
  const words = S.sentenceShuffle ? shuffled(currentWords()) : currentWords().slice();
  return { words, langs: null, lang: currentLang() };
}

/** 待機画面に出す、これから練習する文の数。 */
export const sessionSize = () => (isMix() ? mixChunk().length : currentWords().length);

// ---------- 過去のスコア ----------

/** @returns {boolean} 読めたか */
export function loadHistory() {
  const raw = lsRead(K.history);
  const r = core.loadScoreHistory(raw, rawGet(K.history) !== null, newId('r_'));
  S.history = r.records;
  return r.ok;
}

export function saveHistory() { lsWrite(K.history, JSON.stringify(S.history)); }

/** 練習の記録を足して保存する。 */
export function recordScore(entry) {
  // 今保存されているものから始める（別のウィンドウで保存された回を消さない）
  if (storageAvailable() && !loadHistory()) {
    // 読めない（こわれた）記録は、上書きせず別のキーに残す
    const old = rawGet(K.history);
    if (old !== null) { try { localStorage.setItem(K.historyUnreadable, old); } catch { /* 残せなくても続ける */ } }
  }
  S.history = core.pushScoreRecord(S.history, entry);
  saveHistory();
  bus.emit('history');
}

// ---------- 辞書 ----------

export function loadDict() {
  if (S.dict) S.dict.free();
  S.dict = new UserDictionary(lsRead(K.userDict));
}

export function saveDict() {
  lsWrite(K.userDict, S.dict.toStorage(Date.now()));
  markDataChanged();
}

// ---------- まとめて読む ----------

export function loadAll() {
  loadSettings();
  loadDict();
  loadLayouts();
  loadWords();
  loadGroups();
  loadHistory();
  const saved = rawGet(K.lastLayout);
  selectLayout(saved && S.layouts[saved] ? saved : 'oonishi', { silent: true });
  restoreSource();
}

export { clone };
