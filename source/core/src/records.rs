//! 記録と保存データ（旧版（v5）の「history tab」「records」「trophies」「data persistence & backup」「backup reminder」の計算部分）。
//!
//! 保存そのもの（localStorage）とファイルの読み書きは JS に残す。ここは「保存されていた文字列 → 整えた値」と
//! 「値 → 保存する文字列・判断」だけを受け持つ。時刻と乱数（id）は引数で受ける。

use crate::js;
use crate::score::{self, Rhythm};
use crate::shuttle::{self, ShuttleRecord};
use serde_json::{Map, Value, json};

// ---------- 保存のキー ----------

/// このツールのデータのキーの頭（バックアップと容量の計算の対象）。
pub const STORAGE_PREFIXES: [&str; 2] = ["custom_typing_", "typecraft_"];
pub const SCORE_HISTORY_KEY: &str = "custom_typing_score_history_v1";
pub const SCORE_HISTORY_UNREADABLE_KEY: &str = "custom_typing_score_history_v1_unreadable";
pub const SHUTTLE_HISTORY_KEY: &str = "custom_typing_shuttle_history_v1";
pub const SHUTTLE_TROPHY_KEY: &str = "custom_typing_shuttle_trophies_v1";
pub const BACKUP_META_KEY: &str = "custom_typing_last_backup_v1";
pub const BACKUP_SNOOZE_KEY: &str = "custom_typing_backup_snooze_v1";
pub const BACKUP_REMINDER_OFF_KEY: &str = "custom_typing_backup_reminder_off_v1";
pub const DATA_CHANGED_KEY: &str = "custom_typing_data_changed_v1";
pub const COMPRESS_FLAG_KEY: &str = "custom_typing_compress_v1";
/// 過去のスコアを残す数、シャトルランの記録を残す数。
pub const SCORE_HISTORY_MAX: usize = 200;
pub const SHUTTLE_HISTORY_MAX: usize = 100;
/// バックアップのファイルの印。
pub const BACKUP_APP: &str = "custom-typing-practice";

/// JS の数を JSON にする（整数の値は整数として。JSON.stringify と同じ見た目にするため）。
pub fn num(x: f64) -> Value {
    if x.is_finite() && x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
        Value::from(x as i64)
    } else if x.is_finite() {
        Value::from(x)
    } else {
        Value::Null // JSON.stringify は NaN・Infinity を null にする
    }
}

/// JS の真偽（`if (v)`）。
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// UTF-16 の単位で `max` までに切る（サロゲートの対は切らない）。
fn cut16(s: &str, max: usize) -> String {
    let mut out = String::new();
    let mut n = 0;
    for c in s.chars() {
        n += c.len_utf16();
        if n > max {
            break;
        }
        out.push(c);
    }
    out
}

/// JS の `Number(v)`。
fn number(v: Option<&Value>) -> f64 {
    js::to_number(v)
}

/// JS の `parseFloat(v)`（文字列にしてから、頭の数を読む）。
fn parse_float(v: &Value) -> f64 {
    let s = js::to_js_string(Some(v));
    let t = s.trim_start_matches(js::is_space);
    if let Some(rest) = t.strip_prefix("Infinity").or_else(|| t.strip_prefix("+Infinity")) {
        let _ = rest;
        return f64::INFINITY;
    }
    if t.starts_with("-Infinity") {
        return f64::NEG_INFINITY;
    }
    // いちばん長く読める頭
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let digits_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
    }
    let mantissa = &t[digits_start..i];
    if mantissa.is_empty() || mantissa == "." {
        return f64::NAN;
    }
    let mut end = i;
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let k = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > k {
            end = j;
        }
    }
    t[..end].parse::<f64>().unwrap_or(f64::NAN)
}

/// JS の `x.toFixed(digits)`（ちょうど半分は 0 から遠い方へ。値の正確な 10 進で判断する）。
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return js::number_to_string(x);
    }
    let exact = format!("{:.80}", x.abs());
    let (int, frac) = exact.split_once('.').unwrap();
    let mut ds: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).map(|b| b - b'0').collect();
    let next = frac.as_bytes().get(digits).map_or(0, |b| b - b'0');
    if next >= 5 {
        let mut i = ds.len();
        loop {
            if i == 0 {
                ds.insert(0, 1);
                break;
            }
            i -= 1;
            if ds[i] == 9 {
                ds[i] = 0;
            } else {
                ds[i] += 1;
                break;
            }
        }
    }
    let int_len = ds.len() - digits;
    let mut s: String = ds[..int_len].iter().map(|d| (b'0' + d) as char).collect();
    if digits > 0 {
        s.push('.');
        s.extend(ds[int_len..].iter().map(|d| (b'0' + d) as char));
    }
    // JS は丸めて 0 になっても負の符号を残す（(-0.04).toFixed(1) は "-0.0"）。-0 には付けない
    let negative = x < 0.0;
    if negative { format!("-{s}") } else { s }
}

