//! 画面（JS）から呼ぶ口（WebAssembly）。
//!
//! 込み入った値は JSON の文字列でやりとりする（形は各関数の説明と、旧版（v5）の保存データの形に合わせてある）。
//! 状態を持つもの（練習・シャトルラン・キーの読み取り・ユーザー辞書）はクラスにする。
//! 流儀は 'nihon' / 'hepburn'、キーボードの種類は 'jis' / 'us' の文字列で渡す。

use crate::dict::{self, Segment, Token, UserDict};
use crate::kana::{self, Chunk, Style, Word};
use crate::keys::{self, KeyContext, KeyEvent, Via};
use crate::layout::{self, KeyboardType, Layout};
use crate::records::{self, FinishInput, TrophyStore};
use crate::score;
use crate::shuttle::{self, ShuttleRecord};
use crate::shuttle_run::{Event, Phase, ShuttleRun};
use crate::typing::{Lang, Outcome, Session};
use crate::{lz, text};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

// ---------- JSON の出し入れ ----------

fn parse(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or(Value::Null)
}

fn style(s: &str) -> Style {
    Style::parse(s)
}

fn kind(s: &str) -> KeyboardType {
    KeyboardType::parse(s)
}

fn str_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

fn word_from(v: &Value) -> Word {
    Word {
        kanji: str_of(v, "kanji"),
        kana: str_of(v, "kana"),
        romaji: str_of(v, "romaji"),
        is_custom_romaji: v.get("isCustomRomaji").and_then(Value::as_bool).unwrap_or(false),
    }
}

fn word_json(w: &Word) -> Value {
    json!({ "kanji": w.kanji, "kana": w.kana, "romaji": w.romaji, "isCustomRomaji": w.is_custom_romaji })
}

fn chunks_json(cs: &[Chunk]) -> Value {
    Value::Array(cs.iter().map(|c| json!({ "kana": c.kana, "options": c.options })).collect())
}

fn segs_json(segs: &[Segment]) -> Value {
    Value::Array(
        segs.iter()
            .map(|x| json!({ "s": x.text, "r": x.reading, "user": x.user, "b": x.base }))
            .collect(),
    )
}

/// 配列の JSON（保存の形）を読む。読めなければ、その種類の QWERTY。
fn layout_from(json: &str, k: KeyboardType) -> Layout {
    layout::ensure_layout_keys(&parse(json), k).unwrap_or_else(|| layout::preset_layout("qwerty", k).expect("qwerty はある"))
}

fn telemetry_json(t: &layout::Telemetry) -> Value {
    json!({
        "totalHits": t.total_hits, "rowHits": t.row_hits, "leftHandHits": t.left_hand_hits, "rightHandHits": t.right_hand_hits,
        "pairs": t.pairs, "alternationCount": t.alternation_count, "sameFingerCount": t.same_finger_count, "sameKeyCount": t.same_key_count,
        "skippedChars": Value::Object(t.skipped_chars.iter().map(|(c, n)| (c.clone(), json!(n))).collect()),
    })
}

fn outcome_json(o: &Outcome) -> Value {
    match o {
        Outcome::NotTyping => json!({ "kind": "notTyping" }),
        Outcome::Swallowed => json!({ "kind": "swallowed" }),
        Outcome::Correct { sentence_done, finished } => json!({ "kind": "correct", "sentenceDone": sentence_done, "finished": finished }),
        Outcome::Mistake { expected } => json!({ "kind": "mistake", "expected": expected }),
        Outcome::Guarded => json!({ "kind": "guarded" }),
    }
}

fn rank_json(r: &score::ScoreRank) -> Value {
    let i = r.tier.info();
    json!({ "rank": r.rank, "min": r.min, "tier": r.tier.as_str(), "label": i.label, "color": i.color, "bg": i.bg, "comment": i.comment })
}

fn rhythm_json(r: &score::Rhythm) -> Value {
    json!({ "smooth": r.smooth, "stalls": r.stalls, "samples": r.samples, "mul": r.mul })
}

// ---------- スコア ----------

/// 打鍵の間隔（ミリ秒の配列の JSON）からリズム → {smooth, stalls, samples, mul}。
#[wasm_bindgen(js_name = computeRhythm)]
pub fn compute_rhythm(intervals_json: &str) -> String {
    let iv: Vec<f64> = parse(intervals_json)
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default();
    rhythm_json(&score::compute_rhythm(&iv)).to_string()
}

/// スコア → {score, speedPts, accMul, rhythmMul}。`rhythm_mul` がなければ 0.9。
#[wasm_bindgen(js_name = computeCompositeScore)]
pub fn compute_composite_score(ref_kpm: f64, acc_ratio: f64, rhythm_mul: Option<f64>) -> String {
    let r = rhythm_mul.map(|mul| score::Rhythm {
        smooth: None,
        stalls: 0,
        samples: 0,
        mul,
    });
    let c = score::compute_composite_score(ref_kpm, acc_ratio, r.as_ref());
    json!({ "score": c.score, "speedPts": c.speed_pts, "accMul": c.acc_mul, "rhythmMul": c.rhythm_mul }).to_string()
}

/// スコアのランクと次のランク → {rank: {...}, next: {...} | null}。
#[wasm_bindgen(js_name = scoreRank)]
pub fn score_rank(score: f64) -> String {
    json!({ "rank": rank_json(score::score_rank(score)), "next": score::next_rank(score).map(rank_json) }).to_string()
}

/// ランクの表（高い順）。
#[wasm_bindgen(js_name = scoreRanks)]
pub fn score_ranks() -> String {
    Value::Array(score::SCORE_RANKS.iter().map(rank_json).collect()).to_string()
}

