// 正解データを作る：旧版（old_versions/ の最新の v5：typing_practice_v5.Y.Z.html）をヘッドレスの Chromium で開き、
// 中の関数に決まった入力を渡して答えを集め、core/tests/golden/<まとまり>.json に書く。
// Rust のテスト（core/tests/golden_*.rs）がそれを読み、同じ入力で同じ答えになるかを比べる。
//     node golden/generate.mjs [まとまり…]     （ルートで。省くと全部）
// まとまり：data（Rust に組み込む練習文：core/data/）、score / shuttle / text / lz（段階 2a）、kana / dict（2b）、typing / keys（2c）、layout（2d）、records / shuttlerun（2e）
// ネットには出ない（CDN も止める）。Playwright はルートの node_modules のものを使う。
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OLD = resolve(ROOT, 'old_versions');
const OUT = resolve(ROOT, 'core/tests/golden');
const { chromium } = await import(resolve(ROOT, 'node_modules/playwright/index.mjs'));

function latestSource() {
  // 旧版（v5）の本体は old_versions/ にある。いちばん新しい v5 を使う
  const found = readdirSync(OLD)
    .map((name) => ({ name, v: (name.match(/^typing_practice_v(5)\.(\d+)\.(\d+)\.html$/) || []).slice(1).map(Number) }))
    .filter((f) => f.v.length === 3)
    .sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.v[2] - b.v[2]);
  return resolve(OLD, found.pop().name);
}