/// `parseFloat(x.toFixed(1))`。
fn round1(x: f64) -> f64 {
    to_fixed(x, 1).parse().unwrap_or(f64::NAN)
}

// ---------- 過去のスコア ----------

/// 数の項目・文字の項目（古い版やバックアップから来た記録を、数は数、文字は文字にそろえる）。
pub const HISTORY_NUMBER_FIELDS: [&str; 16] = [
    "v",
    "score",
    "wpm",
    "kpm",
    "cpm",
    "accuracy",
    "rhythm",
    "stalls",
    "refKpm",
    "maxCombo",
    "missCount",
    "completedChars",
    "completedKana",
    "completedSentences",
    "durationSec",
    "timestamp",
];
pub const HISTORY_TEXT_FIELDS: [&str; 8] = [
    "courseKey",
    "courseName",
    "groupName",
    "layoutKey",
    "layoutName",
    "presetName",
    "romajiStyle",
    "lang",
];

/// id に使える形か（/^[A-Za-z0-9_-]{1,64}$/）。
fn is_safe_id(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 過去のスコアの記録 1 つを整える（旧版（v5）の normalizeHistoryRecord）。オブジェクトでなければ `None`。
/// `new_id` は id が使えないときに新しい id を作る（旧版（v5）は時刻と乱数）。ほかの項目はそのまま残す。
pub fn normalize_history_record(r: &Value, new_id: &mut dyn FnMut() -> String) -> Option<Value> {
    let mut o: Map<String, Value> = r.as_object()?.clone();
    for f in HISTORY_NUMBER_FIELDS {
        match o.get(f) {
            None | Some(Value::Null) => {}
            Some(v) => {
                let n = if let Value::Number(n) = v {
                    n.as_f64().unwrap_or(f64::NAN)
                } else {
                    parse_float(v)
                };
                o.insert(f.into(), if n.is_finite() { num(n) } else { Value::Null });
            }
        }
    }
    for f in HISTORY_TEXT_FIELDS {
        match o.get(f) {
            None | Some(Value::Null) => {}
            Some(v @ (Value::String(_) | Value::Number(_))) => {
                let s = cut16(&js::to_js_string(Some(v)), 80);
                o.insert(f.into(), Value::String(s));
            }
            Some(_) => {
                o.insert(f.into(), Value::Null);
            }
        }
    }
    if !o.get("timestamp").and_then(Value::as_f64).is_some_and(|t| t > 0.0) {
        o.insert("timestamp".into(), json!(0));
    }
    let id = o.get("id").and_then(Value::as_str).map(|s| s.replace('.', "_")).unwrap_or_default();
    o.insert("id".into(), Value::String(if is_safe_id(&id) { id } else { new_id() }));
    if !truthy(o.get("v")) {
        // 古い記録は、打鍵/分を "wpm" に入れていた
        let wpm = o
            .get("wpm")
            .and_then(Value::as_f64)
            .filter(|x| *x != 0.0 && !x.is_nan())
            .unwrap_or(0.0);
        o.insert("kpm".into(), num(wpm));
        o.insert("wpm".into(), num(js::round(wpm / 5.0)));
        if !o.contains_key("cpm") {
            o.insert("cpm".into(), Value::Null);
        }
        if !o.contains_key("maxCombo") {
            o.insert("maxCombo".into(), Value::Null);
        }
        o.insert("v".into(), json!(2));
        o.insert("legacy".into(), json!(true));
    }
    Some(Value::Object(o))
}

/// 保存されていた過去のスコアを読む（旧版（v5）の loadScoreHistoryFromStorage）。
/// `raw` は展開した値（読めなければ `None`）、`key_exists` は保存のキーがあるか。
/// 戻り値は（記録, 読めたか）。読めなかったとき、呼ぶ側は元の値を `SCORE_HISTORY_UNREADABLE_KEY` に退避してから上書きする。
pub fn load_score_history(raw: Option<&str>, key_exists: bool, new_id: &mut dyn FnMut() -> String) -> (Vec<Value>, bool) {
    match raw.filter(|r| !r.is_empty()) {
        Some(r) => match serde_json::from_str::<Value>(r) {
            Ok(Value::Array(list)) => {
                let from = list.len().saturating_sub(SCORE_HISTORY_MAX);
                (
                    list[from..].iter().filter_map(|x| normalize_history_record(x, new_id)).collect(),
                    true,
                )
            }
            _ => (Vec::new(), false),
        },
        None if !key_exists => (Vec::new(), true),
        None => (Vec::new(), false),
    }
}

/// 記録を足す（多すぎれば古いものから捨てる）。
pub fn push_score_record(history: &mut Vec<Value>, entry: Value) {
    history.push(entry);
    if history.len() > SCORE_HISTORY_MAX {
        history.drain(..history.len() - SCORE_HISTORY_MAX);
    }
}

/// 記録のコース（ない古い記録は練習文の名前から）。
pub fn course_key_of(r: &Value) -> String {
    match r.get("courseKey").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(k) => k.to_string(),
        None => format!(
            "name:{}",
            r.get("presetName")
                .map_or_else(|| "undefined".into(), |v| js::to_js_string(Some(v)))
        ),
    }
}