// ---------- 自動改行・圧縮 ----------

#[wasm_bindgen(js_name = autoBreakLine)]
pub fn auto_break_line(line: &str, size: usize) -> String {
    json!(text::auto_break_line(line, size)).to_string()
}

#[wasm_bindgen(js_name = isReadingSpecLine)]
pub fn is_reading_spec_line(line: &str) -> bool {
    text::is_reading_spec_line(line)
}

#[wasm_bindgen(js_name = countedLength)]
pub fn counted_length(s: &str) -> usize {
    text::counted_length(s)
}

#[wasm_bindgen(js_name = lzCompress16)]
pub fn lz_compress16(input: &str) -> String {
    lz::compress16(input)
}

/// 展開 → {ok: true, value} か {ok: false, error: 'truncated' | 'invalid' | 'badText'}。
#[wasm_bindgen(js_name = lzDecompress16)]
pub fn lz_decompress16(input: &str) -> String {
    match lz::decompress16(input) {
        Ok(v) => json!({ "ok": true, "value": v }),
        Err(e) => json!({ "ok": false, "error": match e { lz::LzError::Truncated => "truncated", lz::LzError::Invalid => "invalid", lz::LzError::BadText => "badText" } }),
    }
    .to_string()
}

/// 保存されていた値を読める形に（JSON の文字列か null）。
#[wasm_bindgen(js_name = decodeStored)]
pub fn decode_stored(raw: &str) -> String {
    json!(lz::decode_stored(raw)).to_string()
}

#[wasm_bindgen(js_name = encodeForStorage)]
pub fn encode_for_storage(enabled: bool, key: &str, value: &str) -> String {
    lz::encode_for_storage(enabled, key, value)
}

// ---------- シャトルランの式 ----------

#[wasm_bindgen(js_name = shuttleRules)]
pub fn shuttle_rules() -> String {
    let r = &shuttle::SH_RULES;
    json!({
        "startKps": r.start_kps, "growth": r.growth, "growthLate": r.growth_late, "lateFrom": r.late_from, "comboEvery": r.combo_every,
        "comboBonus": r.combo_bonus, "missPenalty": r.miss_penalty, "missPenaltyHeavy": r.miss_penalty_heavy, "heavyAfter": r.heavy_after,
        "carryRate": r.carry_rate, "carryMax": r.carry_max, "perfectBonus": r.perfect_bonus, "shieldStreak": r.shield_streak,
        "shieldMax": r.shield_max, "shieldRefill": r.shield_refill, "invincibleSec": r.invincible_sec, "twoPartsFrom": r.two_parts_from,
        "threePartsFrom": r.three_parts_from, "levelsPerStage": r.levels_per_stage,
    })
    .to_string()
}

/// レベルの数 → {targetKeys, readTime, kps, stage, parts, baseLimit}（baseLimit は目安の打鍵数で）。
#[wasm_bindgen(js_name = shuttleLevelInfo)]
pub fn shuttle_level_info(level: i32) -> String {
    let keys = shuttle::target_keys(level);
    json!({
        "targetKeys": keys, "readTime": shuttle::read_time(level), "kps": shuttle::kps(level), "stage": shuttle::stage_of(level),
        "parts": shuttle::parts_for(level), "baseLimit": shuttle::base_limit(level, keys),
    })
    .to_string()
}

#[wasm_bindgen(js_name = shuttleBaseLimit)]
pub fn shuttle_base_limit(level: i32, keys: f64) -> f64 {
    shuttle::base_limit(level, keys)
}

/// シャトルランの練習文の数。
#[wasm_bindgen(js_name = shuttlePoolSize)]
pub fn shuttle_pool_size() -> usize {
    shuttle::pool().len()
}

// ---------- かな → ローマ字 ----------

#[wasm_bindgen(js_name = buildKanaChunks)]
pub fn build_kana_chunks(reading: &str, style_name: &str) -> String {
    chunks_json(&kana::build_kana_chunks(reading, style(style_name))).to_string()
}

/// 練習文（{kanji, kana, romaji, isCustomRomaji} の JSON）を練習の単位に。
#[wasm_bindgen(js_name = wordChunks)]
pub fn word_chunks(word_json: &str, style_name: &str) -> String {
    chunks_json(&kana::word_chunks(&word_from(&parse(word_json)), style(style_name))).to_string()
}

#[wasm_bindgen(js_name = primaryRomaji)]
pub fn primary_romaji(kana_text: &str, style_name: &str) -> String {
    kana::primary_romaji(kana_text, style(style_name))
}

#[wasm_bindgen(js_name = effectiveWordRomaji)]
pub fn effective_word_romaji(word_json: &str, style_name: &str) -> String {
    kana::effective_word_romaji(&word_from(&parse(word_json)), style(style_name))
}

#[wasm_bindgen(js_name = normalizeReading)]
pub fn normalize_reading(s: &str) -> String {
    kana::normalize_reading(s)
}

#[wasm_bindgen(js_name = kanaOfText)]
pub fn kana_of_text(s: &str) -> String {
    kana::kana_of_text(s)
}

#[wasm_bindgen(js_name = normalizeRomajiInput)]
pub fn normalize_romaji_input(s: &str) -> String {
    kana::normalize_romaji_input(s)
}

#[wasm_bindgen(js_name = normalizeEnglishText)]
pub fn normalize_english_text(s: &str) -> String {
    kana::normalize_english_text(s)
}

#[wasm_bindgen(js_name = hasUnconvertedKanji)]
pub fn has_unconverted_kanji(s: &str) -> bool {
    kana::has_unconverted_kanji(s)
}

