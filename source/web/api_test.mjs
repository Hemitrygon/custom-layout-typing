// WASM の口（core/src/wasm.rs）を、ビルドした core/pkg/ から実際に呼んで確かめる（Node で動かす）。
//     node api_test.mjs        （web/ の中で。先に core/ で wasm-pack build --target web）
// 正解データ（core/tests/golden/）の一部とも照らし合わせ、JSON の受け渡しで値が変わらないことを見る。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '../core/pkg');
const GOLDEN = resolve(HERE, '../core/tests/golden');
const core = await import(resolve(PKG, 'typing_core.js'));
await core.default({ module_or_path: readFileSync(resolve(PKG, 'typing_core_bg.wasm')) });

let pass = 0, fail = 0;
const check = (ok, what) => { if (ok) pass++; else { fail++; if (fail <= 10) console.log('FAIL ' + what); } };
// 並びを問わず中身で比べる（オブジェクトのキーを並べ替えてから文字列に）
const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const eq = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const golden = name => JSON.parse(readFileSync(resolve(GOLDEN, name + '.json'), 'utf8'));
const J = s => JSON.parse(s);

// ---------- かな → ローマ字（正解データと） ----------
const kana = golden('kana');
for (const c of kana.chunks) {
  const got = J(core.buildKanaChunks(c.r, c.style)).map(x => [x.kana, x.options]);
  check(eq(got, c.out), 'buildKanaChunks ' + c.r);
  check(core.primaryRomaji(c.r, c.style) === c.primary, 'primaryRomaji ' + c.r);
}
for (const c of kana.words) {
  const w = { kanji: '', kana: c.kana, romaji: c.romaji, isCustomRomaji: true };
  check(eq(J(core.wordChunks(JSON.stringify(w), c.style)).map(x => [x.kana, x.options]), c.custom), 'wordChunks ' + c.kana);
  check(core.effectiveWordRomaji(JSON.stringify(w), c.style) === c.effective, 'effectiveWordRomaji');
}

// ---------- スコア・圧縮・自動改行（正解データと） ----------
const score = golden('score');
for (const c of score.composite) {
  const r = c.rhythm === null ? undefined : score.rhythm[c.rhythm].out.mul;
  check(J(core.computeCompositeScore(c.refKpm, c.accRatio, r)).score === c.out.score, 'computeCompositeScore');
}
for (const c of score.rhythm) check(eq(J(core.computeRhythm(JSON.stringify(c.intervals))), c.out), 'computeRhythm');
for (const c of score.ranks) {
  const r = J(core.scoreRank(c.score));
  check(r.rank.rank === c.rank && (r.next ? r.next.rank : null) === c.next, 'scoreRank ' + c.score);
}
const lz = golden('lz');
for (const c of lz.compressed) {
  check(core.lzCompress16(c.s) === c.c, 'lzCompress16');
  check(eq(J(core.lzDecompress16(c.c)), { ok: true, value: c.s }), 'lzDecompress16');
}
for (const c of lz.stored) check(J(core.decodeStored(c.raw)) === c.out, 'decodeStored');
const text = golden('text');
for (const c of text.breaks.slice(0, 800)) check(eq(J(core.autoBreakLine(c.line, c.size)), c.out), 'autoBreakLine');

// ---------- 配列 ----------
const layout = golden('layout');
for (const p of layout.jis.presets) {
  const l = J(core.presetLayout(p.key, 'jis'));
  check(eq(l, p.layout), 'presetLayout ' + p.key);
  check(core.generateAhk(JSON.stringify(l), 'jis') === p.ahk, 'generateAhk ' + p.key);
  const back = J(core.parseAhk(p.ahk, 'jis'));
  check(p.key === 'qwerty' ? !back.ok : back.ok, 'parseAhk ' + p.key);
}
const qwerty = core.presetLayout('qwerty', 'jis');
check(J(core.charReach(qwerty, 'jis'))['!'].code === 'Digit1', 'charReach');
check(J(core.layoutHealth(qwerty, 'jis')).missing.length === 0, 'layoutHealth');
const assigned = J(core.assignChar(qwerty, 'jis', 'KeyA', 'q', false, true));
check(assigned.result === 'changed' && assigned.swappedWith === 'KeyQ' && assigned.layout.keys.KeyQ.char === 'A', 'assignChar');
check(J(core.keyboardRows('us'))[0][0].code === 'Backquote', 'keyboardRows');