/// 同じ配列・同じコースの、これまでのいちばん高いスコア（なければ -1）。
pub fn previous_best(history: &[Value], layout_name: &str, course_key: &str) -> f64 {
    history
        .iter()
        .filter(|r| r.get("layoutName").and_then(Value::as_str) == Some(layout_name) && course_key_of(r) == course_key)
        .filter_map(|r| r.get("score").and_then(Value::as_f64))
        .fold(-1.0, f64::max)
}

/// 練習を終えたときの入力（旧版（v5）の finishTypingSession が state から読んでいたもの）。
#[derive(Debug, Clone)]
pub struct FinishInput<'a> {
    pub correct: u64,
    pub mistakes: u64,
    pub completed_kana: u64,
    pub completed_ref_keys: u64,
    pub key_intervals: &'a [f64],
    pub max_combo: u64,
    pub sentences: usize,
    pub elapsed_ms: f64,
    pub is_english: bool,
    pub course_key: &'a str,
    pub course_name: &'a str,
    pub group_name: Option<&'a str>,
    pub layout_key: &'a str,
    pub layout_name: &'a str,
    pub romaji_style: &'a str,
    pub id: &'a str,
    pub timestamp: f64,
}

/// 練習の結果（画面に出す数と、保存する記録）。
#[derive(Debug, Clone, PartialEq)]
pub struct SessionResult {
    pub kpm: f64,
    pub wpm: f64,
    pub cpm: f64,
    pub cpm_raw: f64,
    pub acc_ratio: f64,
    pub acc_pct: f64,
    pub ref_kpm: f64,
    pub rhythm: Rhythm,
    pub score: score::CompositeScore,
    pub secs: f64,
    /// 保存する記録（正しく打ったキーが 0 なら `None`：保存しない）。
    pub record: Option<Value>,
}

/// 練習の結果を求める。何も打たなかった（正しいキーもミスも 0）ときは `None`（旧版（v5）は「打てる文字がない」と出して始めに戻る）。
pub fn finish_session(f: &FinishInput) -> Option<SessionResult> {
    if f.correct == 0 && f.mistakes == 0 {
        return None;
    }
    let elapsed_min = f64::max(f.elapsed_ms / 60000.0, 0.005);
    let kpm = js::round(f.correct as f64 / elapsed_min);
    let wpm = js::round(f.correct as f64 / 5.0 / elapsed_min);
    let cpm_raw = f.completed_kana as f64 / elapsed_min;
    let cpm = js::round(cpm_raw);
    let attempts = f.correct + f.mistakes;
    let acc_ratio = if attempts > 0 { f.correct as f64 / attempts as f64 } else { 1.0 };
    let acc_pct = round1(acc_ratio * 100.0);
    let ref_kpm = f.completed_ref_keys as f64 / elapsed_min;
    let rhythm = score::compute_rhythm(f.key_intervals);
    let sc = score::compute_composite_score(ref_kpm, acc_ratio, Some(&rhythm));
    let secs = f64::max(1.0, js::round(elapsed_min * 60.0));
    let record = (f.correct > 0).then(|| {
        json!({
            "v": 3,
            "courseKey": f.course_key,
            "courseName": f.course_name,
            "groupName": f.group_name,
            "refKpm": num(js::round(ref_kpm)),
            "rhythm": rhythm.smooth.map_or(Value::Null, |s| num(round1(s * 100.0))),
            "stalls": rhythm.stalls,
            "id": f.id,
            "timestamp": num(f.timestamp),
            "score": num(sc.score),
            "wpm": num(wpm),
            "kpm": num(kpm),
            "cpm": num(cpm),
            "accuracy": num(acc_pct),
            "maxCombo": f.max_combo,
            "missCount": f.mistakes,
            "completedChars": f.correct,
            "completedKana": f.completed_kana,
            "completedSentences": f.sentences,
            "durationSec": num(secs),
            "layoutKey": f.layout_key,
            "layoutName": f.layout_name,
            "presetName": f.course_name,
            "romajiStyle": f.romaji_style,
            "lang": if f.is_english { "en" } else { "ja" },
        })
    });
    Some(SessionResult {
        kpm,
        wpm,
        cpm,
        cpm_raw,
        acc_ratio,
        acc_pct,
        ref_kpm,
        rhythm,
        score: sc,
        secs,
        record,
    })
}

// ---------- シャトルランの記録 ----------