// ---------- 辞書 ----------

#[wasm_bindgen]
extern "C" {
    /// 形態素解析（kuromoji）を包んだ JS のオブジェクト：`tokenizeJson(文)` が
    /// `[{surface_form, basic_form, reading}]` の JSON の文字列を返す。
    pub type Tokenizer;
    #[wasm_bindgen(method, js_name = tokenizeJson)]
    fn tokenize_json(this: &Tokenizer, text: &str) -> String;
}

/// ユーザー辞書（と内蔵の辞書）。
#[wasm_bindgen]
pub struct UserDictionary {
    inner: UserDict,
}

#[wasm_bindgen]
impl UserDictionary {
    /// 保存データ（custom_typing_user_dict_v1 の値。ないときは undefined）から。
    #[wasm_bindgen(constructor)]
    pub fn new(raw: Option<String>) -> UserDictionary {
        UserDictionary {
            inner: UserDict::load(raw.as_deref()),
        }
    }

    /// [[語, よみ], ...] の JSON。
    #[wasm_bindgen(js_name = entriesJson)]
    pub fn entries_json(&self) -> String {
        json!(self.inner.entries).to_string()
    }

    /// 語の並びを置き換える（[[語, よみ], ...] の JSON）。最初からの語を出したかどうかは残す。
    #[wasm_bindgen(js_name = setEntries)]
    pub fn set_entries(&mut self, entries_json: &str) {
        let entries: Vec<(String, String)> = parse(entries_json)
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|e| Some((e.get(0)?.as_str()?.to_string(), e.get(1)?.as_str()?.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        let offered = std::mem::take(&mut self.inner.defaults_offered);
        self.inner = UserDict::new(entries);
        self.inner.defaults_offered = offered;
    }

    /// 保存する文字列（{entries, defaults, at}）。
    #[wasm_bindgen(js_name = toStorage)]
    pub fn to_storage(&self, now: f64) -> String {
        json!({ "entries": self.inner.entries, "defaults": self.inner.defaults_offered, "at": records::num(now) }).to_string()
    }

    /// 文の区切りとよみ → [{s, r, user, b}]。
    pub fn segments(&self, s: &str) -> String {
        segs_json(&self.inner.segments(s)).to_string()
    }

    /// 2 つの辞書でのよみ（知らない漢字は残る）。
    pub fn apply(&self, s: &str) -> String {
        self.inner.apply(s)
    }

    #[wasm_bindgen(js_name = hasWordIn)]
    pub fn has_word_in(&self, s: &str) -> bool {
        self.inner.has_word_in(s)
    }

    /// 形態素解析も使ってよみを付ける → [{s, r, user, b}]。
    #[wasm_bindgen(js_name = tokenizeWith)]
    pub fn tokenize_with(&self, sentence: &str, tokenizer: &Tokenizer) -> String {
        let segs = self.inner.tokenize_with(sentence, |part| {
            parse(&tokenizer.tokenize_json(part))
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|t| Token {
                            surface_form: str_of(t, "surface_form"),
                            basic_form: t.get("basic_form").and_then(Value::as_str).map(String::from),
                            reading: t.get("reading").and_then(Value::as_str).map(String::from),
                        })
                        .collect()
                })
                .unwrap_or_default()
        });
        segs_json(&segs).to_string()
    }

    /// 貼り付けた 1 行 → {word, readingGiven, autoSegments} か null。
    #[wasm_bindgen(js_name = parsePastedLine)]
    pub fn parse_pasted_line(&self, line: &str, style_name: &str) -> String {
        self.inner
            .parse_pasted_line(line, style(style_name))
            .map_or(Value::Null, |p| pasted_json(&p))
            .to_string()
    }

    /// 貼り付け欄の全体 → [{word, readingGiven, autoSegments}]。
    #[wasm_bindgen(js_name = parseMultiLine)]
    pub fn parse_multi_line(&self, raw: &str, english: bool, style_name: &str) -> String {
        Value::Array(
            self.inner
                .parse_multi_line(raw, english, style(style_name))
                .iter()
                .map(pasted_json)
                .collect(),
        )
        .to_string()
    }
}

fn pasted_json(p: &dict::PastedLine) -> Value {
    json!({ "word": word_json(&p.word), "readingGiven": p.reading_given, "autoSegments": p.auto_segments.as_deref().map(segs_json) })
}

#[wasm_bindgen(js_name = cleanDictWord)]
pub fn clean_dict_word(s: &str) -> String {
    dict::clean_word(s)
}

#[wasm_bindgen(js_name = cleanDictReading)]
pub fn clean_dict_reading(s: &str) -> String {
    dict::clean_reading(s)
}

/// 送りがなの違いだけの 2 つの形（辞書形と文中の形）→ `{baseTail, surfTail}`（送りがな以外も違えば `null`）。
/// 「辞書に登録」の候補を、活用した形から辞書形に直すのに使う。
#[wasm_bindgen(js_name = okuriganaTails)]
pub fn okurigana_tails(base: &str, surface: &str) -> String {
    match dict::okurigana_tails(base, surface) {
        Some((base_tail, surf_tail)) => json!({ "baseTail": base_tail, "surfTail": surf_tail }).to_string(),
        None => "null".to_string(),
    }
}

// ---------- 配列 ----------

