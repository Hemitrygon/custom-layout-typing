// Rust（core/ の WASM）を画面から使うための包み。JSON の出し入れをここで隠す。
// 画面のコードは core/pkg/ を直接 import せず、このファイルを使う。
//
//   import { initCore, core } from './core.js';
//   await initCore();
//   core.buildKanaChunks('きゃっと', 'nihon');   // → [{kana:'きゃ', options:['KYA']}, ...]
//
// 流儀（style）は 'nihon' | 'hepburn'、キーボードの種類（kind）は 'jis' | 'us'。
// 時刻 now は performance.now() のミリ秒。Rust は時刻・乱数を自分で取らない（必ず渡す）。
// 各関数の中身は core/src/wasm.rs（と、その先の core/src/*.rs）の説明に詳しい。
import initWasm, * as w from '../../core/pkg/typing_core.js';

const J = (s) => JSON.parse(s);
const S = (v) => JSON.stringify(v);

/**
 * WASM を読み込む（最初に 1 回）。ブラウザでは引数なし。Node では WASM のバイト列を渡す。
 * @param {BufferSource | URL | string} [moduleOrPath]
 */
export async function initCore(moduleOrPath) {
  await initWasm(moduleOrPath === undefined ? undefined : { module_or_path: moduleOrPath });
  return core;
}

/**
 * @typedef {'nihon'|'hepburn'} Style
 * @typedef {'jis'|'us'} Kind
 * @typedef {{kanji: string, kana: string, romaji: string, isCustomRomaji: boolean}} Word  練習文 1 つ
 * @typedef {{kana: string, options: string[]}} Chunk  練習の 1 単位（options の先頭が標準の打ち方）
 * @typedef {{name: string, description?: string, keys: Object<string, {char: string, shiftChar?: string, finger: number, row: number}>}} Layout
 *   配列（旧版（v5）の保存の形。keys は KeyboardEvent.code → キーの文字。finger 0〜9：0 左小指 … 4 左親指、5 右親指 … 9 右小指）
 * @typedef {{s: string, r: string, user: boolean, b: string|null}} Segment  文の区切りとよみ（user：ユーザー辞書から）
 * @typedef {{kind: 'correct', sentenceDone: boolean, finished: boolean} | {kind: 'mistake', expected: string|null}
 *   | {kind: 'guarded'} | {kind: 'swallowed'} | {kind: 'notTyping'}} Outcome  1 打の結果
 */