/// 保存されていたシャトルランの記録を読む（旧版（v5）の loadShuttleHistory）。壊れていれば空。
pub fn load_shuttle_history(raw: Option<&str>) -> Vec<ShuttleRecord> {
    let Ok(Value::Array(list)) = serde_json::from_str::<Value>(raw.filter(|r| !r.is_empty()).unwrap_or("[]")) else {
        return Vec::new();
    };
    let ok: Vec<&Value> = list
        .iter()
        .filter(|r| {
            let finite = |k: &str| r.get(k).and_then(Value::as_f64).is_some_and(f64::is_finite) && r.get(k).is_some_and(Value::is_number);
            r.is_object() && finite("cleared") && finite("timestamp")
        })
        .collect();
    let from = ok.len().saturating_sub(SHUTTLE_HISTORY_MAX);
    ok[from..]
        .iter()
        .map(|r| {
            let int = |k: &str, min: f64, dflt: f64| f64::max(min, js::round(nz(number(r.get(k)), dflt)));
            let timestamp = number(r.get("timestamp"));
            let levels = match r.get("levels") {
                Some(Value::Array(ls)) => ls
                    .iter()
                    .filter(|l| l.is_object() || l.is_array())
                    .take(80)
                    .map(|l| shuttle::LevelRecord {
                        lv: js::round(nz(number(l.get("lv")), 0.0)),
                        limit: nz(number(l.get("limit")), 0.0),
                        used: nz(number(l.get("used")), 0.0),
                        miss: js::round(nz(number(l.get("miss")), 0.0)),
                        fail: truthy(l.get("fail")),
                    })
                    .collect(),
                _ => Vec::new(),
            };
            ShuttleRecord {
                id: match r.get("id") {
                    Some(Value::String(s)) => cut16(s, 40),
                    _ => format!("s_{}", js::number_to_string(timestamp)),
                },
                timestamp,
                level: int("level", 1.0, 1.0),
                cleared: int("cleared", 0.0, 0.0),
                keys: int("keys", 0.0, 0.0),
                misses: int("misses", 0.0, 0.0),
                accuracy: nz(number(r.get("accuracy")), 0.0).clamp(0.0, 100.0),
                max_combo: int("maxCombo", 0.0, 0.0),
                kpm: int("kpm", 0.0, 0.0),
                duration_sec: f64::max(0.0, nz(number(r.get("durationSec")), 0.0)),
                layout_name: cut16(
                    &crate::layout::strip_control_chars(&if truthy(r.get("layoutName")) {
                        js::to_js_string(r.get("layoutName"))
                    } else {
                        String::new()
                    }),
                    60,
                ),
                romaji_style: if r.get("romajiStyle").and_then(Value::as_str) == Some("hepburn") {
                    "hepburn"
                } else {
                    "nihon"
                }
                .into(),
                shields: int("shields", 0.0, 0.0),
                saves: int("saves", 0.0, 0.0),
                levels,
            }
        })
        .collect()
}

/// JS の `x || d`（NaN と 0 は d）。
fn nz(x: f64, d: f64) -> f64 {
    if x == 0.0 || x.is_nan() { d } else { x }
}

/// 記録を足す（多すぎれば古いものから捨てる）。
pub fn push_shuttle_record(list: &mut Vec<ShuttleRecord>, rec: ShuttleRecord) {
    list.push(rec);
    if list.len() > SHUTTLE_HISTORY_MAX {
        list.drain(..list.len() - SHUTTLE_HISTORY_MAX);
    }
}

/// その配列でいちばん先まで進んだ記録（同じなら先のもの）。
pub fn shuttle_best_for<'a>(layout_name: &str, list: &'a [ShuttleRecord]) -> Option<&'a ShuttleRecord> {
    let mut best: Option<&ShuttleRecord> = None;
    for r in list {
        if r.layout_name == layout_name && best.is_none_or(|b| r.cleared > b.cleared) {
            best = Some(r);
        }
    }
    best
}

// ---------- トロフィー ----------

/// トロフィーの格（ブロンズ〜ゴッド）と、表示の色。
pub const TROPHY_TIERS: [(&str, &str, [&str; 3]); 6] = [
    ("bronze", "ブロンズ", ["#f6c79a", "#cd7f32", "#7a3f12"]),
    ("silver", "シルバー", ["#ffffff", "#c0c7d2", "#7b8494"]),
    ("gold", "ゴールド", ["#fff3b0", "#f2c94c", "#a8730a"]),
    ("platinum", "プラチナ", ["#ffffff", "#bfe7ee", "#6aa9b6"]),
    ("diamond", "ダイヤモンド", ["#e0f7ff", "#8b5cf6", "#38bdf8"]),
    ("god", "ゴッド", ["#fff7d6", "#ff6ad5", "#3ee8ff"]),
];

/// トロフィー 1 つ。
pub struct Trophy {
    pub id: &'static str,
    pub tier: &'static str,
    pub name: &'static str,
    pub desc: &'static str,
    /// 1 回の記録と、これまでの合計から、取れたか。
    pub test: fn(&ShuttleRecord, &TrophyStore) -> bool,
}

impl std::fmt::Debug for Trophy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.id)
    }
}

fn perfect(r: &ShuttleRecord) -> u32 {
    shuttle::perfect_run(
        &r.levels
            .iter()
            .map(|l| shuttle::LevelMark {
                fail: l.fail,
                miss: if l.miss != 0.0 { 1 } else { 0 },
            })
            .collect::<Vec<_>>(),
    )
}