/// キーボードの行 → [[{code, label, row, finger, isModifier, homeBump}]]。
#[wasm_bindgen(js_name = keyboardRows)]
pub fn keyboard_rows(kind_name: &str) -> String {
    let rows: Vec<Value> = kind(kind_name)
        .rows()
        .iter()
        .map(|r| {
            Value::Array(
                r.iter()
                    .map(|s| json!({ "code": s.key.code, "label": s.label, "row": s.row, "finger": s.key.default_finger, "isModifier": s.key.is_modifier, "homeBump": s.key.home_bump }))
                    .collect(),
            )
        })
        .collect();
    Value::Array(rows).to_string()
}

#[wasm_bindgen(js_name = shiftedChar)]
pub fn shifted_char(kind_name: &str, ch: &str) -> String {
    kind(kind_name).shifted_char(ch)
}

/// 組み込みの配列（oonishi / qwerty / dvorak / colemak）の JSON。知らない名前は null。
#[wasm_bindgen(js_name = presetLayout)]
pub fn preset_layout(key: &str, kind_name: &str) -> String {
    layout::preset_layout(key, kind(kind_name))
        .map_or(Value::Null, |l| l.to_json())
        .to_string()
}

/// 保存された配列を整える（オブジェクトでなければ null）。
#[wasm_bindgen(js_name = ensureLayout)]
pub fn ensure_layout(layout_json: &str, kind_name: &str) -> String {
    layout::ensure_layout_keys(&parse(layout_json), kind(kind_name))
        .map_or(Value::Null, |l| l.to_json())
        .to_string()
}

/// 文字 → {code, shift}。
#[wasm_bindgen(js_name = charReach)]
pub fn char_reach(layout_json: &str, kind_name: &str) -> String {
    let k = kind(kind_name);
    let r = layout::char_reach(&layout_from(layout_json, k), k);
    Value::Object(
        r.into_iter()
            .map(|(c, p)| (c, json!({ "code": p.code, "shift": p.shift })))
            .collect(),
    )
    .to_string()
}

/// 配列の点検 → {missing: [文字], duplicates: [[文字, [code]]]}。
#[wasm_bindgen(js_name = layoutHealth)]
pub fn layout_health(layout_json: &str, kind_name: &str) -> String {
    let k = kind(kind_name);
    let h = layout::layout_health(&layout_from(layout_json, k), k);
    json!({ "missing": h.missing, "duplicates": h.duplicates }).to_string()
}

#[wasm_bindgen(js_name = generateAhk)]
pub fn generate_ahk(layout_json: &str, kind_name: &str) -> String {
    let k = kind(kind_name);
    layout::generate_ahk_script(&layout_from(layout_json, k), k)
}