// ---------- キーの読み取り ----------
const reader = new core.KeyReader(qwerty, 'jis', undefined, undefined);
check(eq(J(reader.resolve('Digit1', '!', true, false)), { code: 'Digit1', char: '!', altChar: '1' }), 'KeyReader.resolve');
check(reader.resolve('Space', ' ', false, false) === 'null', 'KeyReader.resolve Space');
const cal = new core.KeyReader(qwerty, 'jis', '{"map":{"KeyA":"KeyS"}}', undefined);
check(J(cal.resolve('KeyA', 'a', false, false)).char === 'S' && cal.hasCalibration(), 'KeyReader 調整');

// ---------- 練習：1 文を打ち切る ----------
const session = new core.TypingSession(JSON.stringify({ words: [{ kanji: '漢字', kana: 'かんじ', romaji: '', isCustomRomaji: false }], lang: 'ja', style: 'nihon', kind: 'jis', layout: J(qwerty) }));
const outs = [...'KANZI'].map((ch, i) => J(session.input(ch, null, i * 200, false)));
check(outs[4].kind === 'correct' && outs[4].finished, 'TypingSession 打ち切り');
const fin = J(session.finish(JSON.stringify({ elapsedMs: 1000, courseKey: 'c', courseName: 'n', layoutKey: 'qwerty', layoutName: 'QWERTY', id: 'r_t', timestamp: 1 })));
check(fin.record && fin.record.completedChars === 5 && fin.rank.rank, 'TypingSession.finish');

// ---------- シャトルラン：正しく打ち続け、その後は打たずに時間切れまで ----------
const game = new core.ShuttleGame(qwerty, 'jis', 'nihon', 0, 12345);
let now = 0;
for (let k = 0; k < 400; k++) {
  now += 150;
  game.tick(now);
  const st = J(game.state());
  if (st.phase !== 'run') break;
  game.input(st.session.nextChar, null, now);
}
const mid = J(game.state());
check(mid.level > 3, 'ShuttleGame レベルが進む（' + mid.level + '）');
for (let k = 0; k < 2000 && J(game.state()).phase === 'run'; k++) { now += 100; game.tick(now); }
const events = J(game.takeEvents()).map(e => e.kind);
check(J(game.state()).phase === 'over' && events.includes('timeUp') && events.includes('levelCleared'), 'ShuttleGame 時間切れ');
const rec = J(game.record('s_t', 1700000000000, now, 'QWERTY'));
check(rec.level === mid.level || rec.level >= mid.level, 'ShuttleGame.record');
const upd = J(core.updateTrophies(undefined, JSON.stringify([rec]), JSON.stringify(rec), 0));
check(Array.isArray(upd.fresh) && upd.store.runs === 1, 'updateTrophies');

// ---------- 辞書（kuromoji の代わりに 1 文字ずつ） ----------
const ud = new core.UserDictionary(undefined);
const tokenizer = { tokenizeJson: s => JSON.stringify([...s].map(c => ({ surface_form: c, basic_form: c, reading: '*' }))) };
check(J(ud.tokenizeWith('憚らず', tokenizer)).map(x => x.r).join('') === 'はばからず', 'UserDictionary.tokenizeWith');
check(J(ud.parsePastedLine('漢字|かんじ', 'nihon')).word.romaji === 'KANZI', 'parsePastedLine');
check(J(ud.parseMultiLine('今日\n\n練習(れんしゅう)', false, 'hepburn')).length === 2, 'parseMultiLine');