pub const SHUTTLE_TROPHIES: [Trophy; 19] = [
    Trophy {
        id: "lv5",
        tier: "bronze",
        name: "ウォーミングアップ",
        desc: "レベル5に到達",
        test: |r, _| r.level >= 5.0,
    },
    Trophy {
        id: "shield1",
        tier: "bronze",
        name: "守りの心得",
        desc: "シールドを獲得",
        test: |r, _| r.shields >= 1.0,
    },
    Trophy {
        id: "combo50",
        tier: "bronze",
        name: "リズムに乗って",
        desc: "1回で最大連続50打",
        test: |r, _| r.max_combo >= 50.0,
    },
    Trophy {
        id: "runs10",
        tier: "bronze",
        name: "常連ランナー",
        desc: "合計10回走る",
        test: |_, t| t.runs >= 10.0,
    },
    Trophy {
        id: "lv10",
        tier: "silver",
        name: "本気の走り",
        desc: "レベル10に到達",
        test: |r, _| r.level >= 10.0,
    },
    Trophy {
        id: "save1",
        tier: "silver",
        name: "九死に一生",
        desc: "シールドで時間切れを防ぐ",
        test: |r, _| r.saves >= 1.0,
    },
    Trophy {
        id: "perfect5",
        tier: "silver",
        name: "精密機械",
        desc: "5レベル連続ノーミス",
        test: |r, _| perfect(r) >= 5,
    },
    Trophy {
        id: "runs50",
        tier: "silver",
        name: "鉄の意志",
        desc: "合計50回走る",
        test: |_, t| t.runs >= 50.0,
    },
    Trophy {
        id: "lv18",
        tier: "gold",
        name: "ペースメーカー",
        desc: "レベル18に到達",
        test: |r, _| r.level >= 18.0,
    },
    Trophy {
        id: "combo150",
        tier: "gold",
        name: "止まらない指",
        desc: "1回で最大連続150打",
        test: |r, _| r.max_combo >= 150.0,
    },
    Trophy {
        id: "save3",
        tier: "gold",
        name: "不屈",
        desc: "1回でシールドを3回発動",
        test: |r, _| r.saves >= 3.0,
    },
    Trophy {
        id: "play1h",
        tier: "gold",
        name: "走り込み",
        desc: "合計1時間走る",
        test: |_, t| t.play_sec >= 3600.0,
    },
    Trophy {
        id: "lv25",
        tier: "platinum",
        name: "トップランナー",
        desc: "レベル25に到達",
        test: |r, _| r.level >= 25.0,
    },
    Trophy {
        id: "perfect10",
        tier: "platinum",
        name: "完全無欠",
        desc: "10レベル連続ノーミス",
        test: |r, _| perfect(r) >= 10,
    },
    Trophy {
        id: "acc98",
        tier: "platinum",
        name: "研ぎ澄まされた指先",
        desc: "レベル15以上・正確率98%以上",
        test: |r, _| r.level >= 15.0 && r.accuracy >= 98.0,
    },
    Trophy {
        id: "lv30",
        tier: "diamond",
        name: "限界突破",
        desc: "レベル30に到達",
        test: |r, _| r.level >= 30.0,
    },
    Trophy {
        id: "flawless20",
        tier: "diamond",
        name: "伝説の20",
        desc: "レベル1〜20をすべてノーミス",
        test: |r, _| r.levels.len() >= 20 && r.levels[..20].iter().all(|l| !l.fail && l.miss == 0.0),
    },
    // id は 4.8.0 のまま（条件はレベル 20 以上・99.5% 以上だった）：そのとき取ったトロフィーを残すため
    Trophy {
        id: "acc995",
        tier: "diamond",
        name: "寸分の狂いなし",
        desc: "レベル25以上・正確率98%以上",
        test: |r, _| r.level >= 25.0 && r.accuracy >= 98.0,
    },
    Trophy {
        id: "lv40",
        tier: "god",
        name: "神の手",
        desc: "レベル40に到達",
        test: |r, _| r.level >= 40.0,
    },
];

/// 取ったトロフィー（id → 取った時刻）と、これまでの回数・時間。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TrophyStore {
    pub got: Vec<(String, f64)>,
    pub runs: f64,
    pub play_sec: f64,
}

impl TrophyStore {
    pub fn has(&self, id: &str) -> bool {
        self.got.iter().any(|(g, _)| g == id)
    }

    pub fn to_json(&self) -> Value {
        json!({ "got": Value::Object(self.got.iter().map(|(k, v)| (k.clone(), num(*v))).collect()), "runs": num(self.runs), "playSec": num(self.play_sec) })
    }