// 入力を作るための決まった乱数（毎回同じ入力になる）
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rint = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// ---------- 各まとまり：入力を作り、ページの中で旧版（v5）の関数に通す ----------
const GROUPS = {
  async score(page) {
    const rand = mulberry32(2026);
    const intervalSets = [[], [100], Array(9).fill(120), Array(10).fill(120)];
    for (let i = 0; i < 60; i++) {
      const n = rint(rand, 0, 50);
      const ints = rand() < 0.5;
      intervalSets.push(Array.from({ length: n }, () => ints ? rint(rand, 40, 900) : 40 + rand() * 860));
    }
    const composite = [];
    for (let i = 0; i < 200; i++) {
      composite.push({ refKpm: rand() < 0.2 ? rint(rand, 0, 900) : rand() * 900, accRatio: rand() < 0.2 ? 1 : 0.5 + rand() * 0.5, rhythm: rand() < 0.2 ? null : rint(rand, 0, intervalSets.length - 1) });
    }
    const scores = [-1, 0, 0.4, 0.5, 5000, 99999];
    for (const m of [3400, 2900, 2520, 2200, 1920, 1680, 1470, 1280, 1110, 960, 820, 700, 590, 490, 400, 320, 250]) scores.push(m - 1, m - 0.5, m, m + 0.5);
    for (let i = 0; i < 50; i++) scores.push(rand() * 4000);
    return page.evaluate(({ intervalSets, composite, scores }) => {
      const rhythms = intervalSets.map(iv => ({ intervals: iv, out: computeRhythm(iv) }));
      const rhythmNull = computeRhythm(null);
      return {
        rhythm: rhythms,
        rhythmNull,
        composite: composite.map(c => ({ ...c, out: computeCompositeScore(c.refKpm, c.accRatio, c.rhythm === null ? null : rhythms[c.rhythm].out) })),
        ranks: scores.map(s => ({ score: s, rank: getScoreRank(s).rank, next: (getNextRank(s) || { rank: null }).rank })),
        rankNull: { rank: getScoreRank(null).rank, next: getNextRank(null).rank },
        table: SCORE_RANKS.map(r => ({ rank: r.rank, min: r.min, tier: r.tier, label: r.label, color: r.color, bg: r.bg, comment: r.comment })),
      };
    }, { intervalSets, composite, scores });
  },

  async shuttle(page) {
    const rand = mulberry32(31);
    const freezeSets = [[]];
    for (let i = 0; i < 40; i++) {
      const n = rint(rand, 1, 4);
      const fs = [];
      for (let j = 0; j < n; j++) { const a = rint(rand, 0, 20000); fs.push([a, a + rint(rand, 0, 5000), ...(rand() < 0.5 ? ['inv'] : [])]); }
      freezeSets.push(fs);
    }
    const freezeQueries = [];
    for (let i = 0; i < 300; i++) {
      const set = rint(rand, 0, freezeSets.length - 1);
      const from = rint(rand, -1000, 25000);
      freezeQueries.push({ set, from, to: rand() < 0.3 ? null : from + rint(rand, 0, 10000), deadline: from + rint(rand, -2000, 20000) });
    }
    const runs = [[]];
    for (let i = 0; i < 60; i++) runs.push(Array.from({ length: rint(rand, 0, 30) }, () => ({ fail: rand() < 0.15, miss: rand() < 0.6 ? 0 : rint(rand, 1, 3) })));
    const extraSplits = [['あ、い、う', 'あ、い、う', 3], ['漢字、だけ', 'かんじだけ', 2], ['一つ', 'ひとつ', 2], ['', '', 2], ['a、b', 'a、b', 1], ['a、b', 'a、b', 5], ['、、', '、、', 2], ['長い長い文、短い、とても長い文章です', 'ながいながいぶん、みじかい、とてもながいぶんしょうです', 2]];
    return page.evaluate(({ freezeSets, freezeQueries, runs, extraSplits }) => {
      const levels = [];
      for (let lv = 0; lv <= 120; lv++) {
        const keys = shuttleTargetKeys(lv);
        levels.push({ level: lv, targetKeys: keys, readTime: shuttleReadTime(lv), kps: shuttleKps(lv), baseLimit: shuttleBaseLimit(lv, keys), baseLimit40: shuttleBaseLimit(lv, 40), stage: shuttleStageOf(lv), parts: shuttlePartsFor(lv) });
      }
      const splits = [];
      SHUTTLE_POOL.forEach(([kanji, kana]) => { for (const n of [2, 3]) splits.push({ kanji, kana, n, out: shuttleSplit(kanji, kana, n) }); });
      extraSplits.forEach(([kanji, kana, n]) => splits.push({ kanji, kana, n, out: shuttleSplit(kanji, kana, n) }));
      const freezes = freezeQueries.map(q => {
        const sh = { freezes: freezeSets[q.set], deadline: q.deadline };
        const to = q.to === null ? Infinity : q.to;
        const at = shuttleFreezeAt(sh, q.from);
        return { ...q, frozenMs: shuttleFrozenMs(sh, q.from, to), freezeAt: at ? sh.freezes.indexOf(at) : null, timeLeft: shuttleTimeLeft(sh, q.from) };
      });
      return { rules: SH_RULES, levels, splits, freezeSets, freezes, perfect: runs.map(levels => ({ levels, out: shuttlePerfectRun(levels) })) };
    }, { freezeSets, freezeQueries, runs, extraSplits });
  },

  async text(page) {
    const crafted = ['', '   ', 'abc', 'これは テスト です。とても 長い 文章を 区切ります。', 'Ｈｅｌｌｏ　Ｗｏｒｌｄ、カタカナとひらがな。', '「かぎかっこ」の中（括弧）も、句読点。そして！最後？',
      'タブ\tを\t含む\t行です、それでも区切れるかな', '絵文字😀を含む😀行😀です。🎉🎉🎉', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'ーーーーっっっっゃゃゃゃ、、、、。。。。', '  前後に空白  がある　行　', 'Rustでプログラミングを学ぶのは楽しいけれど難しい'];
    const specLines = ['テスト（てすと）', 'テスト(てすと)  ', '漢字|かんじ', 'a\tb', '（）', 'テスト（てすと）x', 'テスト（テスト ）', 'テスト（漢字）', '（ ）', 'x（あ）　', 'x（あ） ', 'x（あ）\u0085', 'x（あ）﻿', 'x（ゔー）', '（あ）（い）', 'ただの文', '(ひらがな）', '（ア　イ）'];
    return page.evaluate(({ crafted, specLines }) => {
      const lines = crafted.concat(SHUTTLE_POOL.map(p => p[0]));
      DEFAULT_WORD_PRESETS.forEach(p => (p.words || []).forEach(w => lines.push(w.kanji)));
      const breaks = [];
      lines.forEach(line => { for (const size of [3, 4, 6, 12, 18]) breaks.push({ line, size, out: autoBreakLine(line, size) }); });
      return {
        breaks,
        counted: lines.map(s => ({ s, n: countedLength(s) })),
        spec: specLines.concat(lines.slice(0, 40)).map(line => ({ line, out: isReadingSpecLine(line) })),
      };
    }, { crafted, specLines });
  },

  async lz(page) {
    const rand = mulberry32(16);
    const inputs = await page.evaluate(() => [
      '', 'a', 'aa', 'ab', 'abababababababab', 'あ', 'あいうえお'.repeat(30), '😀🎉😀🎉', '\u0000\u0001ÿĀ￿',
      JSON.stringify(SH_RULES), JSON.stringify(DEFAULT_WORD_PRESETS), SHUTTLE_POOL.slice(0, 200).map(p => p.join('|')).join('\n'),
    ]);
    for (let i = 0; i < 20; i++) inputs.push(Array.from({ length: rint(rand, 1, 300) }, () => String.fromCodePoint(rand() < 0.7 ? rint(rand, 0x3041, 0x3096) : rint(rand, 0x20, 0x7e))).join(''));
    const corrupt = [];
    for (let i = 0; i < 40; i++) corrupt.push({ from: rint(rand, 0, inputs.length - 1), kind: ['cut', 'change', 'random'][i % 3], at: rand(), unit: rint(rand, 32, 32799) });
    return page.evaluate(({ inputs, corrupt }) => {
      const compressed = inputs.map(s => ({ s, c: lzCompress16(s) }));
      const bad = corrupt.map(k => {
        const c = compressed[k.from].c;
        let x;
        if (k.kind === 'cut') x = c.slice(0, Math.floor(c.length * k.at));
        else if (k.kind === 'change') { const i = Math.floor(c.length * k.at); x = c.slice(0, i) + String.fromCharCode(k.unit) + c.slice(i + 1); }
        else x = Array.from({ length: 1 + Math.floor(k.at * 40) }, (_, i) => String.fromCharCode(32 + ((k.unit * (i + 7)) % 32700))).join('');
        const out = lzDecompress16(x);
        // 壊れたデータから、対になっていないサロゲートを含む文字列が出ることがある（Rust の String にできない）
        const lone = typeof out === 'string' && /[\ud800-\udbff](?![\udc00-\udfff])|(?:[^\ud800-\udbff]|^)[\udc00-\udfff]/.test(out);
        return { input: x, out: lone ? { lone: true } : out };
      });
      const M = LZ_MARK;
      const longText = inputs[10];
      const stored = [longText, 'plain', M + lzCompress16('hello'), M + lzCompress16(M + lzCompress16('twice')), M + lzCompress16(M + lzCompress16(M + lzCompress16(M + lzCompress16(M + lzCompress16('five'))))), M + 'garbage!!', M, M + lzCompress16('')];
      const enc = [];
      for (const on of [false, true]) {
        localStorage.setItem('custom_typing_compress_v1', on ? '1' : '0');
        for (const key of ['custom_typing_word_presets_v2', 'custom_typing_score_history_v1', 'custom_typing_settings_v1']) {
          for (const value of [longText, 'short', M + lzCompress16(longText), 'x'.repeat(3000), Array.from({ length: 2100 }, (_, i) => String.fromCharCode(0x4e00 + (i * 7919) % 20000)).join('')]) {
            enc.push({ on, key, value, out: encodeForStorage(key, value) });
          }
        }
      }
      localStorage.removeItem('custom_typing_compress_v1');
      return { mark: M, compressed, bad, stored: stored.map(raw => ({ raw, out: decodeStored(raw) })), encode: enc };
    }, { inputs, corrupt });
  },

  // ---------- 段階 2b：かな → ローマ字 ----------
  async kana(page) {
    const rand = mulberry32(2525);
    // 端の場合（絵文字など BMP の外の文字は、旧版（v5）がサロゲートを 1 つずつに分けるので入れない：kana.rs の冒頭）
    const edge = ['', ' ', 'きゃっと', 'かんい', 'かんや', 'かんな', 'かんの', 'ほんを', 'ほん', 'さんぽ', 'しんぶん', 'さんま', 'てんき', 'ん', 'んん', 'っ', 'っっ', 'っか',
      'ちょっと', 'まっちゃ', 'いっぱい', 'はっぴょう', 'かっぁ', 'ゔぁいおりん', 'ヴァイオリン', 'ティーカップ', 'でぃすく', 'ふぁいる', 'うぃんどう', 'くぁ',
      'じゃんけん', 'ぢゃ', 'づつ', 'を', 'しちつふじぢづ', 'しぇちぇじぇ', 'ー−‐、。・「」『』', 'ＡＢＣａｂｃ１２３', 'ABCabc123', '！？＃＄％＆',
      '“ことば”‘い’″′', '〜', 'ß', 'ゕゖゎゐゑ', '　かな　かな　', 'カタカナとひらがな', 'ヵヶ', 'えーと、あの。', 'だっ!', 'っ1', 'ん1', 'ん、', 'ん!', 'き゚', 'あいう\tえお'];
    const readings = edge.concat(SHUTTLE_POOL_KANA, PRESET_KANA);
    const symbolTokens = ['あ', 'し', 'しゃ', 'を', 'ん', 'っ', 'ー', '!', '！', 'a', 'Ａ', '〜', '“', '’', 'ß', '漢', '😀', ' ', '゛', '.', 'x'];
    // 自分で決めたローマ字：ヘボン式の標準、少し変えたもの（割り当てに失敗してローマ字だけで単位を作る道に入る）、でたらめ
    const customWords = [];
    const pool = SHUTTLE_POOL_KANA.slice(0, 160).concat(edge.slice(2, 40));
    pool.forEach((kana, i) => customWords.push({ kana, romaji: '@hepburn', mutate: i % 3 }));
    for (let i = 0; i < 40; i++) customWords.push({ kana: pool[rint(rand, 0, pool.length - 1)], romaji: Array.from({ length: rint(rand, 1, 30) }, () => 'AKSTNHMYRWGZDBPIUEOJCFLXQV-,.!123ａ'[rint(rand, 0, 34)]).join(''), mutate: -1 });
    customWords.push({ kana: '', romaji: 'KANA', mutate: -1 }, { kana: 'かな', romaji: '', mutate: -1 }, { kana: 'かな', romaji: 'ｋａｎａ', mutate: -1 }, { kana: 'かな', romaji: '漢字', mutate: -1 });
    const typeableSets = [null, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ-,.', 'AIUEOKSTN'];
    const english = ['Hello, world!', '  Ｆｕｌｌｗｉｄｔｈ　ｔｅｘｔ  ', 'It’s “quoted” — dash… done', 'tab\tand\nnewline', 'ß and ﬁ', '', 'C3-PO & R2-D2: 100%', 'naïve café'];
    return page.evaluate(({ readings, symbolTokens, customWords, typeableSets, english }) => {
      const styles = ['nihon', 'hepburn'];
      const chunkOut = cs => cs.map(c => [c.kana, c.options]);
      const out = { chunks: [], baseOptions: [], equivalents: [], normalize: [], words: [], english: [], drop: [] };
      readings.forEach(r => styles.forEach(style => out.chunks.push({ r, style, out: chunkOut(buildKanaChunks(r, style)), primary: getPrimaryRomajiPreview(r, style) })));
      const tokens = Object.keys(KANA_ROMAJI_MAP).concat(symbolTokens);
      tokens.forEach(t => styles.forEach(style => out.baseOptions.push({ t, style, out: getBaseOptionsForToken(t, style) })));
      const roms = new Set(['n', 'nn', 'Shi', 'xtsu', 'o', 'zzz', '']);
      Object.values(KANA_ROMAJI_MAP).forEach(a => a.forEach(x => roms.add(x)));
      ROMAJI_EQUIVALENT_GROUPS.forEach(g => g.forEach(x => roms.add(x)));
      roms.forEach(r => out.equivalents.push({ r, out: getRomajiEquivalents(r) }));
      readings.slice(0, 80).concat(['ＡＢＣ　ｘｙｚ', ' カタカナ ', 'ｈｅｌｌｏ!?', 'abc def', 'ß', '漢字かな々', '㐀', 'ヷヸヹヺ']).forEach(s => out.normalize.push({
        s, reading: normalizeReadingString(s), kanaOfText: kanaOfText(s), romajiInput: normalizeRomajiInputString(s), hasKanji: hasUnconvertedKanji(s),
      }));
      const saved = state.romajiStyle;
      customWords.forEach(w => styles.forEach(style => {
        let romaji = w.romaji;
        if (romaji === '@hepburn') {
          romaji = getPrimaryRomajiPreview(w.kana, 'hepburn');
          if (w.mutate === 1) romaji = romaji.replace(/A/, 'AA');          // 割り当てに失敗する
          if (w.mutate === 2) romaji = romaji.toLowerCase();                // 小文字でもよい
        }
        const word = { kanji: '', kana: w.kana, romaji, isCustomRomaji: true };
        state.romajiStyle = style;
        const custom = buildWordChunksForPractice(word);
        const plain = buildWordChunksForPractice({ ...word, isCustomRomaji: false });
        out.words.push({ kana: w.kana, romaji, style, custom: chunkOut(custom), plain: chunkOut(plain), effective: getEffectiveWordRomaji(word, style), effectivePlain: getEffectiveWordRomaji({ ...word, isCustomRomaji: false }, style) });
      }));
      // 打てる文字：今の配列（null）と、決まった集合
      const savedLayout = state.currentLayout;
      typeableSets.forEach(set => {
        if (set !== null) state.currentLayout = { name: 't', keys: Object.fromEntries([...set].map((c, i) => ['K' + i, { char: c, finger: 0, row: 1 }])) };
        const chars = [...typeableCharSet()].sort();
        english.forEach(t => out.english.push({ t, chars, normalized: normalizeEnglishText(t), out: chunkOut(buildEnglishChunks(t)) }));
        readings.slice(0, 120).forEach(r => {
          const cs = buildKanaChunks(r, 'nihon');
          out.drop.push({ r, chars, out: chunkOut(dropUntypeableOptions(cs)) });
        });
        state.currentLayout = savedLayout;
      });
      state.romajiStyle = saved;
      return out;
    }, { readings, symbolTokens, customWords, typeableSets, english });
  },

  async dict(page) {
    // kuromoji の代わり：決まった語の表で最長一致、それ以外は 1 文字ずつ（ひらがなはそのよみ、漢字はよみなし '*'）
    const FAKE = {
      '憚ら': { basic: '憚る', reading: '*' }, '憚っ': { basic: '憚る', reading: '*' }, '憚る': { basic: '憚る', reading: '*' },
      '今日': { basic: '今日', reading: 'キョウ' }, '行か': { basic: '行く', reading: 'イカ' }, '走っ': { basic: '走る', reading: 'ハシッ' },
      '走る': { basic: '走る', reading: 'ハシル' }, '書い': { basic: '書く', reading: 'カイ' }, '読ま': { basic: '読む', reading: '' },
      '雨': { basic: '雨', reading: 'アメ' }, '晴れ': { basic: '晴れる', reading: 'ハレ' }, '東京': { basic: '東京', reading: 'トウキョウ' },
    };
    const userEntries = [['憚る', 'はばかる'], ['行く', 'いく'], ['書く', 'かく'], ['東京タワー', 'とうきょうたわー'], ['今日', 'こんにち'], ['読む', 'よむ'], ['雨', 'あめ'], ['々', 'のま'], ['走', 'はし']];
    const sentences = ['今日は雨です', '憚らずに言う', '憚った', '東京タワーへ行かない', '走って書いた', '読まない', '晴れの日', '今日のお天気', 'よろしくお願いします', '漢字の練習を毎日', '人々', '知らない漢字', '', 'ひらがなだけ', 'カタカナ', '大西配列で打鍵の練習'];
    const pasteLines = ['今日は雨です', '  漢字|かんじ  ', '漢字|カンジ|kanji', '漢字\tかんじ', '問題文|', '|よみだけ', 'a|b|c|d', '文（ぶん）', '文(ぶん)', '（あ）（い）', '文（漢字）', '()', '（）', '文（）', '   ', '', '毎日の積み重ね', 'お疲れ様です。明日もよろしく', '練習(れんしゅう) ', '東京タワー', 'x|ｙｏｍｉ|ｒｏｍａ'];
    const rawDicts = [null, 'not json', 'null', '{}', '{"entries":[["憚る","はばかる"]]}', '{"entries":[],"defaults":["憚る"]}', '{"entries":[["a","あ"],["a","い"],[" b ","ﾍﾞ"],["漢字","かんじ"],["x","漢"],[1,2],[true,"です"],["longlonglonglonglonglonglonglonglonglong","あ"],["ok","あああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ"],["tab\\tx","あ"],["り","り"],[null,"あ"],["ん","ゐ"],["😀","えもじ"]],"defaults":["憚る","other",3]}',
      JSON.stringify({ entries: Array.from({ length: 2100 }, (_, i) => ['語' + i, 'ご']) }), '{"entries":[[1e21,"いち"],[0.5,"れい"],[[1,null,"x"],"はい"],[{},"もの"]]}'];
    const wordTests = ['', '   ', ' ok ', 'a|b', 'tab\t', 'x'.repeat(32), 'x'.repeat(33), '😀'.repeat(16), '😀'.repeat(17)];
    const readingTests = ['', 'かな', ' か な ', 'カタカナ', '漢字', 'あ'.repeat(64), 'あ'.repeat(65), 'abc', '😀', 'ん', 'ー', 'ｶﾅ', '　'];
    return page.evaluate(({ FAKE, userEntries, sentences, pasteLines, rawDicts, wordTests, readingTests }) => {
      const calls = {};
      const fakeTokenizer = {
        tokenize(s) {
          const tokens = [];
          let i = 0;
          while (i < s.length) {
            const hit = Object.keys(FAKE).sort((a, b) => b.length - a.length).find(k => s.startsWith(k, i));
            if (hit) { tokens.push({ surface_form: hit, basic_form: FAKE[hit].basic, reading: FAKE[hit].reading }); i += hit.length; continue; }
            const c = s[i];
            const kanaRead = /[ぁ-ゖ]/.test(c) ? String.fromCharCode(c.charCodeAt(0) + 0x60) : /[ァ-ヶー]/.test(c) ? c : '*';
            tokens.push({ surface_form: c, basic_form: c, reading: kanaRead });
            i++;
          }
          calls[s] = tokens;
          return tokens;
        }
      };
      const segOut = segs => segs.map(x => [x.s, x.r, Boolean(x.user), x.b || null]);
      const run = (entries) => {
        setUserDictEntries(entries);
        return {
          entries,
          segments: sentences.map(s => ({ s, out: segOut(dictSegments(s)), reading: applyBuiltinKanjiDict(s), hasUser: hasUserDictWord(s) })),
          tokenized: sentences.map(s => ({ s, out: segOut(tokenizeWithUserDict(fakeTokenizer, s)) })),
          pasted: pasteLines.flatMap(l => ['nihon', 'hepburn'].map(style => {
            state.romajiStyle = style;
            const item = parsePastedLine(l);
            if (!item) return { l, style, out: null };
            const auto = autoReadings.get(item);
            return { l, style, out: { kanji: item.kanji, kana: item.kana, romaji: item.romaji, isCustomRomaji: item.isCustomRomaji, given: readingGivenItems.has(item), auto: auto ? segOut(auto.segs) : null } };
          })),
        };
      };
      const savedStyle = state.romajiStyle, savedEntries = userDictEntries, savedOffered = userDictDefaultsOffered;
      const withUser = run(userEntries);
      const withoutUser = run([]);
      const conj = ['憚ら', '憚っ', '行か', '書い', '読ま', '走っ', '雨'].map(s => {
        setUserDictEntries(userEntries);
        const t = fakeTokenizer.tokenize(s)[0];
        return { token: t, out: conjugatedUserReading(t) };
      });
      const tails = [['憚る', '憚ら'], ['行く', '行か'], ['今日', '今日'], ['abc', 'abd'], ['書く', '描く'], ['走る', '走'], ['見る', '見せる漢'], ['', '']].map(([b, s]) => ({ b, s, out: okuriganaTails(b, s) }));
      const loads = rawDicts.map(raw => {
        if (raw === null) localStorage.removeItem('custom_typing_user_dict_v1'); else localStorage.setItem('custom_typing_user_dict_v1', raw);
        loadUserDict();
        return { raw, entries: userDictEntries.slice(), offered: userDictDefaultsOffered.slice() };
      });
      localStorage.removeItem('custom_typing_user_dict_v1');
      const words = wordTests.map(s => ({ s, out: cleanUserDictWord(s) }));
      const reads = readingTests.map(s => ({ s, out: cleanUserDictReading(s) }));
      setUserDictEntries(savedEntries); userDictDefaultsOffered = savedOffered; state.romajiStyle = savedStyle;
      return { withUser, withoutUser, calls, conj, tails, loads, words, reads };
    }, { FAKE, userEntries, sentences, pasteLines, rawDicts, wordTests, readingTests });
  },

  // ---------- 段階 2c：打鍵の判定 ----------
  async typing(page) {
    const rand = mulberry32(777);
    const pool = SHUTTLE_POOL_KANA.slice(0, 120);
    const edge = ['かんい', 'ほん', 'ほんを', 'てんき', 'さんぽ', 'きっぷ', 'ちょっと', 'まっちゃ', 'しんにゅう', 'こんにちは', 'ん', 'っ', 'かっ', 'ーん', 'げんいん', 'ぜんぶ', 'あんない'];
    const sessions = [];
    const pick = () => (rand() < 0.3 ? edge : pool)[rint(rand, 0, (rand() < 0.3 ? edge : pool).length - 1)] || 'かな';
    for (let i = 0; i < 70; i++) {
      const n = rint(rand, 1, 3);
      const words = Array.from({ length: n }, () => { const kana = pick(); return { kanji: kana, kana, romaji: '', isCustomRomaji: false }; });
      if (i % 9 === 0) { words[0].isCustomRomaji = true; words[0].romaji = '@hepburn'; }
      sessions.push({ words, style: i % 2 ? 'hepburn' : 'nihon', layout: i % 5 === 4 ? 'oonishi' : 'qwerty', mode: i % 6, seed: i, lang: 'ja' });
    }
    // 文末の「ん」を NN と打つ：2 つ目の N が次の文の頭に来る
    sessions.push({ words: [{ kanji: 'ほん', kana: 'ほん', romaji: '', isCustomRomaji: false }, { kanji: 'あ', kana: 'あ', romaji: '', isCustomRomaji: false }], style: 'nihon', layout: 'qwerty', mode: 'script', script: 'HONNA', lang: 'ja' });
    sessions.push({ words: [{ kanji: 'ほん', kana: 'ほん', romaji: '', isCustomRomaji: false }, { kanji: 'な', kana: 'な', romaji: '', isCustomRomaji: false }], style: 'nihon', layout: 'qwerty', mode: 'script', script: 'HONNNA', lang: 'ja' });
    sessions.push({ words: [{ kanji: 'ほん', kana: 'ほん', romaji: '', isCustomRomaji: false }], style: 'nihon', layout: 'qwerty', mode: 'script', script: 'HONNX', lang: 'ja' });
    sessions.push({ words: [{ kanji: 'かんい', kana: 'かんい', romaji: '', isCustomRomaji: false }], style: 'nihon', layout: 'qwerty', mode: 'script', script: 'KANIKANNI', lang: 'ja' });
    // 英語
    ['Hello, World!', 'It’s a pen.', 'naïve café 100%'].forEach((t, i) => sessions.push({ words: [{ kanji: t, kana: '', romaji: '', isCustomRomaji: false }], style: 'nihon', layout: 'qwerty', mode: i, seed: 900 + i, lang: 'en' }));
    // 打てない文字だけの文は飛ばす
    sessions.push({ words: [{ kanji: '', kana: '漢字', romaji: '', isCustomRomaji: false }, { kanji: 'か', kana: 'か', romaji: '', isCustomRomaji: false }], style: 'nihon', layout: 'qwerty', mode: 0, seed: 5, lang: 'ja' });
    return page.evaluate(({ sessions }) => {
      let rs = 1;
      const rnd = () => { rs = (rs * 16807) % 2147483647; return rs / 2147483647; };
      const saved = { layout: state.currentLayout, style: state.romajiStyle, words: state.sessionWords, lang: state.sessionLang, screen: state.screenState, key: state.activeLayoutKey, finish: window.finishTypingSession };
      let finished = false;
      window.finishTypingSession = () => { finished = true; state.screenState = 'result'; };
      const snap = () => ({
        ci: state.currentChunkIndex, wi: state.currentWordIndex,
        chunks: state.currentChunks.map(c => [c.kana, c.options.slice(), c.typed, Boolean(c.skipped)]),
        correct: state.correctKeyCount, mistakes: state.mistakeKeyCount, combo: state.combo, maxCombo: state.maxCombo,
        kana: state.completedKanaCount, ref: state.completedRefKeys, curRef: state.currentWordRefKeys,
        allow: state.allowOptionalSecondN, trailing: Boolean(state.trailingSecondN), missed: Object.entries(state.missedCharsMap), finished,
        next: state.screenState === 'typing' ? getTargetNextChar() : null,
        would: state.screenState === 'typing' ? ['N', 'A', 'K', 'I'].map(c => inputWouldMatch(c)) : null,
        live: (({ totalHits, rowHits, leftHandHits, rightHandHits, pairs, alternationCount, sameFingerCount, sameKeyCount }) => [totalHits, rowHits.slice(), leftHandHits, rightHandHits, pairs, alternationCount, sameFingerCount, sameKeyCount])(state.liveTelemetryByLayout.__golden),
      });
      const out = sessions.map(sess => {
        rs = (sess.seed || 1) + 1;
        const words = sess.words.map(w => ({ ...w, romaji: w.romaji === '@hepburn' ? getPrimaryRomajiPreview(w.kana, 'hepburn') : w.romaji }));
        const layout = JSON.parse(JSON.stringify(PRESET_LAYOUTS[sess.layout]));
        state.currentLayout = layout; state.romajiStyle = sess.style; state.sessionWords = words.map(w => ({ ...w })); state.sessionLang = sess.lang;
        state.shuttle = null; state.screenState = 'typing'; resetSessionCounters();
        state.activeLayoutKey = '__golden'; state.liveTelemetryByLayout.__golden = createTelemetry();
        state.trailingSecondN = false; state.allowOptionalSecondN = false; finished = false;
        loadCurrentWord();
        // 打つ文字の並び
        let keys;
        const full = (style) => words.map(w => sess.lang === 'en' ? normalizeEnglishText(w.kanji).toUpperCase() : getEffectiveWordRomaji(w, style)).join('');
        if (sess.mode === 'script') keys = sess.script;
        else if (sess.mode === 0) keys = full(sess.style);
        else if (sess.mode === 1) keys = full(sess.style === 'nihon' ? 'hepburn' : 'nihon');
        else if (sess.mode === 2) keys = [...full(sess.style)].map(c => (rnd() < 0.15 ? 'QXZ'[Math.floor(rnd() * 3)] : '') + c).join('');
        else if (sess.mode === 3) keys = full(sess.style).replace(/NN/g, () => (rnd() < 0.5 ? 'N' : 'NN')).replace(/N(?!N)/g, () => (rnd() < 0.3 ? 'NN' : 'N'));
        else if (sess.mode === 4) keys = Array.from({ length: 40 }, () => 'AIUEOKSTNHMYRWGZDBPJ'[Math.floor(rnd() * 20)]).join('');
        else keys = words.map(w => buildWordChunksForPractice(w).map(c => c.options.length ? c.options[Math.floor(rnd() * c.options.length)] : '').join('')).join('');
        // 実際に押したキー（配列でその文字を打つキー）。ないときは null
        const reach = buildCharReach(layout);
        const steps = [];
        for (const ch of keys) {
          if (finished) break;
          const path = findCharPath(ch, reach);
          const code = ch === ' ' ? 'Space' : path ? path.code : null;
          processCharacterInput(ch, code);
          steps.push({ ch, code, s: snap() });
        }
        return { ...sess, words, start: null, keys, steps };
      });
      // 始めの状態だけ別に（loadCurrentWord の直後）
      Object.assign(window, { finishTypingSession: saved.finish });
      state.currentLayout = saved.layout; state.romajiStyle = saved.style; state.sessionWords = saved.words; state.sessionLang = saved.lang; state.screenState = saved.screen; state.activeLayoutKey = saved.key;
      return { sessions: out };
    }, { sessions });
  },

  async keys(page) {
    const layoutsRaw = { qwerty: null, custom: { name: 'c', keys: { KeyA: { char: 'E', shiftChar: '!' }, KeyS: { char: 'I' }, Digit1: { char: '1', shiftChar: '?' }, Semicolon: { char: 'H' } } } };
    const calibs = [null, 'not json', '{"map":{}}', '{"map":{"KeyA":"KeyS","KeyS":"KeyA","Escape":"KeyQ","key:1":"Digit2","Foo":"Space","Bar":5,"__proto__":"KeyZ"},"at":"123","skipped":["KeyZ","Nope",3,"ShiftLeft"]}',
      '{"map":{},"shiftMap":{"Digit1+Shift":"Digit3","KeyQ":"KeyW","Bad":"Space"},"shiftAt":true}', '{"map":[ "KeyA", "KeyB" ]}', '{"map":{"Escape+Shift":"KeyA"}}', '{"map":{"key:escape":"ShiftLeft"}}'];
    const extras = [null, '{"map":{"Numpad1":"Digit1","F13":"@shift","KeyQ+Shift":"Digit1+Shift","Bad":"Space","Bad2":"Nope","Num":5,"key:a":"KeyB"}}', '{"map":[1,2]}', 'bad'];
    const events = [];
    ['KeyA', 'KeyS', 'KeyQ', 'Digit1', 'Digit2', 'Escape', 'Numpad1', 'F13', 'Space', 'ShiftLeft', 'ShiftRight', '', 'Unidentified', 'IntlYen', 'Backquote', 'Semicolon', 'Backslash'].forEach(code => {
      [false, true].forEach(shiftKey => events.push({ code, key: code === '' || code === 'Unidentified' ? (shiftKey ? 'A' : 'a') : code === 'ShiftLeft' || code === 'ShiftRight' ? 'Shift' : code === 'Escape' ? 'Escape' : 'x', shiftKey }));
    });
    events.push({ code: '', key: '1', shiftKey: false }, { code: 'Foo', key: 'Shift', shiftKey: true });
    return page.evaluate(({ layoutsRaw, calibs, extras, events }) => {
      const saved = { type: activeKeyboardType, layout: state.currentLayout, cal: state.calibration, extra: state.extraKeys, vs: state.virtualShift };
      const out = [];
      for (const type of ['jis', 'us']) {
        applyKeyboardType(type);
        for (const [lname, raw] of Object.entries(layoutsRaw)) {
          const layout = raw ? ensureLayoutKeys(JSON.parse(JSON.stringify(raw))) : JSON.parse(JSON.stringify(PRESET_LAYOUTS.qwerty));
          state.currentLayout = layout;
          calibs.forEach((c, ci) => extras.forEach((x, xi) => [false, true].forEach(vs => {
            if (c === null) localStorage.removeItem('custom_typing_calibration_v1'); else localStorage.setItem('custom_typing_calibration_v1', c);
            if (x === null) localStorage.removeItem('custom_typing_extra_keys_v1'); else localStorage.setItem('custom_typing_extra_keys_v1', x);
            loadCalibration(); loadExtraKeys();
            state.virtualShift = vs ? { F13: true } : {};
            out.push({
              type, lname, ci, xi, vs, layout,
              calibration: state.calibration ? { map: Object.entries(state.calibration.map), shiftMap: Object.entries(state.calibration.shiftMap), at: state.calibration.at, shiftAt: state.calibration.shiftAt, remapped: state.calibration.remapped, skipped: state.calibration.skipped } : null,
              extra: Object.entries(state.extraKeys.map),
              escTyped: escapeIsTypedKey(),
              events: events.map(e => ({ e, sig1: keySignalOf(e, true), sig0: keySignalOf(e, false), reading: currentReadingOf(e), phys: resolvePhysicalCode(e), resolved: resolveKeyEvent(e), calibChar: isCalibratedCharKey(e) })),
            });
          })));
        }
      }
      localStorage.removeItem('custom_typing_calibration_v1'); localStorage.removeItem('custom_typing_extra_keys_v1');
      applyKeyboardType(saved.type);
      state.currentLayout = saved.layout; state.calibration = saved.cal; state.extraKeys = saved.extra; state.virtualShift = saved.vs;
      return { calibs, extras, cases: out };
    }, { layoutsRaw, calibs, extras, events });
  },

  // ---------- 段階 2e：記録・バックアップ ----------
  async records(page) {
    const rand = mulberry32(5150);
    const histRecords = [
      { v: 3, score: 1200, wpm: 60, kpm: 300, id: 'r_abc', timestamp: 1700000000000, layoutName: '大西配列', courseKey: 'p:1' },
      { score: '1500', wpm: 250, id: 'bad.id.x', timestamp: '1700000000001', layoutName: 7, presetName: 'プリセット' },
      { v: 0, wpm: null, id: 'r_ok', timestamp: -5, cpm: 3 },
      { v: 2, score: true, accuracy: [97.5], rhythm: {}, layoutName: { a: 1 }, courseName: 'x'.repeat(100), id: '', timestamp: 'abc' },
      { v: 3, score: 'Infinity', kpm: '12px', id: 'id-with-ok_chars', timestamp: 1.5e12, lang: 'en', groupName: null },
      null, 5, 'str', [1, 2], {}, { id: 'a'.repeat(65), v: 1 }, { wpm: '400', v: '' },
    ];
    const finishCases = [];
    for (let i = 0; i < 40; i++) {
      const n = rint(rand, 0, 60);
      finishCases.push({
        correct: rint(rand, 0, 900), mistakes: rint(rand, 0, 60), kana: rint(rand, 0, 500), ref: rint(rand, 0, 900), maxCombo: rint(rand, 0, 300),
        intervals: Array.from({ length: n }, () => 40 + rand() * 600), elapsedMs: rand() < 0.1 ? rint(rand, 0, 200) : rint(rand, 1000, 600000),
        sentences: rint(rand, 1, 30), lang: rand() < 0.2 ? 'en' : 'ja', style: rand() < 0.5 ? 'hepburn' : 'nihon',
      });
    }
    finishCases.push({ correct: 0, mistakes: 0, kana: 0, ref: 0, maxCombo: 0, intervals: [], elapsedMs: 5000, sentences: 1, lang: 'ja', style: 'nihon' });
    finishCases.push({ correct: 0, mistakes: 5, kana: 0, ref: 0, maxCombo: 0, intervals: [], elapsedMs: 5000, sentences: 1, lang: 'ja', style: 'nihon' });
    const shRec = (o) => Object.assign({ id: 's_x', timestamp: 1700000000000, level: 5, cleared: 4, keys: 300, misses: 3, accuracy: 99, maxCombo: 60, kpm: 200, durationSec: 120, layoutName: 'QWERTY', romajiStyle: 'nihon', shields: 1, saves: 0, levels: [] }, o);
    const perfectLv = (n, miss = 0) => Array.from({ length: n }, (_, i) => ({ lv: i + 1, limit: 5, used: 3, miss: i === n - 1 ? miss : 0, fail: false }));
    const shuttleHistories = [null, '', 'not json', '{}', JSON.stringify([shRec({}), shRec({ id: 5, timestamp: 1700000001000, level: '12.6', cleared: 11, accuracy: 120, layoutName: 'a\nb'.repeat(40), romajiStyle: 'hepburn', levels: [{ lv: '3', limit: '4.5', miss: 2.4, fail: 1 }, null, 'x', [1]] }), { cleared: '3', timestamp: 1 }, null, [1], shRec({ cleared: Infinity })]),
      JSON.stringify(Array.from({ length: 105 }, (_, i) => shRec({ id: 's_' + i, timestamp: 1700000000000 + i * 1000, level: 2 + (i % 40), cleared: 1 + (i % 40), maxCombo: i * 2, saves: i % 4, durationSec: 60, levels: perfectLv(i % 25, i % 3 === 0 ? 1 : 0) })))];
    const trophyRaws = [null, 'bad', '[]', '{}', '{"got":{"lv5":1700000000000,"lv10":"5","bogus":1,"lv18":-1,"save1":"x"},"runs":"12.4","playSec":"100"}', '{"got":[1,2],"runs":-3}'];
    const updateRecs = [shRec({ timestamp: 1700000099000, level: 26, accuracy: 98.5, maxCombo: 160, saves: 3, shields: 2, levels: perfectLv(22) }), shRec({ timestamp: 1700000098000, level: 3, maxCombo: 10, shields: 0 })];
    const backupTexts = [
      'not json', '[]', '{"app":"other","data":{}}', '{"app":"custom-typing-practice"}', '{"app":"custom-typing-practice","data":"x"}', '{"app":"custom-typing-practice","data":[1,2]}',
      '{"app":"custom-typing-practice","data":{"other_key":"x","custom_typing_n":5}}',
      JSON.stringify({ app: 'custom-typing-practice', version: 1, exportedAt: '2026-11-10T05:00:00.000Z', data: { custom_typing_score_history_v1: JSON.stringify([{}, {}, {}]), custom_typing_shuttle_history_v1: '[1,2]', typecraft_qwerty_base_custom1: '{"name":"x"}', '10': 'x', custom_typing_x: 'y' } }),
      JSON.stringify({ app: 'custom-typing-practice', exportedAt: 'yesterday', data: { custom_typing_score_history_v1: '{"a":1}', custom_typing_y: 'z' } }),
      JSON.stringify({ app: 'custom-typing-practice', exportedAt: '2026-11-10', data: { custom_typing_y: 'z' } }),
    ];
    const toFixedValues = [0.25, 1.005, 99.95, 12, -0.04, 0, 0.05, 0.15, 2.675, 1.45, 97.25, 66.66666666666667, 100, 1e-7, 123456.789];
    for (let i = 0; i < 60; i++) toFixedValues.push(rand() * 100, rint(rand, 0, 1000) / 8);
    const reminderCases = [];
    for (let i = 0; i < 30; i++) {
      reminderCases.push({
        last: rand() < 0.3 ? null : String(1700000000000 + rint(rand, 0, 10) * 86400000), changed: rand() < 0.5 ? null : String(1700000000000 + rint(rand, 0, 20) * 86400000),
        off: rand() < 0.1, snooze: rand() < 0.3 ? JSON.stringify({ until: 1700000000000 + rint(rand, 0, 30) * 86400000, count: rint(rand, 0, 30) }) : null,
        scores: Array.from({ length: rint(rand, 0, 30) }, () => 1700000000000 + rint(rand, 0, 25) * 86400000), shuttles: Array.from({ length: rint(rand, 0, 5) }, () => 1700000000000 + rint(rand, 0, 25) * 86400000),
        now: 1700000000000 + rint(rand, 0, 40) * 86400000,
      });
    }
    return page.evaluate(async ({ histRecords, finishCases, shuttleHistories, trophyRaws, updateRecs, backupTexts, toFixedValues, reminderCases }) => {
      const out = {};
      out.normalize = histRecords.map(r => ({ raw: r, out: normalizeHistoryRecord(r && typeof r === 'object' ? JSON.parse(JSON.stringify(r)) : r) }));
      const loadCases = [null, '', 'bad', '{}', JSON.stringify(histRecords), JSON.stringify(Array.from({ length: 205 }, (_, i) => ({ v: 3, score: i, id: 'r_' + i, timestamp: i + 1 })))];
      out.loads = loadCases.map(raw => {
        if (raw === null) localStorage.removeItem('custom_typing_score_history_v1'); else localStorage.setItem('custom_typing_score_history_v1', raw);
        const ok = loadScoreHistoryFromStorage();
        return { raw, ok, out: state.scoreHistory };
      });
      localStorage.removeItem('custom_typing_score_history_v1');
      // 練習の終わり：時刻を止め、保存の代わりに記録を受け取る
      const realPerf = performance.now.bind(performance), realDateNow = Date.now, realRecord = window.recordCompletedScore, savedHist = state.scoreHistory;
      const savedWords = state.sessionWords, savedMeta = state.sessionMeta;
      const T = 5000000;
      performance.now = () => T;
      Date.now = () => 1700000000000;
      out.finish = finishCases.map(c => {
        let captured = null;
        window.recordCompletedScore = e => { captured = e; };
        state.scoreHistory = [];
        Object.assign(state, { correctKeyCount: c.correct, mistakeKeyCount: c.mistakes, completedKanaCount: c.kana, completedRefKeys: c.ref, keyIntervals: c.intervals.slice(), maxCombo: c.maxCombo, sessionStartTime: T - c.elapsedMs, romajiStyle: c.style });
        state.sessionWords = Array.from({ length: c.sentences }, () => ({ kanji: 'x', kana: 'x' }));
        state.sessionMeta = { lang: c.lang, layoutName: 'L', layoutKey: 'lk', groupName: null, course: { key: 'ck', name: 'cn' } };
        state.screenState = 'typing';
        finishTypingSession();
        return { ...c, record: captured, screen: state.screenState };
      });
      performance.now = realPerf; Date.now = realDateNow; window.recordCompletedScore = realRecord; state.scoreHistory = savedHist; state.sessionWords = savedWords; state.sessionMeta = savedMeta;
      out.shuttleHistory = shuttleHistories.map(raw => {
        if (raw === null) localStorage.removeItem('custom_typing_shuttle_history_v1'); else localStorage.setItem('custom_typing_shuttle_history_v1', raw);
        return { raw, out: loadShuttleHistory() };
      });
      const histForTrophies = shuttleHistories[5];
      localStorage.setItem('custom_typing_shuttle_history_v1', histForTrophies);
      out.trophyLoads = trophyRaws.map(raw => {
        if (raw === null) localStorage.removeItem('custom_typing_shuttle_trophies_v1'); else localStorage.setItem('custom_typing_shuttle_trophies_v1', raw);
        return { raw, out: loadShuttleTrophies() };
      });
      out.trophyUpdates = [];
      trophyRaws.forEach(raw => updateRecs.forEach(rec => {
        localStorage.setItem('custom_typing_shuttle_history_v1', histForTrophies);
        saveShuttleRecord(rec);
        if (raw === null) localStorage.removeItem('custom_typing_shuttle_trophies_v1'); else localStorage.setItem('custom_typing_shuttle_trophies_v1', raw);
        const fresh = updateShuttleTrophies(rec).map(t => t.id);
        out.trophyUpdates.push({ raw, rec, fresh, store: JSON.parse(localStorage.getItem('custom_typing_shuttle_trophies_v1')), history: localStorage.getItem('custom_typing_shuttle_history_v1') });
      }));
      localStorage.removeItem('custom_typing_shuttle_trophies_v1'); localStorage.removeItem('custom_typing_shuttle_history_v1');
      out.backup = [];
      for (const text of backupTexts) {
        const info = await readBackupFileInfo({ getFile: async () => ({ size: text.length, name: 'b.json', text: async () => text }) });
        let keys = null;
        try { const p = JSON.parse(text); if (p && p.data && typeof p.data === 'object') keys = Object.keys(p.data).filter(k => STORAGE_PREFIXES.some(pref => k.startsWith(pref)) && typeof p.data[k] === 'string'); } catch (e) {}
        out.backup.push({ text, info, keys });
      }
      out.toFixed = toFixedValues.map(x => [x, x.toFixed(1), x.toFixed(2), x.toFixed(0)]);
      out.reminder = reminderCases.map(c => {
        const set = (k, v) => (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v));
        set(BACKUP_META_KEY, c.last); set(DATA_CHANGED_KEY, c.changed); set(BACKUP_SNOOZE_KEY, c.snooze); set(BACKUP_REMINDER_OFF_KEY, c.off ? '1' : null);
        localStorage.setItem('custom_typing_shuttle_history_v1', JSON.stringify(c.shuttles.map((t, i) => ({ id: 's' + i, timestamp: t, cleared: 1 }))));
        const savedH = state.scoreHistory;
        state.scoreHistory = c.scores.map(t => ({ timestamp: t }));
        Date.now = () => c.now;
        const info = backupReminderInfo(), due = backupReminderDue();
        Date.now = realDateNow; state.scoreHistory = savedH;
        [BACKUP_META_KEY, DATA_CHANGED_KEY, BACKUP_SNOOZE_KEY, BACKUP_REMINDER_OFF_KEY, 'custom_typing_shuttle_history_v1'].forEach(k => localStorage.removeItem(k));
        return { ...c, info, due };
      });
      // バックアップに入れるデータ
      localStorage.clear();
      [['custom_typing_a', '1'], ['typecraft_b', '2'], ['other', '3'], [BACKUP_META_KEY, '4'], [BACKUP_SNOOZE_KEY, '5'], [DATA_CHANGED_KEY, '6'], [COMPRESS_FLAG_KEY, '0'], ['custom_typing_c', '']].forEach(([k, v]) => localStorage.setItem(k, v));
      out.collect = { storage: Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]), out: collectAppStorage() };
      localStorage.clear();
      out.keys = { BACKUP_META_KEY, BACKUP_SNOOZE_KEY, BACKUP_REMINDER_OFF_KEY, DATA_CHANGED_KEY, COMPRESS_FLAG_KEY, SHUTTLE_TROPHY_KEY, SHUTTLE_HISTORY_KEY, STORAGE_PREFIXES, SCORE_HISTORY_MAX, SHUTTLE_HISTORY_MAX };
      out.trophyTable = SHUTTLE_TROPHIES.map(t => [t.id, t.tier, t.name, t.desc]);
      out.tiers = Object.entries(TROPHY_TIERS).map(([k, v]) => [k, v.label, v.stops]);
      return out;
    }, { histRecords, finishCases, shuttleHistories, trophyRaws, updateRecs, backupTexts, toFixedValues, reminderCases });
  },

  async shuttlerun(page) {
    const plans = [];
    for (let i = 0; i < 14; i++) plans.push({ seed: 100 + i, accuracy: [0.99, 0.95, 0.85, 1.0][i % 4], speed: [140, 420, 650, 900, 300][i % 5], pauseEvery: i % 5 === 2 ? 37 : 0, layout: i % 7 === 6 ? 'oonishi' : 'qwerty', style: i % 2 ? 'hepburn' : 'nihon', maxSteps: 900 });
    return page.evaluate(({ plans }) => {
      const realPerf = performance.now.bind(performance), realRaf = window.requestAnimationFrame, realRandom = Math.random, realPick = window.shuttlePick, realDateNow = Date.now;
      const saved = { layout: state.currentLayout, style: state.romajiStyle, tab: state.mainTab, hist: localStorage.getItem('custom_typing_shuttle_history_v1') };
      const out = plans.map(plan => {
        let now = 1000000;
        performance.now = () => now;
        Date.now = () => 1700000000000 + now;
        // 次のフレームで動く処理をためておき、'tick' でまとめて動かす（キーを光らせる演出なども使う）
        let frame = [];
        window.requestAnimationFrame = (fn) => { frame.push(fn); return 1; };
        // 出題の乱数だけを記録する（ほかの演出も Math.random を使うので）
        let s = plan.seed, inPick = false;
        const picks = [];
        const prng = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
        Math.random = () => { const v = prng(); if (inPick) picks.push(v); return v; };
        window.shuttlePick = (level) => { inPick = true; try { return realPick(level); } finally { inPick = false; } };
        state.currentLayout = JSON.parse(JSON.stringify(PRESET_LAYOUTS[plan.layout])); state.romajiStyle = plan.style; state.mainTab = 'practice';
        localStorage.removeItem('custom_typing_shuttle_history_v1'); localStorage.removeItem('custom_typing_shuttle_trophies_v1');
        openShuttle();
        shuttleBegin();
        const sh = state.shuttle;
        const snap = () => ({
          phase: sh.phase, level: sh.level, shields: sh.shields, limit: sh.limit, deadline: sh.deadline, levelBase: sh.levelBase, carryIn: sh.carryIn,
          levelMisses: sh.levelMisses, records: sh.records.length, lastRecord: sh.records[sh.records.length - 1] || null, freezes: sh.freezes.map(f => f.slice()), levelStartAt: sh.levelStartAt, startedAt: sh.startedAt,
          wi: state.currentWordIndex, words: state.sessionWords.length, ci: state.currentChunkIndex, correct: state.correctKeyCount, mistakes: state.mistakeKeyCount, combo: state.combo,
        });
        const steps = [{ op: 'begin', now, s: snap() }];
        let r = plan.seed * 7 + 3;
        const rnd = () => { r = (r * 48271) % 2147483647; return r / 2147483647; };
        for (let k = 0; k < plan.maxSteps && sh.phase !== 'over' && sh.phase !== 'intro'; k++) {
          now += Math.floor(plan.speed * (0.5 + rnd()));
          if (plan.pauseEvery && k % plan.pauseEvery === plan.pauseEvery - 1 && sh.phase === 'run') {
            shuttlePause(); steps.push({ op: 'pause', now, s: snap() });
            now += 3000 + Math.floor(rnd() * 4000);
            shuttleResume(); steps.push({ op: 'resume', now, s: snap() });
            continue;
          }
          const fns = frame; frame = [];
          fns.forEach(f => f(now));
          steps.push({ op: 'tick', now, s: snap() });
          if (sh.phase !== 'run') break;
          const target = getTargetNextChar();
          const ch = target && rnd() < plan.accuracy ? target : 'QXZJ'[Math.floor(rnd() * 4)];
          const path = findCharPath(ch, buildCharReach(state.currentLayout));
          processCharacterInput(ch, path ? path.code : null);
          steps.push({ op: 'key', ch, code: path ? path.code : null, now, s: snap() });
        }
        const recs = JSON.parse(localStorage.getItem('custom_typing_shuttle_history_v1') || '[]');
        const result = { ...plan, picks, steps, record: recs[recs.length - 1] || null, endNow: now };
        closeShuttle();
        return result;
      });
      performance.now = realPerf; window.requestAnimationFrame = realRaf; Math.random = realRandom; window.shuttlePick = realPick; Date.now = realDateNow;
      state.currentLayout = saved.layout; state.romajiStyle = saved.style; state.mainTab = saved.tab;
      if (saved.hist === null) localStorage.removeItem('custom_typing_shuttle_history_v1'); else localStorage.setItem('custom_typing_shuttle_history_v1', saved.hist);
      return { runs: out };
    }, { plans });
  },

  // ---------- 段階 2d：配列 ----------
  async layout(page) {
    const rand = mulberry32(4242);
    const pool = ['A', 'b', 'Z', '-', ',', '.', '/', ';', ':', '@', '[', ']', '1', '0', 'ß', 'é', '😀x', '', '  q ', 'ab', 7, 3.5, null, true, '\n', '¥', '\\', '`', '"', "'", 'ı'];
    const randomLayouts = [];
    for (let i = 0; i < 30; i++) {
      const keys = {};
      ['Backquote', 'Digit1', 'Digit2', 'Minus', 'Equal', 'IntlYen', 'KeyQ', 'KeyW', 'KeyE', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL',
        'Semicolon', 'Quote', 'Backslash', 'BracketLeft', 'BracketRight', 'KeyZ', 'KeyX', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash', 'IntlRo', 'ShiftLeft', 'Space', 'Unknown'].forEach(code => {
        if (rand() < 0.15) return;
        const k = { char: pool[rint(rand, 0, pool.length - 1)], finger: [0, 3, 9, 10, -1, '4', '7x', null, 2.9][rint(rand, 0, 8)] };
        if (rand() < 0.3) k.shiftChar = pool[rint(rand, 0, pool.length - 1)];
        if (rand() < 0.1) k.kana = 'あ';
        keys[code] = rand() < 0.05 ? 'broken' : k;
      });
      randomLayouts.push({ name: rand() < 0.2 ? 'x'.repeat(50) : rand() < 0.2 ? ' 名前\nつき ' : rand() < 0.1 ? 5 : '配列' + i, description: '説明' + i, keys, type: 'kana', kanaMode: true });
    }
    const weird = [null, 5, 'str', [], { keys: [] }, { keys: { KeyA: 'x' } }, { name: '😀'.repeat(25), keys: { KeyA: { char: 'ß', finger: '7x', shiftChar: '\u0001!' } } }, {}];
    const ahkTexts = [
      'a::b', 'a::b\r\nq::w ; comment\n// whole line\n;x::y\n$s::d\n*e::r\nsc010::z\nsc01a::[\n+a::b\nf::gg\nk:: l\nj::ｊ', 'nothing here', '', 'sc999::a', 'a:::b', 'a::+::b',
      '#UseHook\r\nd::a\r\n', 'tostring::a\nconstructor::b\n;;\n1::!\n-::^\n@::`\n[::{', ' a::b  // c', 'x::y;not comment', '\\::a\n¥::b\n]::c',
    ];
    const words = await page.evaluate(() => SHUTTLE_POOL.slice(0, 60).map(([kanji, kana], i) => ({ kanji, kana, romaji: i % 7 === 0 ? 'KUSUTAMU' : '', isCustomRomaji: i % 7 === 0 })));
    const englishWords = [{ kanji: 'The quick brown fox jumps over the lazy dog.', kana: '', romaji: '', isCustomRomaji: false }, { kanji: 'Hello, World! 123 ß', kana: '', romaji: '', isCustomRomaji: false }];
    return page.evaluate(({ randomLayouts, weird, ahkTexts, words, englishWords }) => {
      const savedType = activeKeyboardType;
      const out = {};
      for (const type of ['jis', 'us']) {
        applyKeyboardType(type);
        const t = {};
        t.rows = PHYSICAL_ROWS.map(row => row.map(s => [s.code, s.qwerty, s.rowIndex, Boolean(s.isModifier)]));
        t.allKeySlots = allKeySlots().map(({ slot, row }) => [slot.code, slot.qwerty, row]);
        t.editable = editableSlotRows().flat();
        t.shifted = ['1', '2', '0', '-', '^', '=', '@', '[', ']', '\\', '¥', ';', ':', "'", '`', ',', '.', '/', 'A', 'a', 'あ', ''].map(c => [c, shiftedChar(c)]);
        const analyse = (layout) => {
          const reach = buildCharReachUncached(layout, editableSlotRows().flat());
          const usage = computeCharUsage(layout);
          return {
            reach,
            usage: Object.entries(usage),
            missing: ROMAJI_REQUIRED_CHARS.filter(ch => !reach[ch]),
            ahk: generateAhkScript(layout),
            paths: ['a', 'Z', '!', '"', '+', '*', '_', '|', '~', '{', 'ß', 'あ', '', '1'].map(c => [c, findCharPath(c, reach)]),
          };
        };
        t.presets = BUILTIN_LAYOUT_KEYS.map(k => ({ key: k, layout: PRESET_LAYOUTS[k], ...analyse(PRESET_LAYOUTS[k]) }));
        t.ensured = randomLayouts.concat(weird).map(raw => {
          const copy = JSON.parse(JSON.stringify(raw));
          const res = ensureLayoutKeys(copy);
          const isLayout = res && typeof res === 'object' && !Array.isArray(res);
          return { raw, layout: isLayout ? { name: res.name, description: typeof res.description === 'string' ? res.description : null, keys: res.keys } : null, ...(isLayout ? analyse(res) : {}) };
        });
        t.ahk = ahkTexts.map(text => { try { const l = parseAhkScriptToLayout(text); return { text, layout: l }; } catch (e) { return { text, error: e.message }; } });
        // 理論値の分析：今の配列・練習文・流儀・言語を入れ替えて、旧版（v5）の関数で数える
        const saved = { layout: state.currentLayout, words: state.wordList, style: state.romajiStyle, presets: state.wordPresets, idx: state.activeWordPresetIndex };
        t.telemetry = [];
        [PRESET_LAYOUTS.qwerty, PRESET_LAYOUTS.oonishi, PRESET_LAYOUTS.dvorak, ensureLayoutKeys(JSON.parse(JSON.stringify(randomLayouts[0])))].forEach((layout, li) => {
          [['nihon', false, words], ['hepburn', false, words], ['nihon', true, englishWords]].forEach(([style, en, ws]) => {
            state.currentLayout = layout; state.wordList = ws; state.romajiStyle = style;
            state.wordPresets = [{ lang: en ? 'en' : 'ja', words: [] }]; state.activeWordPresetIndex = 0;
            const tm = computeTheoreticalTelemetry();
            t.telemetry.push({ layoutIndex: li, style, english: en, out: { totalHits: tm.totalHits, rowHits: tm.rowHits, left: tm.leftHandHits, right: tm.rightHandHits, pairs: tm.pairs, alternation: tm.alternationCount, sameFinger: tm.sameFingerCount, sameKey: tm.sameKeyCount, skipped: Object.entries(tm.skippedChars) } });
          });
        });
        t.telemetryLayouts = [PRESET_LAYOUTS.qwerty, PRESET_LAYOUTS.oonishi, PRESET_LAYOUTS.dvorak].map(l => l).concat([null]);
        state.currentLayout = saved.layout; state.wordList = saved.words; state.romajiStyle = saved.style; state.wordPresets = saved.presets; state.activeWordPresetIndex = saved.idx;
        out[type] = t;
      }
      applyKeyboardType(savedType);
      return { ...out, randomLayouts, words, englishWords };
    }, { randomLayouts, weird, ahkTexts, words, englishWords });
  },
};