/** 状態を持たない関数（値を渡して値を受け取る）。 */
export const core = {
  version: () => w.core_version(),

  // ---------- かな → ローマ字 ----------
  /** よみ → 練習の単位。 @returns {Chunk[]} */
  buildKanaChunks: (reading, style) => J(w.buildKanaChunks(reading, style)),
  /** 練習文 → 練習の単位（自分で決めたローマ字も反映）。 @param {Word} word @returns {Chunk[]} */
  wordChunks: (word, style) => J(w.wordChunks(S(word), style)),
  /** 標準の打ち方をつないだローマ字（表示用）。 */
  primaryRomaji: (kana, style) => w.primaryRomaji(kana, style),
  effectiveWordRomaji: (word, style) => w.effectiveWordRomaji(S(word), style),
  normalizeReading: (s) => w.normalizeReading(s),
  kanaOfText: (s) => w.kanaOfText(s),
  normalizeRomajiInput: (s) => w.normalizeRomajiInput(s),
  normalizeEnglishText: (s) => w.normalizeEnglishText(s),
  hasUnconvertedKanji: (s) => w.hasUnconvertedKanji(s),

  // ---------- スコア ----------
  /** @param {number[]} intervals 正しい打鍵の間隔（ミリ秒） @returns {{smooth: number|null, stalls: number, samples: number, mul: number}} */
  computeRhythm: (intervals) => J(w.computeRhythm(S(intervals))),
  /** @returns {{score: number, speedPts: number, accMul: number, rhythmMul: number}} */
  computeCompositeScore: (refKpm, accRatio, rhythmMul) => J(w.computeCompositeScore(refKpm, accRatio, rhythmMul)),
  /** @returns {{rank: object, next: object|null}} rank は {rank, min, tier, label, color, bg, comment} */
  scoreRank: (score) => J(w.scoreRank(score)),
  scoreRanks: () => J(w.scoreRanks()),
  /** JS の toFixed と同じ丸め。 */
  toFixed: (x, digits) => w.toFixed(x, digits),

  // ---------- 貼り付け欄・圧縮 ----------
  autoBreakLine: (line, size) => J(w.autoBreakLine(line, size)),
  isReadingSpecLine: (line) => w.isReadingSpecLine(line),
  countedLength: (s) => w.countedLength(s),
  lzCompress16: (s) => w.lzCompress16(s),
  /** @returns {{ok: true, value: string} | {ok: false, error: 'truncated'|'invalid'|'badText'}} */
  lzDecompress16: (s) => J(w.lzDecompress16(s)),
  /** 保存されていた値を読める形に（読めなければ null）。 */
  decodeStored: (raw) => J(w.decodeStored(raw)),
  encodeForStorage: (enabled, key, value) => w.encodeForStorage(enabled, key, value),

  // ---------- シャトルランの式 ----------
  shuttleRules: () => J(w.shuttleRules()),
  /** @returns {{targetKeys: number, readTime: number, kps: number, stage: number, parts: number, baseLimit: number}} */
  shuttleLevelInfo: (level) => J(w.shuttleLevelInfo(level)),
  shuttlePoolSize: () => w.shuttlePoolSize(),

  // ---------- 配列 ----------
  /** @returns {Array<Array<{code: string, label: string, row: number, finger: number, isModifier: boolean, homeBump: boolean}>>} */
  keyboardRows: (kind) => J(w.keyboardRows(kind)),
  shiftedChar: (kind, ch) => w.shiftedChar(kind, ch),
  /** 組み込みの配列（'oonishi' | 'qwerty' | 'dvorak' | 'colemak'）。 @returns {Layout|null} */
  presetLayout: (key, kind) => J(w.presetLayout(key, kind)),
  /** 保存されていた配列（古い版のものも）を整える。 @returns {Layout|null} */
  ensureLayout: (layout, kind) => J(w.ensureLayout(S(layout), kind)),
  /** 文字 → 打ち方。 @returns {Object<string, {code: string, shift: boolean}>} */
  charReach: (layout, kind) => J(w.charReach(S(layout), kind)),
  /** @returns {{missing: string[], duplicates: Array<[string, string[]]>}} */
  layoutHealth: (layout, kind) => J(w.layoutHealth(S(layout), kind)),
  generateAhk: (layout, kind) => w.generateAhk(S(layout), kind),
  /** @returns {{ok: true, layout: Layout} | {ok: false, error: string}} */
  parseAhk: (text, kind) => J(w.parseAhk(text, kind)),
  /** @returns {Layout} */
  swapKeys: (layout, kind, codeA, codeB, shiftLayer) => J(w.swapKeys(S(layout), kind, codeA, codeB, shiftLayer)),
  /** @returns {{layout: Layout, result: 'rejected'|'unchanged'|'changed', old: string|null, swappedWith: string|null}} */
  assignChar: (layout, kind, code, ch, shiftLayer, swapOnAssign) => J(w.assignChar(S(layout), kind, code, ch, shiftLayer, swapOnAssign)),
  /** 理論値の分析（行・左右・交互打鍵・同指連続）。 @param {Word[]} words */
  theoreticalTelemetry: (layout, kind, words, style, english) => J(w.theoreticalTelemetry(S(layout), kind, S(words), style, english)),
  keySignalOf: (code, key, shiftKey, withShift) => w.keySignalOf(code, key, shiftKey, withShift),

  // ---------- 辞書 ----------
  cleanDictWord: (s) => w.cleanDictWord(s),
  cleanDictReading: (s) => w.cleanDictReading(s),
  /** 送りがなだけが違う 2 つの形（憚る / 憚ら）→ {baseTail: 'る', surfTail: 'ら'}。それ以外は null */
  okuriganaTails: (base, surface) => J(w.okuriganaTails(base, surface)),

  // ---------- 記録・トロフィー・バックアップ ----------
  normalizeHistoryRecord: (record, fallbackId) => J(w.normalizeHistoryRecord(S(record), fallbackId)),
  /** @returns {{records: object[], ok: boolean}} ok が false なら、元の値を ..._unreadable に退避してから上書きする */
  loadScoreHistory: (raw, keyExists, idBase) => J(w.loadScoreHistory(raw ?? undefined, keyExists, idBase)),
  pushScoreRecord: (history, entry) => J(w.pushScoreRecord(S(history), S(entry))),
  previousBest: (history, layoutName, courseKey) => w.previousBest(S(history), layoutName, courseKey),
  loadShuttleHistory: (raw) => J(w.loadShuttleHistory(raw ?? undefined)),
  /** @returns {object[]} 記録を足した一覧（保存するときは JSON.stringify） */
  pushShuttleRecord: (historyRaw, record) => J(w.pushShuttleRecord(historyRaw ?? undefined, S(record))),
  shuttleBestFor: (layoutName, historyRaw) => J(w.shuttleBestFor(layoutName, historyRaw ?? undefined)),
  trophyTable: () => J(w.trophyTable()),
  trophyTiers: () => J(w.trophyTiers()),
  loadTrophies: (raw, historyRaw, now) => J(w.loadTrophies(raw ?? undefined, historyRaw ?? undefined, now)),
  /** @returns {{store: object, fresh: string[]}} historyRaw はこの回を含む記録 */
  updateTrophies: (raw, historyRaw, record, now) => J(w.updateTrophies(raw ?? undefined, historyRaw ?? undefined, S(record), now)),
  /** @returns {{ok: true, entries: Array<[string, string]>, exportedAt: number|null, scores: number, shuttle: number} | {ok: false, reason: string}} */
  validateBackup: (text, sizeLimit) => J(w.validateBackup(text, sizeLimit)),
  /** @param {Array<[string, string|null]>} storage localStorage の [キー, 展開した値] */
  collectAppStorage: (storage) => J(w.collectAppStorage(S(storage))),
  buildBackupText: (data, exportedAtIso) => w.buildBackupText(S(data), exportedAtIso),
  backedUpAt: (exportedAt, now) => w.backedUpAt(exportedAt ?? undefined, now),
  /** @returns {{last: number, count: number, dataChanged: boolean, since: number, due: boolean}} */
  backupReminder: (enabled, lastRaw, changedRaw, timestamps, now, snoozeRaw) =>
    J(w.backupReminder(enabled, lastRaw ?? undefined, changedRaw ?? undefined, S(timestamps), now, snoozeRaw ?? undefined)),
};