    /// 1 回の記録を足す。新しく取ったトロフィーを返す。`now` は記録に時刻がないときに使う。
    pub fn add_run(&mut self, rec: &ShuttleRecord, now: f64) -> Vec<&'static Trophy> {
        self.runs += 1.0;
        self.play_sec += nz(rec.duration_sec, 0.0);
        let mut fresh = Vec::new();
        for t in &SHUTTLE_TROPHIES {
            if self.has(t.id) {
                continue;
            }
            if (t.test)(rec, self) {
                self.got.push((t.id.to_string(), nz(rec.timestamp, now)));
                fresh.push(t);
            }
        }
        fresh
    }

    /// 記録の一覧から作り直す（初めてのとき・壊れていたとき）。
    pub fn from_history(list: &[ShuttleRecord], now: f64) -> TrophyStore {
        let mut s = TrophyStore::default();
        for r in list {
            s.add_run(r, now);
        }
        s
    }

    /// 保存されていたものを読む（旧版（v5）の loadShuttleTrophies）。読めなければ記録の一覧から作り直す。
    pub fn load(raw: Option<&str>, history: &[ShuttleRecord], now: f64) -> TrophyStore {
        let parsed = raw.and_then(|r| serde_json::from_str::<Value>(r).ok());
        let Some(Value::Object(p)) = parsed else {
            return TrophyStore::from_history(history, now);
        };
        let mut s = TrophyStore::default();
        if let Some(got) = p.get("got").filter(|g| g.is_object() || g.is_array()) {
            for t in &SHUTTLE_TROPHIES {
                let ts = number(got.get(t.id));
                if ts.is_finite() && ts > 0.0 {
                    s.got.push((t.id.to_string(), ts));
                }
            }
        }
        s.runs = f64::max(0.0, js::round(nz(number(p.get("runs")), 0.0)));
        s.play_sec = f64::max(0.0, nz(number(p.get("playSec")), 0.0));
        s
    }

    /// 走り終えた 1 回を足す（旧版（v5）の updateShuttleTrophies）。`history` はこの回を含む記録の一覧。
    /// まだ保存がなければ記録の一覧から作り、この回の時刻で取ったものを「新しく取った」とする。
    pub fn update(raw: Option<&str>, history: &[ShuttleRecord], rec: &ShuttleRecord, now: f64) -> (TrophyStore, Vec<&'static Trophy>) {
        let had = matches!(raw.and_then(|r| serde_json::from_str::<Value>(r).ok()), Some(Value::Object(_)));
        if had {
            let mut s = TrophyStore::load(raw, history, now);
            let fresh = s.add_run(rec, now);
            (s, fresh)
        } else {
            let s = TrophyStore::from_history(history, now);
            let fresh = SHUTTLE_TROPHIES
                .iter()
                .filter(|t| s.got.iter().any(|(g, ts)| g == t.id && *ts == rec.timestamp))
                .collect();
            (s, fresh)
        }
    }
}

// ---------- バックアップ ----------

/// バックアップに入れるデータ：このツールのキーのうち、バックアップの管理用（いつ書き出したか・声かけ・圧縮の設定）を除いたもの。
/// `storage` は（キー, 展開した値）。値が読めなかったもの（`None`）も除く。
pub fn collect_app_storage(storage: &[(String, Option<String>)]) -> Vec<(String, String)> {
    storage
        .iter()
        .filter(|(k, _)| {
            ![BACKUP_META_KEY, BACKUP_SNOOZE_KEY, DATA_CHANGED_KEY, COMPRESS_FLAG_KEY].contains(&k.as_str())
                && STORAGE_PREFIXES.iter().any(|p| k.starts_with(p))
        })
        .filter_map(|(k, v)| v.clone().map(|v| (k.clone(), v)))
        .collect()
}

/// バックアップのファイルの中身（JSON の値）。`exported_at` は ISO 8601 の時刻（例 2026-11-10T05:00:00.000Z）。
pub fn build_backup_payload(data: &[(String, String)], exported_at: &str) -> Value {
    let d: Map<String, Value> = data.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
    json!({ "app": BACKUP_APP, "version": 1, "exportedAt": exported_at, "data": d })
}

/// バックアップのファイルの文字（旧版（v5）と同じく 2 字下げ）。
pub fn backup_text(payload: &Value) -> String {
    serde_json::to_string_pretty(payload).expect("JSON にできる")
}

/// バックアップのファイルを読めなかった理由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackupError {
    TooLarge,
    NotJson,
    NotBackup,
    Empty,
}

impl BackupError {
    /// 画面に出す文（旧版（v5）と同じ）。
    pub fn message(&self) -> &'static str {
        match self {
            BackupError::TooLarge => "ファイルが大きすぎます",
            BackupError::NotJson => "JSON として読み取れませんでした",
            BackupError::NotBackup => "このツールのバックアップファイルではありません",
            BackupError::Empty => "復元できるデータが入っていません",
        }
    }
}

/// 読めたバックアップ。
#[derive(Debug, Clone, PartialEq)]
pub struct BackupInfo {
    /// 復元するキーと値（このツールのキーで、値が文字列のもの）。
    pub entries: Vec<(String, String)>,
    /// 書き出した時刻（ミリ秒。わからなければ `None`）。
    pub exported_at: Option<f64>,
    /// 中の過去のスコア・シャトルランの記録の数。
    pub scores: usize,
    pub shuttle: usize,
}