/// AHK を読む → {ok: true, layout} か {ok: false, error}。
#[wasm_bindgen(js_name = parseAhk)]
pub fn parse_ahk(text: &str, kind_name: &str) -> String {
    match layout::parse_ahk_script(text, kind(kind_name)) {
        Ok(l) => json!({ "ok": true, "layout": l.to_json() }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
    .to_string()
}

/// 2 つのキーの文字を入れ替えた配列。
#[wasm_bindgen(js_name = swapKeys)]
pub fn swap_keys(layout_json: &str, kind_name: &str, a: &str, b: &str, shift_layer: bool) -> String {
    let mut l = layout_from(layout_json, kind(kind_name));
    layout::swap_keys(&mut l, a, b, shift_layer);
    l.to_json().to_string()
}

/// キーに文字を割り当てる → {layout, result: 'rejected' | 'unchanged' | 'changed', old, swappedWith}。
#[wasm_bindgen(js_name = assignChar)]
pub fn assign_char(layout_json: &str, kind_name: &str, code: &str, ch: &str, shift_layer: bool, swap_on_assign: bool) -> String {
    let k = kind(kind_name);
    let mut l = layout_from(layout_json, k);
    let res = layout::assign_char(&mut l, code, ch, shift_layer, swap_on_assign, k);
    let (result, old, swapped) = match res {
        layout::Assign::Rejected => ("rejected", None, None),
        layout::Assign::Unchanged => ("unchanged", None, None),
        layout::Assign::Changed { old, swapped_with } => ("changed", Some(old), swapped_with),
    };
    json!({ "layout": l.to_json(), "result": result, "old": old, "swappedWith": swapped }).to_string()
}

/// 理論値の分析。`words_json` は練習文の配列。
#[wasm_bindgen(js_name = theoreticalTelemetry)]
pub fn theoretical_telemetry(layout_json: &str, kind_name: &str, words_json: &str, style_name: &str, english: bool) -> String {
    let k = kind(kind_name);
    let words: Vec<Word> = parse(words_json)
        .as_array()
        .map(|a| a.iter().map(word_from).collect())
        .unwrap_or_default();
    telemetry_json(&layout::theoretical_telemetry(
        &layout_from(layout_json, k),
        &words,
        style(style_name),
        english,
        k,
    ))
    .to_string()
}

// ---------- キーの読み取り ----------

/// キーの読み取り（配列・調整・追加のキーを持つ）。
#[wasm_bindgen]
pub struct KeyReader {
    layout: Layout,
    kind: KeyboardType,
    calibration: Option<keys::Calibration>,
    extra: keys::SignalMap,
}

#[wasm_bindgen]
impl KeyReader {
    /// `calibration_raw`・`extra_raw` は保存データ（custom_typing_calibration_v1・custom_typing_extra_keys_v1）。
    #[wasm_bindgen(constructor)]
    pub fn new(layout_json: &str, kind_name: &str, calibration_raw: Option<String>, extra_raw: Option<String>) -> KeyReader {
        let k = kind(kind_name);
        KeyReader {
            layout: layout_from(layout_json, k),
            kind: k,
            calibration: keys::load_calibration(calibration_raw.as_deref(), k),
            extra: keys::load_extra_keys(extra_raw.as_deref(), k),
        }
    }

    fn ctx(&self, virtual_shift: bool) -> KeyContext<'_> {
        KeyContext {
            layout: &self.layout,
            kind: self.kind,
            calibration: self.calibration.as_ref(),
            extra_keys: &self.extra,
            virtual_shift_held: virtual_shift,
        }
    }

    /// キーが打つ文字 → {code, char, altChar} か null。
    pub fn resolve(&self, code: &str, key: &str, shift_key: bool, virtual_shift: bool) -> String {
        let e = KeyEvent {
            code: code.into(),
            key: key.into(),
            shift_key,
        };
        self.ctx(virtual_shift)
            .resolve_key_event(&e)
            .map_or(Value::Null, |r| json!({ "code": r.code, "char": r.ch, "altChar": r.alt_char }))
            .to_string()
    }

    /// 今このキーがすること → {code, via, sig, shift} か null（code が '@shift' なら Shift として使うキー）。
    pub fn reading(&self, code: &str, key: &str, shift_key: bool) -> String {
        let e = KeyEvent {
            code: code.into(),
            key: key.into(),
            shift_key,
        };
        self.ctx(false)
            .current_reading_of(&e)
            .map_or(Value::Null, |r| json!({ "code": r.code, "via": match r.via { Via::Extra => "extra", Via::Calib => "calib", Via::Std => "std" }, "sig": r.sig, "shift": r.shift }))
            .to_string()
    }

    /// 物理的な位置（キーボードの図にないキーは undefined）。
    #[wasm_bindgen(js_name = physicalCode)]
    pub fn physical_code(&self, code: &str, key: &str, shift_key: bool) -> Option<String> {
        self.ctx(false).resolve_physical_code(&KeyEvent {
            code: code.into(),
            key: key.into(),
            shift_key,
        })
    }

    #[wasm_bindgen(js_name = isCalibratedCharKey)]
    pub fn is_calibrated_char_key(&self, code: &str, key: &str, shift_key: bool) -> bool {
        self.ctx(false).is_calibrated_char_key(&KeyEvent {
            code: code.into(),
            key: key.into(),
            shift_key,
        })
    }

    #[wasm_bindgen(js_name = escapeIsTypedKey)]
    pub fn escape_is_typed_key(&self) -> bool {
        keys::escape_is_typed_key(self.calibration.as_ref(), self.kind)
    }

    #[wasm_bindgen(js_name = hasCalibration)]
    pub fn has_calibration(&self) -> bool {
        self.calibration.is_some()
    }

    /// 読み込めたキーボード調整 → {map: [[信号, 位置]], shiftMap: [[信号, 位置]], at, shiftAt, remapped, skipped} か null。
    /// （調整の画面が、今の状態を見せる・Shift の調整を引き継ぐのに使う。使えない項目はもう除いてある）
    #[wasm_bindgen(js_name = calibrationJson)]
    pub fn calibration_json(&self) -> String {
        self.calibration
            .as_ref()
            .map_or(Value::Null, |c| {
                json!({ "map": c.map, "shiftMap": c.shift_map, "at": c.at, "shiftAt": c.shift_at, "remapped": c.remapped, "skipped": c.skipped })
            })
            .to_string()
    }

    /// 読み込めた追加のキー → [[信号, 位置（'Digit1'・'Digit1+Shift'）か '@shift']]。
    #[wasm_bindgen(js_name = extraJson)]
    pub fn extra_json(&self) -> String {
        json!(self.extra).to_string()
    }
}

/// 1 打の信号（KeyA・key:a、Shift つきなら +Shift）。
#[wasm_bindgen(js_name = keySignalOf)]
pub fn key_signal_of(code: &str, key: &str, shift_key: bool, with_shift: bool) -> String {
    keys::key_signal_of(
        &KeyEvent {
            code: code.into(),
            key: key.into(),
            shift_key,
        },
        with_shift,
    )
}

// ---------- 練習 ----------

fn session_state(se: &Session) -> Value {
    json!({
        "wordIndex": se.word_index, "words": se.words.len(), "chunkIndex": se.chunk_index,
        "chunks": se.chunks.iter().map(|c| json!({ "kana": c.kana, "options": c.options, "typed": c.typed, "skipped": c.skipped })).collect::<Vec<_>>(),
        "lang": if se.lang == Lang::En { "en" } else { "ja" },
        "finished": se.finished, "correct": se.correct, "mistakes": se.mistakes, "combo": se.combo, "maxCombo": se.max_combo,
        "completedKana": se.completed_kana, "completedRefKeys": se.completed_ref_keys, "currentWordRefKeys": se.current_word_ref_keys,
        "missedChars": Value::Object(se.missed_chars.iter().map(|(c, n)| (c.clone(), json!(n))).collect()),
        "keyIntervals": se.key_intervals, "nextChar": se.target_next_char(), "live": telemetry_json(&se.live),
    })
}

/// 1 回の練習。
#[wasm_bindgen]
pub struct TypingSession {
    inner: Session,
}

#[wasm_bindgen]
impl TypingSession {
    /// `config_json`：{words: [練習文], langs?: ['ja'|'en'|null], lang: 'ja'|'en', style, kind, layout: 配列}。
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str) -> TypingSession {
        let c = parse(config_json);
        let k = kind(&str_of(&c, "kind"));
        let words: Vec<Word> = c
            .get("words")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(word_from).collect())
            .unwrap_or_default();
        let lang_of = |v: &Value| match v.as_str() {
            Some("en") => Some(Lang::En),
            Some("ja") => Some(Lang::Ja),
            _ => None,
        };
        let langs: Vec<Option<Lang>> = (0..words.len())
            .map(|i| c.get("langs").and_then(|l| l.get(i)).and_then(lang_of))
            .collect();
        let lang = c.get("lang").and_then(lang_of).unwrap_or(Lang::Ja);
        let layout = layout_from(&c.get("layout").map_or("null".into(), Value::to_string), k);
        TypingSession {
            inner: Session::new(words, langs, lang, style(&str_of(&c, "style")), layout, k),
        }
    }

    /// 1 文字を打つ → {kind: 'correct'|'mistake'|..., ...}。
    pub fn input(&mut self, ch: &str, code: Option<String>, now: f64, guarding: bool) -> String {
        outcome_json(&self.inner.input(ch, code.as_deref(), now, guarding)).to_string()
    }

    /// キーが打った 2 つの文字（Shift あり・なし）のうち、判定に使う方。
    #[wasm_bindgen(js_name = chooseInputChar)]
    pub fn choose_input_char(&self, ch: &str, alt: Option<String>) -> String {
        self.inner.choose_input_char(ch, alt.as_deref()).to_string()
    }

    #[wasm_bindgen(js_name = inputWouldMatch)]
    pub fn input_would_match(&self, ch: &str) -> bool {
        self.inner.input_would_match(ch)
    }

    #[wasm_bindgen(js_name = nextChar)]
    pub fn next_char(&self) -> Option<String> {
        self.inner.target_next_char()
    }

    /// 今の状態（単位・打ち具合・数・実測の分析）。
    pub fn state(&self) -> String {
        session_state(&self.inner).to_string()
    }

    /// 練習を終えたときの結果（`meta_json`：{elapsedMs, isEnglish, courseKey, courseName, groupName, layoutKey, layoutName, id, timestamp}）。
    /// 何も打たなかったときは null。
    pub fn finish(&self, meta_json: &str) -> String {
        let m = parse(meta_json);
        let se = &self.inner;
        let input = FinishInput {
            correct: se.correct,
            mistakes: se.mistakes,
            completed_kana: se.completed_kana,
            completed_ref_keys: se.completed_ref_keys,
            key_intervals: &se.key_intervals,
            max_combo: se.max_combo,
            sentences: se.words.len(),
            elapsed_ms: m.get("elapsedMs").and_then(Value::as_f64).unwrap_or(0.0),
            is_english: m.get("isEnglish").and_then(Value::as_bool).unwrap_or(false),
            course_key: m.get("courseKey").and_then(Value::as_str).unwrap_or(""),
            course_name: m.get("courseName").and_then(Value::as_str).unwrap_or(""),
            group_name: m.get("groupName").and_then(Value::as_str),
            layout_key: m.get("layoutKey").and_then(Value::as_str).unwrap_or(""),
            layout_name: m.get("layoutName").and_then(Value::as_str).unwrap_or(""),
            romaji_style: se.style.as_str(),
            id: m.get("id").and_then(Value::as_str).unwrap_or(""),
            timestamp: m.get("timestamp").and_then(Value::as_f64).unwrap_or(0.0),
        };
        records::finish_session(&input).map_or(Value::Null, |r| finish_json(&r)).to_string()
    }
}