// ---------- バックアップ ----------
const data = [['custom_typing_score_history_v1', '[]'], ['typecraft_qwerty_base_custom1', '{}']];
const backup = core.buildBackupText(JSON.stringify(data), '2026-11-10T05:00:00.000Z');
const v = J(core.validateBackup(backup, 20 * 1024 * 1024));
check(v.ok && v.entries.length === 2 && v.exportedAt === Date.parse('2026-11-10T05:00:00.000Z'), 'validateBackup');
check(J(core.validateBackup('{}', undefined)).reason === 'このツールのバックアップファイルではありません', 'validateBackup 拒否');
check(core.toFixed(0.25, 1) === (0.25).toFixed(1), 'toFixed');

// ---------- 画面向けの包み（src/core.js）：すべての関数・メソッドを 1 回ずつ ----------
{
  const { core: c, TypingSession: TS, ShuttleGame: SG, KeyReader: KR, UserDictionary: UD } = await import('./src/core.js');
  const q = c.presetLayout('qwerty', 'jis');
  const word = { kanji: '漢字', kana: 'かんじ', romaji: '', isCustomRomaji: false };
  const calls = {
    version: () => c.version() === '0.1.0',
    buildKanaChunks: () => c.buildKanaChunks('きゃっと', 'nihon')[1].options[0] === 'T',
    wordChunks: () => c.wordChunks(word, 'hepburn')[2].options[0] === 'JI',
    primaryRomaji: () => c.primaryRomaji('しち', 'hepburn') === 'SHICHI',
    effectiveWordRomaji: () => c.effectiveWordRomaji(word, 'nihon') === 'KANZI',
    normalizeReading: () => c.normalizeReading(' カナ ') === 'かな',
    kanaOfText: () => c.kanaOfText('ＡＢ　カ') === 'AB か',
    normalizeRomajiInput: () => c.normalizeRomajiInput('ｋａ-n') === 'KA-N',
    normalizeEnglishText: () => c.normalizeEnglishText(' a  “b” ') === 'a "b"',
    hasUnconvertedKanji: () => c.hasUnconvertedKanji('漢'),
    computeRhythm: () => c.computeRhythm([]).mul === 0.9,
    computeCompositeScore: () => c.computeCompositeScore(300, 0.97, 0.9).score > 0,
    scoreRank: () => c.scoreRank(3400).rank.rank === 'SSS',
    scoreRanks: () => c.scoreRanks().length === 18,
    toFixed: () => c.toFixed(1.005, 2) === '1.00',
    autoBreakLine: () => c.autoBreakLine('あいうえおかきくけこさしすせそ', 6).length === 2,
    isReadingSpecLine: () => c.isReadingSpecLine('a|b'),
    countedLength: () => c.countedLength('a b') === 2,
    lzCompress16: () => c.lzDecompress16(c.lzCompress16('あいう')).value === 'あいう',
    lzDecompress16: () => c.lzDecompress16('').ok,
    decodeStored: () => c.decodeStored('plain') === 'plain',
    encodeForStorage: () => c.encodeForStorage(false, 'k', 'v') === 'v',
    shuttleRules: () => c.shuttleRules().comboEvery === 20,
    shuttleLevelInfo: () => c.shuttleLevelInfo(18).parts === 2,
    shuttlePoolSize: () => c.shuttlePoolSize() === 821,
    keyboardRows: () => c.keyboardRows('jis').length === 5,
    shiftedChar: () => c.shiftedChar('us', '2') === '@',
    presetLayout: () => q.keys.KeyA.char === 'A',
    ensureLayout: () => c.ensureLayout({ name: 'x', keys: {} }, 'jis').keys.KeyA.char === 'A',
    charReach: () => c.charReach(q, 'jis').A.code === 'KeyA',
    layoutHealth: () => c.layoutHealth(q, 'jis').missing.length === 0,
    generateAhk: () => c.generateAhk(q, 'jis').includes('#UseHook'),
    parseAhk: () => c.parseAhk('a::b', 'jis').layout.keys.KeyA.char === 'B',
    swapKeys: () => c.swapKeys(q, 'jis', 'KeyA', 'KeyS', false).keys.KeyA.char === 'S',
    assignChar: () => c.assignChar(q, 'jis', 'KeyA', 'z', false, false).result === 'changed',
    theoreticalTelemetry: () => c.theoreticalTelemetry(q, 'jis', [word], 'nihon', false).totalHits === 5,
    keySignalOf: () => c.keySignalOf('KeyA', 'a', true, true) === 'KeyA+Shift',
    cleanDictWord: () => c.cleanDictWord(' 語 ') === '語',
    cleanDictReading: () => c.cleanDictReading('カ ナ') === 'かな',
    okuriganaTails: () => { const t = c.okuriganaTails('憚る', '憚ら'); return t.baseTail === 'る' && t.surfTail === 'ら' && c.okuriganaTails('歩く', '走ら') === null; },
    normalizeHistoryRecord: () => c.normalizeHistoryRecord({ wpm: 100 }, 'r_new').id === 'r_new',
    loadScoreHistory: () => c.loadScoreHistory(null, false, 'r_').ok,
    pushScoreRecord: () => c.pushScoreRecord([], { score: 1 }).length === 1,
    previousBest: () => c.previousBest([{ layoutName: 'L', courseKey: 'c', score: 5 }], 'L', 'c') === 5,
    loadShuttleHistory: () => c.loadShuttleHistory(null).length === 0,
    pushShuttleRecord: () => c.pushShuttleRecord(null, { cleared: 1, timestamp: 1 }).length === 1,
    shuttleBestFor: () => c.shuttleBestFor('L', null) === null,
    trophyTable: () => c.trophyTable().length === 19,
    trophyTiers: () => c.trophyTiers().length === 6,
    loadTrophies: () => c.loadTrophies(null, null, 0).runs === 0,
    updateTrophies: () => c.updateTrophies('{}', null, { cleared: 4, timestamp: 9, level: 5 }, 0).fresh.includes('lv5'),
    validateBackup: () => c.validateBackup('x').ok === false,
    collectAppStorage: () => c.collectAppStorage([['custom_typing_a', '1'], ['other', '2']]).length === 1,
    buildBackupText: () => c.validateBackup(c.buildBackupText([['custom_typing_a', '1']], '2026-01-01T00:00:00Z')).ok,
    backedUpAt: () => c.backedUpAt(null, 5) === 5,
    backupReminder: () => c.backupReminder(true, null, null, [], 0, null).due === false,
  };
  for (const name of Object.keys(c)) check(name in calls, '包みの関数にテストがない：' + name);
  for (const [name, fn] of Object.entries(calls)) { let ok = false; try { ok = fn(); } catch (e) { console.log(name, e); } check(ok, '包み core.' + name); }
  const ts = new TS({ words: [word], lang: 'ja', style: 'nihon', kind: 'jis', layout: q });
  check(ts.nextChar() === 'K' && ts.inputWouldMatch('K') && ts.chooseInputChar('!', 'K') === 'K', '包み TypingSession');
  [...'KANZI'].forEach((ch, i) => ts.input(ch, null, i * 100));
  check(ts.state().finished && ts.finish({ elapsedMs: 1000, id: 'r', timestamp: 1 }).record.completedChars === 5, '包み TypingSession.finish');
  ts.free();
  const sg = new SG(q, 'jis', 'nihon', 0, 7);
  const st = sg.state();
  check(st.phase === 'run' && sg.input(st.session.nextChar, null, 10).kind === 'correct', '包み ShuttleGame.input');
  check(sg.chooseInputChar('!', sg.state().session.nextChar) === sg.state().session.nextChar && Array.isArray(sg.state().part), '包み ShuttleGame.chooseInputChar');
  sg.pause(20); check(sg.state().phase === 'paused', '包み ShuttleGame.pause'); sg.resume(30);
  sg.tick(40); check(sg.timeLeft(40) > 0 && !sg.guarding(40) && Array.isArray(sg.takeEvents()), '包み ShuttleGame.tick');
  check(sg.record('s', 1, 50, 'QWERTY').level === 1, '包み ShuttleGame.record'); sg.quit(); check(sg.state().phase === 'intro', '包み ShuttleGame.quit'); sg.free();
  const kr = new KR(q, 'jis', null, '{"map":{"F13":"@shift"}}');
  check(kr.resolve({ code: 'KeyA', key: 'a', shiftKey: false }).char === 'A' && kr.reading({ code: 'F13', key: 'F13' }).code === '@shift', '包み KeyReader');
  check(kr.physicalCode({ code: 'KeyA', key: 'a' }) === 'KeyA' && !kr.isCalibratedCharKey({ code: 'KeyA', key: 'a' }) && !kr.escapeIsTypedKey() && !kr.hasCalibration(), '包み KeyReader 2');
  check(kr.calibration() === null && kr.extraKeys().F13 === '@shift', '包み KeyReader.extraKeys');
  kr.free();
  // 調整の中身：使えない項目（知らない位置・Shift の位置）は除かれ、位置が変わった数が数えられる
  const kc = new KR(q, 'jis', '{"map":{"KeyA":"KeyS","KeyB":"KeyB","KeyC":"Nowhere","KeyD":"ShiftLeft"},"shiftMap":{"Digit2":"Digit1"},"at":5,"shiftAt":7,"skipped":["KeyZ","Nowhere"]}', '{"map":{"Numpad1":"Digit1","F14":"Digit1+Shift","F15":"Nowhere"}}');
  const calInfo = kc.calibration();
  check(JSON.stringify(calInfo) === JSON.stringify({ map: { KeyA: 'KeyS', KeyB: 'KeyB' }, shiftMap: { Digit2: 'Digit1' }, at: 5, shiftAt: 7, remapped: 1, skipped: ['KeyZ'] }), '包み KeyReader.calibration');
  check(JSON.stringify(kc.extraKeys()) === JSON.stringify({ Numpad1: 'Digit1', F14: 'Digit1+Shift' }), '包み KeyReader.extraKeys 2');
  kc.free();
  const ud = new UD(null);
  ud.setEntries([['東京', 'とうきょう']]);
  check(ud.entries().length === 1 && JSON.parse(ud.toStorage(5)).at === 5 && ud.apply('東京') === 'とうきょう' && ud.hasWordIn('東京へ'), '包み UserDictionary');
  const kuromojiLike = { tokenize: s => [...s].map(ch => ({ surface_form: ch, basic_form: ch, reading: ch === '日' ? 'ヒ' : '*', word_id: 1 })) };
  check(ud.tokenizeWith('東京の日', kuromojiLike).map(x => x.r).join('') === 'とうきょうのひ' && ud.segments('東京').length === 1, '包み UserDictionary.tokenizeWith');
  // 形態素解析がエラーを出しても、内蔵の辞書の結果を返し、辞書はそのあとも使える（JS の例外を Rust に通さない）
  const broken = { tokenize: () => { throw new Error('壊れた形態素解析'); } };
  let okBroken = false;
  try { okBroken = Array.isArray(ud.tokenizeWith('東京の日', broken)) && ud.segments('東京').length === 1 && ud.tokenizeWith('東京の日', kuromojiLike).length > 0; } catch { okBroken = false; }
  check(okBroken, '包み UserDictionary.tokenizeWith（形態素解析がエラーを出しても止まらない）');
  check(ud.parsePastedLine('文|ぶん', 'nihon').readingGiven && ud.parseMultiLine('a\nb', true, 'nihon').length === 2, '包み UserDictionary.parse');
  ud.free();
}

console.log((fail ? 'FAIL' : 'ok  ') + ' WASM の口：' + pass + ' 件合格' + (fail ? '・' + fail + ' 件失敗' : ''));
process.exit(fail ? 1 : 0);