/// バックアップのファイルを確かめる（旧版（v5）の handleBackupFileImport・readBackupFileInfo の確かめる部分）。
/// `size_limit` はバイトの上限（上書き保存のときは 20MB、読み込みのときは `None`）。
pub fn validate_backup(text: &str, size_limit: Option<usize>) -> Result<BackupInfo, BackupError> {
    if size_limit.is_some_and(|max| text.len() > max) {
        return Err(BackupError::TooLarge);
    }
    let payload: Value = serde_json::from_str(text).map_err(|_| BackupError::NotJson)?;
    let data = match (&payload, payload.get("app").and_then(Value::as_str), payload.get("data")) {
        (Value::Object(_), Some(BACKUP_APP), Some(d @ (Value::Object(_) | Value::Array(_)))) => d,
        _ => return Err(BackupError::NotBackup),
    };
    let entries: Vec<(String, String)> = match data {
        Value::Object(o) => {
            let mut v: Vec<(String, String)> = o
                .iter()
                .filter(|(k, _)| STORAGE_PREFIXES.iter().any(|p| k.starts_with(p)))
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect();
            js::object_key_order(&mut v);
            v
        }
        _ => Vec::new(), // 配列の添字はこのツールのキーにならない
    };
    if entries.is_empty() {
        return Err(BackupError::Empty);
    }
    let count = |key: &str| {
        entries
            .iter()
            .find(|(k, _)| k == key)
            .and_then(|(_, v)| serde_json::from_str::<Value>(v).ok())
            .and_then(|v| v.as_array().map(Vec::len))
            .unwrap_or(0)
    };
    let exported_at = payload.get("exportedAt").and_then(Value::as_str).and_then(parse_iso_date);
    Ok(BackupInfo {
        scores: count(SCORE_HISTORY_KEY),
        shuttle: count(SHUTTLE_HISTORY_KEY),
        entries,
        exported_at,
    })
}

/// 復元した後、「いつバックアップしたか」として残す時刻（ファイルを書き出した時刻。未来なら今）。
pub fn backed_up_at(exported_at: Option<f64>, now: f64) -> f64 {
    match exported_at {
        Some(t) if t > 0.0 => t.min(now),
        _ => now,
    }
}

/// ISO 8601 の日時（Date.parse が必ず読む形）をミリ秒に。日付だけなら UTC。時差の書いていない日時は、
/// 旧版（v5）では端末の時刻として読むが、ここでは時差がわからないので `None`。
pub fn parse_iso_date(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let num_at = |from: usize, len: usize| -> Option<i64> {
        let part = s.get(from..from + len)?;
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok())?
    };
    let (year, mut i) = match b.first()? {
        b'+' | b'-' => {
            let y = num_at(1, 6)?;
            if b[0] == b'-' && y == 0 {
                return None;
            }
            (if b[0] == b'-' { -y } else { y }, 7)
        }
        _ => (num_at(0, 4)?, 4),
    };
    let (mut month, mut day) = (1, 1);
    if b.get(i) == Some(&b'-') {
        month = num_at(i + 1, 2)?;
        i += 3;
        if b.get(i) == Some(&b'-') {
            day = num_at(i + 1, 2)?;
            i += 3;
        }
    }
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let (mut h, mut mi, mut sec, mut ms) = (0, 0, 0, 0.0);
    let mut offset_min: i64 = 0;
    if i < b.len() {
        if b[i] != b'T' {
            return None;
        }
        h = num_at(i + 1, 2)?;
        if b.get(i + 3) != Some(&b':') {
            return None;
        }
        mi = num_at(i + 4, 2)?;
        i += 6;
        if b.get(i) == Some(&b':') {
            sec = num_at(i + 1, 2)?;
            i += 3;
            if b.get(i) == Some(&b'.') {
                let start = i + 1;
                let mut j = start;
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
                if j == start {
                    return None;
                }
                ms = format!("0.{}", &s[start..j]).parse::<f64>().ok()? * 1000.0;
                ms = ms.trunc();
                i = j;
            }
        }
        match b.get(i) {
            Some(b'Z') if i + 1 == b.len() => {}
            Some(c @ (b'+' | b'-')) => {
                let oh = num_at(i + 1, 2)?;
                if b.get(i + 3) != Some(&b':') || i + 6 != b.len() {
                    return None;
                }
                let om = num_at(i + 4, 2)?;
                offset_min = (oh * 60 + om) * if *c == b'+' { 1 } else { -1 };
            }
            _ => return None, // 時差がない：端末の時刻として読むものは扱わない
        }
        if h > 24 || mi > 59 || sec > 59 || (h == 24 && (mi > 0 || sec > 0 || ms > 0.0)) {
            return None;
        }
    }
    let days = days_from_civil(year, month, day);
    let t = ((days * 24 + h) * 60 + mi - offset_min) as f64 * 60_000.0 + sec as f64 * 1000.0 + ms;
    (t.abs() <= 8.64e15).then_some(t)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// 1970-01-01 からの日数。
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