/** 1 回の練習（練習文の並びを 1 文字ずつ打つ）。 */
export class TypingSession {
  /**
   * @param {{words: Word[], langs?: Array<'ja'|'en'|null>, lang: 'ja'|'en', style: Style, kind: Kind, layout: Layout}} config
   */
  constructor(config) { this.inner = new w.TypingSession(S(config)); }
  /** @returns {Outcome} code は押したキーの位置（実測の分析用）、guarding はシャトルランの無敵中 */
  input(ch, code, now, guarding = false) { return J(this.inner.input(ch, code ?? undefined, now, guarding)); }
  /** キーが打った 2 つの文字（Shift あり・なし）のうち、判定に使う方。 */
  chooseInputChar(ch, alt) { return this.inner.chooseInputChar(ch, alt ?? undefined); }
  inputWouldMatch(ch) { return this.inner.inputWouldMatch(ch); }
  /** 次に打つ文字（ガイド用）。 */
  nextChar() { return this.inner.nextChar() ?? null; }
  /** 今の状態：{wordIndex, words, chunkIndex, chunks:[{kana, options, typed, skipped}], finished, correct, mistakes, combo, ...} */
  state() { return J(this.inner.state()); }
  /** 練習の結果（何も打たなかったら null）。meta：{elapsedMs, isEnglish, courseKey, courseName, groupName, layoutKey, layoutName, id, timestamp} */
  finish(meta) { return J(this.inner.finish(S(meta))); }
  free() { this.inner.free(); }
}

/** シャトルラン 1 回。毎フレーム tick(now) を呼び、takeEvents() で演出のきっかけを受け取る。 */
export class ShuttleGame {
  /** @param {Layout} layout @param {number} seed 出題の乱数の種（0〜2³²−1） */
  constructor(layout, kind, style, now, seed) { this.inner = new w.ShuttleGame(S(layout), kind, style, now, seed >>> 0); }
  /** @returns {Outcome} */
  input(ch, code, now) { return J(this.inner.input(ch, code ?? undefined, now)); }
  chooseInputChar(ch, alt) { return this.inner.chooseInputChar(ch, alt ?? undefined); }
  tick(now) { this.inner.tick(now); }
  pause(now) { this.inner.pause(now); }
  resume(now) { this.inner.resume(now); }
  quit() { this.inner.quit(); }
  timeLeft(now) { return this.inner.timeLeft(now); }
  guarding(now) { return this.inner.guarding(now); }
  /** @returns {Array<{kind: 'stage'|'comboBonus'|'missPenalty'|'guard'|'shieldGot'|'levelCleared'|'partCleared'|'shieldUsed'|'timeUp'|'untypeable'}>} */
  takeEvents() { return J(this.inner.takeEvents()); }
  /** {phase: 'intro'|'run'|'paused'|'over', level, stage, shields, limit, deadline, levelBase, carryIn, levelMisses, comboCount, perfectStreak,
   *   part: [何番目, いくつ中]|null, nextWord: 次の部分|null, records, freezes: [[始まり, 終わり, 'inv'|'']], word, session} */
  state() { return J(this.inner.state()); }
  /** 終わった回の記録（保存の形）。id・timestamp は画面側で作る。 */
  record(id, timestamp, now, layoutName) { return J(this.inner.record(id, timestamp, now, layoutName)); }
  free() { this.inner.free(); }
}