// ---------- 実行 ----------
const want = process.argv.slice(2).length ? process.argv.slice(2) : ['data', ...Object.keys(GROUPS)];
const source = latestSource();
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.route(/^https?:\/\//, r => r.abort());
await page.goto(pathToFileURL(source).href);
await page.waitForFunction(() => typeof computeCompositeScore === 'function');
// 2b で使う：シャトルランの文と、組み込みの練習文のよみ
const SHUTTLE_POOL_KANA = await page.evaluate(() => SHUTTLE_POOL.map(p => p[1]));
const PRESET_KANA = await page.evaluate(() => DEFAULT_WORD_PRESETS.flatMap(p => (p.words || []).map(w => w.kana)));
globalThis.SHUTTLE_POOL_KANA = SHUTTLE_POOL_KANA;
globalThis.PRESET_KANA = PRESET_KANA;
mkdirSync(OUT, { recursive: true });
// data：正解データではなく、Rust に組み込むデータ（旧版（v5）の練習文）を core/data/ に書く
if (want.includes('data')) {
  const DATA = resolve(ROOT, 'core/data');
  mkdirSync(DATA, { recursive: true });
  const pool = await page.evaluate(() => SHUTTLE_POOL);
  writeFileSync(resolve(DATA, 'shuttle_pool.json'), '[\n' + pool.map(p => JSON.stringify(p)).join(',\n') + '\n]\n');
  const presets = await page.evaluate(() => ({ presets: DEFAULT_WORD_PRESETS, fixes: typeof BUILTIN_SENTENCE_FIXES !== 'undefined' ? BUILTIN_SENTENCE_FIXES : null }));
  writeFileSync(resolve(DATA, 'word_presets.json'), JSON.stringify({ source, ...presets }, null, 1) + '\n');
  console.log('data     → core/data/shuttle_pool.json（' + pool.length + ' 文）・word_presets.json');
}
for (const name of want.filter(n => n !== 'data')) {
  if (!GROUPS[name]) { console.error('知らないまとまり：' + name); process.exitCode = 1; continue; }
  const data = await GROUPS[name](page);
  const file = resolve(OUT, name + '.json');
  writeFileSync(file, JSON.stringify({ source, generator: 'golden/generate.mjs', ...data }) + '\n');
  console.log(name.padEnd(8) + ' → core/tests/golden/' + name + '.json');
}
await browser.close();