// ---------- バックアップの声かけ ----------

/// 最後のバックアップから 20 回、または 1 週間たって 5 回以上か練習文・配列の変更があれば、バックアップを勧める。
pub const BACKUP_REMIND_RUNS: usize = 20;
pub const BACKUP_REMIND_SOME_RUNS: usize = 5;
pub const BACKUP_REMIND_DAYS: f64 = 7.0;
/// 「あとで」は 3 日（または 15 回）待つ。
pub const BACKUP_SNOOZE_DAYS: f64 = 3.0;
pub const BACKUP_SNOOZE_RUNS: f64 = 15.0;
pub const DAY_MS: f64 = 86_400_000.0;

/// 声かけの判断に使うこと。
#[derive(Debug, Clone, PartialEq)]
pub struct ReminderInfo {
    /// 最後にバックアップした時刻（0 ならまだ）。
    pub last: f64,
    /// それより後の記録の数（練習とシャトルラン）。
    pub count: usize,
    /// それより後に練習文・配列を変えたか。
    pub data_changed: bool,
    /// いつから数えるか。
    pub since: f64,
}

/// JS の `parseInt(s || '0', 10) || 0`。
fn parse_int_or_zero(s: Option<&str>) -> f64 {
    let t = s.filter(|x| !x.is_empty()).unwrap_or("0");
    let t = t.trim_start_matches(js::is_space);
    let (neg, d) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let ds: String = d.chars().take_while(char::is_ascii_digit).collect();
    let n: f64 = ds.parse().unwrap_or(0.0);
    if neg { -n } else { n }
}

/// `last_raw` は最後のバックアップの時刻、`changed_raw` は最後に変更した時刻（どちらも保存されていた文字列）。
/// `timestamps` は過去のスコアとシャトルランの記録の時刻。
pub fn reminder_info(last_raw: Option<&str>, changed_raw: Option<&str>, timestamps: &[f64]) -> ReminderInfo {
    let last = parse_int_or_zero(last_raw);
    let fresh: Vec<f64> = timestamps.iter().copied().filter(|t| *t > last).collect();
    let changed = parse_int_or_zero(changed_raw);
    let data_changed = changed > last;
    let mut since = last;
    if since == 0.0 {
        let mut firsts = fresh.clone();
        if data_changed {
            firsts.push(changed);
        }
        since = firsts.iter().copied().fold(f64::INFINITY, f64::min);
        if firsts.is_empty() {
            since = 0.0;
        }
    }
    ReminderInfo {
        last,
        count: fresh.len(),
        data_changed,
        since,
    }
}

/// 今、バックアップを勧めるか。`snooze_raw` は「あとで」の保存（{until, count}）。
pub fn reminder_due(enabled: bool, info: &ReminderInfo, now: f64, snooze_raw: Option<&str>) -> bool {
    if !enabled {
        return false;
    }
    let days = if info.since != 0.0 { (now - info.since) / DAY_MS } else { 0.0 };
    let due =
        info.count >= BACKUP_REMIND_RUNS || ((info.count >= BACKUP_REMIND_SOME_RUNS || info.data_changed) && days >= BACKUP_REMIND_DAYS);
    if !due {
        return false;
    }
    if let Some(Value::Object(s)) = snooze_raw.and_then(|r| serde_json::from_str::<Value>(r).ok()) {
        let until = number(s.get("until"));
        let count = nz(number(s.get("count")), 0.0);
        if now < until && (info.count as f64) < count + BACKUP_SNOOZE_RUNS {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_like_js() {
        for (x, d, want) in [
            (0.25, 1, "0.3"),
            (1.005, 2, "1.00"),
            (99.95, 1, "100.0"),
            (12.0, 1, "12.0"),
            (-0.04, 1, "-0.0"),
            (0.0, 1, "0.0"),
        ] {
            let got = to_fixed(x, d);
            assert_eq!(got, want, "{x}.toFixed({d})");
        }
    }

    #[test]
    fn iso_dates() {
        assert_eq!(parse_iso_date("1970-01-01T00:00:00.000Z"), Some(0.0));
        assert_eq!(parse_iso_date("2026-11-10T05:00:00.123Z"), Some(1_794_286_800_123.0));
        assert_eq!(parse_iso_date("2026-11-10"), Some(1_794_268_800_000.0));
        assert_eq!(parse_iso_date("2026-11-10T14:00:00+09:00"), Some(1_794_286_800_000.0));
        assert_eq!(parse_iso_date("2026-02-30"), None);
        assert_eq!(parse_iso_date("nope"), None);
    }

    #[test]
    fn parse_float_like_js() {
        assert_eq!(parse_float(&json!("12.5px")), 12.5);
        assert_eq!(parse_float(&json!(" -3e2x")), -300.0);
        assert!(parse_float(&json!("x1")).is_nan());
        assert!(parse_float(&json!(true)).is_nan());
        assert_eq!(parse_float(&json!([7, 8])), 7.0);
    }
}