fn finish_json(r: &records::SessionResult) -> Value {
    json!({
        "kpm": r.kpm, "wpm": r.wpm, "cpm": r.cpm, "cpmRaw": r.cpm_raw, "accRatio": r.acc_ratio, "accPct": r.acc_pct, "refKpm": r.ref_kpm,
        "rhythm": rhythm_json(&r.rhythm), "score": { "score": r.score.score, "speedPts": r.score.speed_pts, "accMul": r.score.acc_mul, "rhythmMul": r.score.rhythm_mul },
        "rank": rank_json(score::score_rank(r.score.score)), "next": score::next_rank(r.score.score).map(rank_json), "secs": r.secs, "record": r.record,
    })
}

// ---------- シャトルラン ----------

/// 決まった乱数（mulberry32）。出題用。
fn seeded_random(seed: u32) -> Box<dyn FnMut() -> f64> {
    let mut s = seed;
    Box::new(move || {
        s = s.wrapping_add(0x6D2B_79F5);
        let mut t = (s ^ (s >> 15)).wrapping_mul(1 | s);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    })
}

fn event_json(e: &Event) -> Value {
    match e {
        Event::Stage(n) => json!({ "kind": "stage", "stage": n }),
        Event::ComboBonus => json!({ "kind": "comboBonus" }),
        Event::MissPenalty(p) => json!({ "kind": "missPenalty", "sec": p }),
        Event::Guard => json!({ "kind": "guard" }),
        Event::ShieldGot(n) => json!({ "kind": "shieldGot", "shields": n }),
        Event::LevelCleared { perfect, carry } => json!({ "kind": "levelCleared", "perfect": perfect, "carry": carry }),
        Event::PartCleared => json!({ "kind": "partCleared" }),
        Event::ShieldUsed => json!({ "kind": "shieldUsed" }),
        Event::TimeUp => json!({ "kind": "timeUp" }),
        Event::Untypeable => json!({ "kind": "untypeable" }),
    }
}

/// シャトルラン 1 回。
#[wasm_bindgen]
pub struct ShuttleGame {
    inner: ShuttleRun,
}

#[wasm_bindgen]
impl ShuttleGame {
    /// 始める。`seed` は出題の乱数の種（JS で Math.random() * 2**32 などを渡す）。
    #[wasm_bindgen(constructor)]
    pub fn new(layout_json: &str, kind_name: &str, style_name: &str, now: f64, seed: u32) -> ShuttleGame {
        let k = kind(kind_name);
        ShuttleGame {
            inner: ShuttleRun::begin(layout_from(layout_json, k), k, style(style_name), now, seeded_random(seed)),
        }
    }