/** キーの読み取り（配列・キーボード調整・追加のキー）。配列や調整を変えたら作り直す。 */
export class KeyReader {
  /** calibrationRaw・extraRaw は localStorage の custom_typing_calibration_v1・custom_typing_extra_keys_v1 の値 */
  constructor(layout, kind, calibrationRaw, extraRaw) { this.inner = new w.KeyReader(S(layout), kind, calibrationRaw ?? undefined, extraRaw ?? undefined); }
  /** KeyboardEvent → 打つ文字 {code, char, altChar}（文字のキーでなければ null）。virtualShift は Shift として登録したキーを押しているか */
  resolve(e, virtualShift = false) { return J(this.inner.resolve(e.code || '', e.key || '', Boolean(e.shiftKey), virtualShift)); }
  /** {code, via: 'extra'|'calib'|'std', sig, shift}（code が '@shift' なら Shift として使うキー）か null */
  reading(e) { return J(this.inner.reading(e.code || '', e.key || '', Boolean(e.shiftKey))); }
  physicalCode(e) { return this.inner.physicalCode(e.code || '', e.key || '', Boolean(e.shiftKey)) ?? null; }
  isCalibratedCharKey(e) { return this.inner.isCalibratedCharKey(e.code || '', e.key || '', Boolean(e.shiftKey)); }
  escapeIsTypedKey() { return this.inner.escapeIsTypedKey(); }
  hasCalibration() { return this.inner.hasCalibration(); }
  /** 読み込めたキーボード調整 {map: {信号: 位置}, shiftMap: {信号: 位置}, at, shiftAt, remapped, skipped: 位置[]}（なければ null） */
  calibration() {
    const c = J(this.inner.calibrationJson());
    return c ? { ...c, map: Object.fromEntries(c.map), shiftMap: Object.fromEntries(c.shiftMap) } : null;
  }
  /** 読み込めた追加のキー {信号: 位置（'Digit1'・'Digit1+Shift'）か '@shift'} */
  extraKeys() { return Object.fromEntries(J(this.inner.extraJson())); }
  free() { this.inner.free(); }
}

/** ユーザー辞書（と内蔵の辞書）。 */
export class UserDictionary {
  /** raw は localStorage の custom_typing_user_dict_v1 の値 */
  constructor(raw) { this.inner = new w.UserDictionary(raw ?? undefined); }
  /** @returns {Array<[string, string]>} [語, よみ] */
  entries() { return J(this.inner.entriesJson()); }
  setEntries(entries) { this.inner.setEntries(S(entries)); }
  /** 保存する文字列 */
  toStorage(now) { return this.inner.toStorage(now); }
  /** @returns {Segment[]} */
  segments(s) { return J(this.inner.segments(s)); }
  apply(s) { return this.inner.apply(s); }
  hasWordIn(s) { return this.inner.hasWordIn(s); }
  /**
   * kuromoji も使ってよみを付ける。tokenizer は kuromoji の tokenizer（tokenize(文) → [{surface_form, basic_form, reading}]）。
   * @returns {Segment[]}
   */
  tokenizeWith(sentence, tokenizer) {
    // JS の例外を Rust の中に通さない（通ると、辞書のオブジェクトが「使用中」のまま残り、以後ずっと使えなくなる）。
    // tokenizer が失敗したら、内蔵の辞書だけの結果にする
    let failed = false;
    const adapter = {
      tokenizeJson: (s) => {
        try { return S(tokenizer.tokenize(s).map(t => ({ surface_form: t.surface_form, basic_form: t.basic_form, reading: t.reading }))); }
        catch { failed = true; return '[]'; }
      },
    };
    const out = J(this.inner.tokenizeWith(sentence, adapter));
    return failed ? this.segments(sentence) : out;
  }
  /** 貼り付けた 1 行 → {word, readingGiven, autoSegments} か null */
  parsePastedLine(line, style) { return J(this.inner.parsePastedLine(line, style)); }
  /** 貼り付け欄の全体 → [{word, readingGiven, autoSegments}] */
  parseMultiLine(raw, english, style) { return J(this.inner.parseMultiLine(raw, english, style)); }
  free() { this.inner.free(); }
}