    pub fn input(&mut self, ch: &str, code: Option<String>, now: f64) -> String {
        outcome_json(&self.inner.input(ch, code.as_deref(), now)).to_string()
    }

    /// キーが打った 2 つの文字（Shift あり・なし）のうち、判定に使う方。
    #[wasm_bindgen(js_name = chooseInputChar)]
    pub fn choose_input_char(&self, ch: &str, alt: Option<String>) -> String {
        self.inner.session.choose_input_char(ch, alt.as_deref()).to_string()
    }

    pub fn tick(&mut self, now: f64) {
        self.inner.tick(now);
    }

    pub fn pause(&mut self, now: f64) {
        self.inner.pause(now);
    }

    pub fn resume(&mut self, now: f64) {
        self.inner.resume(now);
    }

    pub fn quit(&mut self) {
        self.inner.quit();
    }

    #[wasm_bindgen(js_name = timeLeft)]
    pub fn time_left(&self, now: f64) -> f64 {
        self.inner.time_left(now)
    }

    pub fn guarding(&self, now: f64) -> bool {
        self.inner.guarding(now)
    }

    /// たまった知らせを取り出す（[{kind, ...}]）。
    #[wasm_bindgen(js_name = takeEvents)]
    pub fn take_events(&mut self) -> String {
        Value::Array(self.inner.events.drain(..).map(|e| event_json(&e)).collect()).to_string()
    }

    /// 今の状態。
    pub fn state(&self) -> String {
        let r = &self.inner;
        let w = r.session.words.get(r.session.word_index);
        // 文を分けて出すレベル：今の部分（何番目, いくつ中）と、次の部分（下に薄く出す）
        let part = r.parts.get(r.session.word_index).copied();
        let next = part
            .filter(|(i, n)| i + 1 < *n)
            .and_then(|_| r.session.words.get(r.session.word_index + 1));
        json!({
            "comboCount": r.combo_count, "perfectStreak": r.perfect_streak,
            "part": part.map(|(i, n)| json!([i, n])), "nextWord": next.map(word_json),
            "phase": match r.phase { Phase::Intro => "intro", Phase::Run => "run", Phase::Paused => "paused", Phase::Over => "over" },
            "level": r.level, "stage": shuttle::stage_of(r.level), "shields": r.shields, "limit": r.limit, "deadline": r.deadline,
            "levelBase": r.level_base, "carryIn": r.carry_in, "levelMisses": r.level_misses,
            "records": r.records.iter().map(|l| json!({ "lv": l.lv, "limit": l.limit, "used": l.used, "miss": l.miss, "fail": l.fail })).collect::<Vec<_>>(),
            "freezes": r.freezes.iter().map(|f| json!([f.start, f.end, if f.invincible { "inv" } else { "" }])).collect::<Vec<_>>(),
            "word": w.map(word_json), "session": session_state(&r.session),
        })
        .to_string()
    }

    /// 終わった回の記録（保存する形の JSON）。
    pub fn record(&self, id: &str, timestamp: f64, now: f64, layout_name: &str) -> String {
        self.inner.record(id, timestamp, now, layout_name).to_json().to_string()
    }
}

// ---------- 記録・トロフィー・バックアップ ----------

/// 過去のスコアの記録 1 つを整える（id が使えないときは `fallback_id`）。オブジェクトでなければ null。
#[wasm_bindgen(js_name = normalizeHistoryRecord)]
pub fn normalize_history_record(record_json: &str, fallback_id: &str) -> String {
    records::normalize_history_record(&parse(record_json), &mut || fallback_id.to_string())
        .unwrap_or(Value::Null)
        .to_string()
}

/// 保存されていた過去のスコア → {records, ok}。新しい id は `id_base` に番号を付けて作る。
#[wasm_bindgen(js_name = loadScoreHistory)]
pub fn load_score_history(raw: Option<String>, key_exists: bool, id_base: &str) -> String {
    let mut n = 0;
    let (list, ok) = records::load_score_history(raw.as_deref(), key_exists, &mut || {
        n += 1;
        format!("{id_base}{n}")
    });
    json!({ "records": list, "ok": ok }).to_string()
}

/// 記録を足した一覧（多すぎれば古いものから捨てる）。
#[wasm_bindgen(js_name = pushScoreRecord)]
pub fn push_score_record(history_json: &str, entry_json: &str) -> String {
    let mut list = parse(history_json).as_array().cloned().unwrap_or_default();
    records::push_score_record(&mut list, parse(entry_json));
    Value::Array(list).to_string()
}

#[wasm_bindgen(js_name = previousBest)]
pub fn previous_best(history_json: &str, layout_name: &str, course_key: &str) -> f64 {
    records::previous_best(
        parse(history_json).as_array().map_or(&[][..], |a| a.as_slice()),
        layout_name,
        course_key,
    )
}

fn shuttle_list(raw: Option<&str>) -> Vec<ShuttleRecord> {
    records::load_shuttle_history(raw)
}

/// 保存されていたシャトルランの記録を整える。
#[wasm_bindgen(js_name = loadShuttleHistory)]
pub fn load_shuttle_history(raw: Option<String>) -> String {
    Value::Array(shuttle_list(raw.as_deref()).iter().map(ShuttleRecord::to_json).collect()).to_string()
}

/// 記録を足した一覧（保存する文字列）。
#[wasm_bindgen(js_name = pushShuttleRecord)]
pub fn push_shuttle_record(history_raw: Option<String>, record_json: &str) -> String {
    let mut list = shuttle_list(history_raw.as_deref());
    if let Some(rec) = shuttle_list(Some(&format!("[{record_json}]"))).pop() {
        records::push_shuttle_record(&mut list, rec);
    }
    Value::Array(list.iter().map(ShuttleRecord::to_json).collect()).to_string()
}

#[wasm_bindgen(js_name = shuttleBestFor)]
pub fn shuttle_best_for(layout_name: &str, history_raw: Option<String>) -> String {
    let list = shuttle_list(history_raw.as_deref());
    records::shuttle_best_for(layout_name, &list)
        .map_or(Value::Null, ShuttleRecord::to_json)
        .to_string()
}

/// トロフィーの表 → [{id, tier, name, desc}]。
#[wasm_bindgen(js_name = trophyTable)]
pub fn trophy_table() -> String {
    Value::Array(
        records::SHUTTLE_TROPHIES
            .iter()
            .map(|t| json!({ "id": t.id, "tier": t.tier, "name": t.name, "desc": t.desc }))
            .collect(),
    )
    .to_string()
}

#[wasm_bindgen(js_name = trophyTiers)]
pub fn trophy_tiers() -> String {
    Value::Array(
        records::TROPHY_TIERS
            .iter()
            .map(|(k, l, s)| json!({ "id": k, "label": l, "stops": s }))
            .collect(),
    )
    .to_string()
}

/// 保存されていたトロフィー（なければ記録から作り直す）→ {got, runs, playSec}。
#[wasm_bindgen(js_name = loadTrophies)]
pub fn load_trophies(raw: Option<String>, history_raw: Option<String>, now: f64) -> String {
    TrophyStore::load(raw.as_deref(), &shuttle_list(history_raw.as_deref()), now)
        .to_json()
        .to_string()
}

/// 走り終えた 1 回を足す → {store, fresh: [id]}。`history_raw` はこの回を含む記録。
#[wasm_bindgen(js_name = updateTrophies)]
pub fn update_trophies(raw: Option<String>, history_raw: Option<String>, record_json: &str, now: f64) -> String {
    let history = shuttle_list(history_raw.as_deref());
    let Some(rec) = shuttle_list(Some(&format!("[{record_json}]"))).pop() else {
        return Value::Null.to_string();
    };
    let (store, fresh) = TrophyStore::update(raw.as_deref(), &history, &rec, now);
    json!({ "store": store.to_json(), "fresh": fresh.iter().map(|t| t.id).collect::<Vec<_>>() }).to_string()
}

/// バックアップのファイルを確かめる → {ok: true, entries: [[キー, 値]], exportedAt, scores, shuttle} か {ok: false, reason}。
#[wasm_bindgen(js_name = validateBackup)]
pub fn validate_backup(text: &str, size_limit: Option<usize>) -> String {
    match records::validate_backup(text, size_limit) {
        Ok(b) => json!({ "ok": true, "entries": b.entries, "exportedAt": b.exported_at, "scores": b.scores, "shuttle": b.shuttle }),
        Err(e) => json!({ "ok": false, "reason": e.message() }),
    }
    .to_string()
}

/// バックアップに入れるデータ（[[キー, 値 | null]] から管理用のキーを除く）→ [[キー, 値]]。
#[wasm_bindgen(js_name = collectAppStorage)]
pub fn collect_app_storage(storage_json: &str) -> String {
    let storage: Vec<(String, Option<String>)> = parse(storage_json)
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| Some((p.get(0)?.as_str()?.to_string(), p.get(1).and_then(Value::as_str).map(String::from))))
                .collect()
        })
        .unwrap_or_default();
    json!(records::collect_app_storage(&storage)).to_string()
}

/// バックアップのファイルの文字（`data_json` は [[キー, 値]]、`exported_at` は ISO 8601）。
#[wasm_bindgen(js_name = buildBackupText)]
pub fn build_backup_text(data_json: &str, exported_at: &str) -> String {
    let data: Vec<(String, String)> = parse(data_json)
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| Some((p.get(0)?.as_str()?.to_string(), p.get(1)?.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    records::backup_text(&records::build_backup_payload(&data, exported_at))
}

#[wasm_bindgen(js_name = backedUpAt)]
pub fn backed_up_at(exported_at: Option<f64>, now: f64) -> f64 {
    records::backed_up_at(exported_at, now)
}

/// バックアップの声かけ → {last, count, dataChanged, since, due}。`timestamps_json` は記録の時刻の配列。
#[wasm_bindgen(js_name = backupReminder)]
pub fn backup_reminder(
    enabled: bool,
    last_raw: Option<String>,
    changed_raw: Option<String>,
    timestamps_json: &str,
    now: f64,
    snooze_raw: Option<String>,
) -> String {
    let ts: Vec<f64> = parse(timestamps_json)
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default();
    let info = records::reminder_info(last_raw.as_deref(), changed_raw.as_deref(), &ts);
    let due = records::reminder_due(enabled, &info, now, snooze_raw.as_deref());
    json!({ "last": info.last, "count": info.count, "dataChanged": info.data_changed, "since": info.since, "due": due }).to_string()
}

/// JS の toFixed と同じ丸め（画面の数の表示用）。
#[wasm_bindgen(js_name = toFixed)]
pub fn to_fixed(x: f64, digits: usize) -> String {
    // 桁数は 80 まで（f64 の 10 進の展開がそこで尽きる。大きすぎる・負の数が来ても止まらないように）
    records::to_fixed(x, digits.min(80))
}
