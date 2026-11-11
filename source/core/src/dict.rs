//! 漢字のよみの辞書（旧版（v5）の「the user's dictionary」と、よみを組み立てる部分を移したもの）。
//!
//! よみは「ユーザー辞書 → 内蔵の辞書 → kuromoji（形態素解析）」の順に決める。
//! kuromoji そのものは JS に残し、その結果（`Token` の並び）を受け取って組み立てる部分だけをここに置く。

use crate::js;
use crate::kana::{self, Style, Word};
use std::collections::HashMap;
use std::sync::OnceLock;

/// ユーザー辞書の上限：語の数・語の長さ・よみの長さ（UTF-16 の単位）。
pub const USER_DICT_MAX: usize = 2000;
pub const USER_DICT_WORD_MAX: usize = 32;
pub const USER_DICT_READING_MAX: usize = 64;
/// 最初から入っている語（消すと「消した」ことを覚えておく）。
pub const USER_DICT_DEFAULTS: &[(&str, &str)] = &[("憚る", "はばかる")];
/// 保存のキー。
pub const USER_DICT_STORAGE_KEY: &str = "custom_typing_user_dict_v1";

/// 内蔵の辞書。
pub const BUILTIN_KANJI_READING_DICT: &[(&str, &str)] = &[
    ("今日のお天気", "きょうのおてんき"),
    ("新しい練習文", "あたらしいれんしゅうぶん"),
    ("お疲れ様です", "おつかれさまです"),
    ("お世話になっております", "おせわになっております"),
    ("よろしくお願いいたします", "よろしくおねがいいたします"),
    ("よろしくお願いします", "よろしくおねがいします"),
    ("ありがとうございます", "ありがとうございます"),
    ("ご確認のほど", "ごかくにんのほど"),
    ("毎日の積み重ね", "まいにちのつみかさね"),
    ("日本語入力", "にほんごにゅうりょく"),
    ("大西配列", "おおにしはいれつ"),
    ("親指シフト", "おやゆびしふと"),
    ("タイピング練習", "たいぴんぐれんしゅう"),
    ("漢字", "かんじ"),
    ("文章", "ぶんしょう"),
    ("練習", "れんしゅう"),
    ("設定", "せってい"),
    ("変更", "へんこう"),
    ("保存", "ほぞん"),
    ("削除", "さくじょ"),
    ("追加", "ついか"),
    ("編集", "へんしゅう"),
    ("今日", "きょう"),
    ("明日", "あした"),
    ("昨日", "きのう"),
    ("毎日", "まいにち"),
    ("時間", "じかん"),
    ("電話", "でんわ"),
    ("会議", "かいぎ"),
    ("資料", "しりょう"),
    ("連絡", "れんらく"),
    ("確認", "かくにん"),
    ("問題", "もんだい"),
    ("解決", "かいけつ"),
    ("自分", "じぶん"),
    ("言葉", "ことば"),
    ("気持ち", "きもち"),
    ("天気", "てんき"),
    ("食事", "しょくじ"),
    ("仕事", "しごと"),
    ("勉強", "べんきょう"),
    ("音楽", "おんがく"),
    ("映画", "えいが"),
    ("旅行", "りょこう"),
    ("散歩", "さんぽ"),
    ("大切", "たいせつ"),
    ("必要", "ひつよう"),
    ("簡単", "かんたん"),
    ("複雑", "ふくざつ"),
    ("高速", "こうそく"),
    ("快適", "かいてき"),
    ("自然", "しぜん"),
    ("指先", "ゆびさき"),
    ("打鍵", "だけん"),
    ("配列", "はいれつ"),
    ("効率", "こうりつ"),
    ("速度", "そくど"),
    ("正確", "せいかく"),
    ("入力", "にゅうりょく"),
    ("変換", "へんかん"),
    ("画面", "がめん"),
];

// ---------- 辞書の索引 ----------

/// 先頭の文字 → その文字で始まる語（長い順）。ある位置で始まるいちばん長い語が勝つように。
#[derive(Debug, Clone, Default)]
pub struct DictIndex {
    by_first: HashMap<char, Vec<(String, String)>>,
}

impl DictIndex {
    pub fn new<'a>(entries: impl IntoIterator<Item = (&'a str, &'a str)>) -> DictIndex {
        let mut by_first: HashMap<char, Vec<(String, String)>> = HashMap::new();
        for (word, reading) in entries {
            if let Some(c) = word.chars().next() {
                by_first.entry(c).or_default().push((word.to_string(), reading.to_string()));
            }
        }
        for list in by_first.values_mut() {
            list.sort_by_key(|(w, _)| std::cmp::Reverse(js::len16(w)));
        }
        DictIndex { by_first }
    }

    pub fn is_empty(&self) -> bool {
        self.by_first.is_empty()
    }
}

fn builtin_index() -> &'static DictIndex {
    static INDEX: OnceLock<DictIndex> = OnceLock::new();
    INDEX.get_or_init(|| DictIndex::new(BUILTIN_KANJI_READING_DICT.iter().copied()))
}

/// 辞書の語と、その間の文に分けたもの。`reading` は辞書のよみ（語の間は `None`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Part {
    pub text: String,
    pub reading: Option<String>,
}

/// 文を、辞書の語とその間の文に分ける。
pub fn split_by_dict(s: &str, index: &DictIndex) -> Vec<Part> {
    let mut out = Vec::new();
    let mut gap = String::new();
    let mut rest = s;
    while let Some(c) = rest.chars().next() {
        let hit = if index.is_empty() {
            None
        } else {
            index
                .by_first
                .get(&c)
                .and_then(|l| l.iter().find(|(w, _)| rest.starts_with(w.as_str())))
        };
        match hit {
            Some((w, r)) => {
                if !gap.is_empty() {
                    out.push(Part {
                        text: std::mem::take(&mut gap),
                        reading: None,
                    });
                }
                out.push(Part {
                    text: w.clone(),
                    reading: Some(r.clone()),
                });
                rest = &rest[w.len()..];
            }
            None => {
                gap.push(c);
                rest = &rest[c.len_utf8()..];
            }
        }
    }
    if !gap.is_empty() {
        out.push(Part { text: gap, reading: None });
    }
    out
}

// ---------- よみの区切り ----------

/// 文の一部と、そのよみ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    /// 文の一部（表記）。
    pub text: String,
    /// よみ。
    pub reading: String,
    /// ユーザー辞書から取ったよみか。
    pub user: bool,
    /// 活用した語の基本形（登録の候補を出すため）。
    pub base: Option<String>,
}

impl Segment {
    fn new(text: impl Into<String>, reading: impl Into<String>, user: bool) -> Segment {
        Segment {
            text: text.into(),
            reading: reading.into(),
            user,
            base: None,
        }
    }
}

/// 区切りのよみをつないだもの。
pub fn reading_of_segments(segs: &[Segment]) -> String {
    kana::normalize_reading(&segs.iter().map(|s| s.reading.as_str()).collect::<String>())
}

/// 形態素解析（kuromoji）の 1 語。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Token {
    pub surface_form: String,
    /// 基本形（活用していなければ表記と同じ。わからなければ `*` か `None`）。
    pub basic_form: Option<String>,
    /// よみ（カタカナ。わからなければ `*` か `None`）。
    pub reading: Option<String>,
}

/// 送りがなの違いだけの 2 つの形（辞書形と文中の形）から、共通の漢字の部分の後ろのかなを取り出す（憚る / 憚ら → る / ら）。
/// 送りがな以外も違うときは `None`。
pub fn okurigana_tails(base: &str, surface: &str) -> Option<(String, String)> {
    let n = base.chars().zip(surface.chars()).take_while(|(a, b)| a == b).count();
    let base_head: String = base.chars().take(n).collect();
    if n == 0 || !kana::has_unconverted_kanji(&base_head) {
        return None;
    }
    let base_tail = kana::kana_of_text(&base.chars().skip(n).collect::<String>());
    let surf_tail = kana::kana_of_text(&surface.chars().skip(n).collect::<String>());
    if kana::has_unconverted_kanji(&base_tail) || kana::has_unconverted_kanji(&surf_tail) {
        return None;
    }
    Some((base_tail, surf_tail))
}

// ---------- ユーザー辞書 ----------

/// ユーザー辞書（変換をまちがえた語と、ユーザーが登録したよみ）。内蔵の辞書と kuromoji より先に使う。
#[derive(Debug, Clone, Default)]
pub struct UserDict {
    /// [語, よみ] の並び（新しいものが先）。
    pub entries: Vec<(String, String)>,
    /// 最初から入っている語のうち、もう出したもの（消しても戻さないため）。
    pub defaults_offered: Vec<String>,
    index: DictIndex,
    map: HashMap<String, String>,
    /// 送りがなのある語の漢字の部分 → 送りがなを除いたよみ（憚る / はばかる：憚 → はばか）。
    stems: HashMap<String, String>,
}

impl UserDict {
    /// 語の並びから辞書を作る（旧版（v5）の setUserDictEntries）。
    pub fn new(entries: Vec<(String, String)>) -> UserDict {
        let index = DictIndex::new(entries.iter().map(|(w, r)| (w.as_str(), r.as_str())));
        let mut map = HashMap::new();
        let mut stems = HashMap::new();
        for (word, reading) in &entries {
            map.insert(word.clone(), reading.clone());
            if let Some((stem, tail)) = split_okurigana(word)
                && js::len16(reading) > js::len16(tail)
                && reading.ends_with(tail)
                && !stems.contains_key(stem)
            {
                stems.insert(stem.to_string(), reading[..reading.len() - tail.len()].to_string());
            }
        }
        UserDict {
            entries,
            defaults_offered: Vec::new(),
            index,
            map,
            stems,
        }
    }

    /// 保存データ（JSON）から読む（旧版（v5）の loadUserDict）。読めない値は飛ばし、
    /// まだ出していない最初からの語を最後に足す。`raw` が `None`（保存がない）でもよい。
    pub fn load(raw: Option<&str>) -> UserDict {
        let mut entries: Vec<(String, String)> = Vec::new();
        let mut offered: Vec<String> = Vec::new();
        let parsed: serde_json::Value = raw.and_then(|r| serde_json::from_str(r).ok()).unwrap_or(serde_json::Value::Null);
        if let Some(list) = parsed.get("entries").and_then(|v| v.as_array()) {
            let mut seen = std::collections::HashSet::new();
            for e in list {
                let Some(pair) = e.as_array() else { continue };
                if entries.len() >= USER_DICT_MAX {
                    continue;
                }
                let word = clean_word(&js::to_js_string(pair.first()));
                let reading = clean_reading(&js::to_js_string(pair.get(1)));
                if word.is_empty() || reading.is_empty() || seen.contains(&word) {
                    continue;
                }
                seen.insert(word.clone());
                entries.push((word, reading));
            }
        }
        if let Some(list) = parsed.get("defaults").and_then(|v| v.as_array()) {
            for w in list {
                if let Some(w) = w.as_str()
                    && USER_DICT_DEFAULTS.iter().any(|(d, _)| *d == w)
                {
                    offered.push(w.to_string());
                }
            }
        }
        for (word, reading) in USER_DICT_DEFAULTS {
            if offered.iter().any(|o| o == word) {
                continue;
            }
            offered.push(word.to_string());
            if entries.len() < USER_DICT_MAX && !entries.iter().any(|(w, _)| w == word) {
                entries.push((word.to_string(), reading.to_string()));
            }
        }
        let mut dict = UserDict::new(entries);
        dict.defaults_offered = offered;
        dict
    }

    /// 文を区切ってよみを付ける：ユーザー辞書 → 内蔵の辞書。どちらにもない部分は、そのままの文字（漢字は漢字のまま）。
    pub fn segments(&self, s: &str) -> Vec<Segment> {
        let mut segs = Vec::new();
        for part in split_by_dict(s, &self.index) {
            match part.reading {
                Some(r) => segs.push(Segment::new(part.text, r, true)),
                None => {
                    for p in split_by_dict(&part.text, builtin_index()) {
                        let r = kana::kana_of_text(p.reading.as_deref().unwrap_or(&p.text));
                        segs.push(Segment::new(p.text, r, false));
                    }
                }
            }
        }
        segs
    }

    /// 2 つの辞書でよみにする（知らない漢字は残る）。
    pub fn apply(&self, s: &str) -> String {
        if s.is_empty() {
            String::new()
        } else {
            reading_of_segments(&self.segments(s))
        }
    }

    /// 文にユーザー辞書の語が入っているか。
    pub fn has_word_in(&self, s: &str) -> bool {
        !self.index.is_empty() && !s.is_empty() && split_by_dict(s, &self.index).iter().any(|p| p.reading.is_some())
    }

    /// 登録された語のよみ。
    pub fn reading_of(&self, word: &str) -> Option<&str> {
        self.map.get(word).map(String::as_str)
    }

    /// 登録された語が活用した形（憚る を登録して、文中は 憚ら・憚っ）：登録したよみに、この形の送りがなを付ける。
    pub fn conjugated_reading(&self, token: &Token) -> Option<String> {
        let base = token.basic_form.as_deref().unwrap_or("");
        let surface = token.surface_form.as_str();
        if self.map.is_empty() || base.is_empty() || base == "*" || base == surface {
            return None;
        }
        let reading = self.reading_of(base)?;
        let (base_tail, surf_tail) = okurigana_tails(base, surface)?;
        let stem = reading.strip_suffix(base_tail.as_str())?;
        Some(format!("{stem}{surf_tail}"))
    }

    /// ユーザー辞書の語はそのよみ、それ以外は形態素解析（`tokenize`。旧版（v5）では kuromoji）にかけて、文を区切ってよみを付ける。
    pub fn tokenize_with(&self, sentence: &str, mut tokenize: impl FnMut(&str) -> Vec<Token>) -> Vec<Segment> {
        let mut segs = Vec::new();
        for part in split_by_dict(sentence, &self.index) {
            if let Some(r) = part.reading {
                segs.push(Segment::new(part.text, r, true));
                continue;
            }
            let tokens = tokenize(&part.text);
            for (ti, token) in tokens.iter().enumerate() {
                let surface = token.surface_form.as_str();
                let conjugated = if kana::has_unconverted_kanji(surface) {
                    self.conjugated_reading(token)
                } else {
                    None
                };
                if let Some(r) = conjugated {
                    segs.push(Segment {
                        text: surface.into(),
                        reading: r,
                        user: true,
                        base: token.basic_form.clone(),
                    });
                    continue;
                }
                // kuromoji が読めない漢字（憚 は辞書にない）：送りがなのある登録語の漢字の部分の後にかなが続けば、その語の活用とみる
                let next = tokens.get(ti + 1).map_or("", |t| t.surface_form.as_str());
                let unknown = token.reading.as_deref().is_none_or(|r| r.is_empty() || r == "*");
                if unknown
                    && let Some(stem) = self.stems.get(surface)
                    && next.chars().next().is_some_and(|c| matches!(c, '\u{3041}'..='\u{3096}'))
                {
                    segs.push(Segment::new(surface, stem.clone(), true));
                    continue;
                }
                let reading = if !kana::has_unconverted_kanji(surface) {
                    kana::normalize_reading(surface)
                } else if !unknown {
                    kana::normalize_reading(token.reading.as_deref().unwrap_or(""))
                } else {
                    self.apply(surface)
                };
                let mut seg = Segment::new(surface, reading, false);
                if let Some(b) = token.basic_form.as_deref()
                    && !b.is_empty()
                    && b != "*"
                    && b != surface
                {
                    seg.base = Some(b.to_string());
                }
                segs.push(seg);
            }
        }
        segs
    }

    /// 貼り付けた 1 行を練習文にする（旧版（v5）の parsePastedLine）。空の行は `None`。
    /// 「文|よみ|ローマ字」「文<タブ>よみ」「文（よみ）」の形ならそのよみ、それ以外は辞書でよみを付ける。
    pub fn parse_pasted_line(&self, line: &str, style: Style) -> Option<PastedLine> {
        let trimmed = js::trim(line);
        if trimmed.is_empty() {
            return None;
        }
        let pieces: Vec<&str> = trimmed.split(['|', '\t']).collect();
        if pieces.len() >= 2 {
            let display = js::trim(pieces[0]).to_string();
            let reading = kana::normalize_reading(js::trim(pieces[1]));
            let custom = pieces
                .get(2)
                .filter(|p| !p.is_empty())
                .map_or_else(String::new, |p| kana::normalize_romaji_input(js::trim(p)));
            let kana_text = if reading.is_empty() { display.clone() } else { reading.clone() };
            let romaji = if custom.is_empty() {
                kana::primary_romaji(&kana_text, style)
            } else {
                custom.clone()
            };
            let reading_given = !reading.is_empty() && !kana::has_unconverted_kanji(&reading);
            let word = Word {
                kanji: display,
                kana: kana_text,
                romaji,
                is_custom_romaji: !custom.is_empty(),
            };
            return Some(PastedLine {
                word,
                reading_given,
                auto_segments: None,
            });
        }
        if let Some((display, inner)) = split_paren_reading(trimmed) {
            let display = js::trim(display).to_string();
            let reading = kana::normalize_reading(js::trim(inner));
            let kana_text = if reading.is_empty() { display.clone() } else { reading.clone() };
            let romaji = kana::primary_romaji(&kana_text, style);
            let reading_given = !reading.is_empty() && !kana::has_unconverted_kanji(&reading);
            let word = Word {
                kanji: display,
                kana: kana_text,
                romaji,
                is_custom_romaji: false,
            };
            return Some(PastedLine {
                word,
                reading_given,
                auto_segments: None,
            });
        }
        let segs = self.segments(trimmed);
        let normalized = reading_of_segments(&segs);
        let romaji = kana::primary_romaji(&normalized, style);
        let word = Word {
            kanji: trimmed.to_string(),
            kana: normalized,
            romaji,
            is_custom_romaji: false,
        };
        Some(PastedLine {
            word,
            reading_given: false,
            auto_segments: Some(segs),
        })
    }
}

impl UserDict {
    /// 貼り付け欄の文を、行ごとに練習文にする（旧版（v5）の parseMultiLineText）。空の行は飛ばす。
    /// 英語の練習文（`english`）は、そろえた文をそのまま使う。
    pub fn parse_multi_line(&self, raw: &str, english: bool, style: Style) -> Vec<PastedLine> {
        if raw.is_empty() {
            return Vec::new();
        }
        js::split_lines(raw)
            .into_iter()
            .filter_map(|line| {
                if english {
                    let text = kana::normalize_english_text(line);
                    (!text.is_empty()).then(|| PastedLine {
                        word: Word {
                            kanji: text,
                            kana: String::new(),
                            romaji: String::new(),
                            is_custom_romaji: false,
                        },
                        reading_given: false,
                        auto_segments: None,
                    })
                } else {
                    self.parse_pasted_line(line, style)
                }
            })
            .collect()
    }
}

/// 貼り付けた 1 行の結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PastedLine {
    pub word: Word,
    /// よみが行に書いてあった（漢字の変換をかけない）。
    pub reading_given: bool,
    /// 辞書で付けたよみの区切り（あとでユーザーが直したところを見るため）。
    pub auto_segments: Option<Vec<Segment>>,
}

/// 正規表現 `.`（改行以外）にあたるか。
fn is_js_dot(c: char) -> bool {
    !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// 「文（よみ）」の形なら（文, よみ）。旧版（v5）の `/^(.+?)[（(]([^）)]+)[）)]$/` と同じ。
fn split_paren_reading(s: &str) -> Option<(&str, &str)> {
    let inner_end = s.strip_suffix([')', '）'])?;
    for (i, c) in s.char_indices() {
        if i == 0 {
            if !is_js_dot(c) {
                return None;
            }
            continue;
        }
        if c == '(' || c == '（' {
            let inner_start = i + c.len_utf8();
            if inner_start < inner_end.len() {
                let inner = &s[inner_start..inner_end.len()];
                if !inner.contains([')', '）']) {
                    return Some((&s[..i], inner));
                }
            }
        }
        if !is_js_dot(c) {
            return None; // ここより先を前半に含められない
        }
    }
    None
}

/// 語を、漢字で終わる前半と、最後のひらがなの並びに分ける（旧版（v5）の `/^(.*[漢字])([ぁ-ゖ]+)$/`）。
fn split_okurigana(word: &str) -> Option<(&str, &str)> {
    let tail_start = word
        .char_indices()
        .rev()
        .take_while(|(_, c)| matches!(c, '\u{3041}'..='\u{3096}'))
        .last()
        .map(|(i, _)| i)?;
    let (head, tail) = word.split_at(tail_start);
    let last = head.chars().last()?;
    let is_kanji = matches!(last, '\u{4E00}'..='\u{9FAF}' | '\u{3400}'..='\u{4DBF}' | '々');
    if is_kanji && head.chars().all(is_js_dot) {
        Some((head, tail))
    } else {
        None
    }
}

/// 登録する語をそろえる（空・長すぎ・タブや | を含むものは空文字）。
pub fn clean_word(s: &str) -> String {
    let w = js::trim(s);
    if w.is_empty() || js::len16(w) > USER_DICT_WORD_MAX || w.contains(['\t', '\r', '\n', '|']) {
        return String::new();
    }
    w.to_string()
}

/// 登録するよみをそろえる：打てるもの（かな・よみ欄で使える英字や記号）だけ。漢字が残る・打てない文字があるときは空文字。
pub fn clean_reading(s: &str) -> String {
    let r: String = kana::normalize_reading(s).chars().filter(|&c| !js::is_space(c)).collect();
    if r.is_empty() || js::len16(&r) > USER_DICT_READING_MAX || kana::has_unconverted_kanji(&r) {
        return String::new();
    }
    // 流儀は候補の並びだけを変えるので、打てるかどうかの判断には関係ない
    if !kana::build_kana_chunks(&r, Style::Nihon).iter().all(|c| !c.options.is_empty()) {
        return String::new();
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn longest_word_wins() {
        let d = UserDict::new(vec![]);
        let segs = d.segments("今日のお天気と今日");
        assert_eq!(segs[0].text, "今日のお天気");
        assert_eq!(reading_of_segments(&segs), "きょうのおてんきときょう");
    }

    #[test]
    fn conjugated_user_word() {
        let d = UserDict::load(None);
        let t = Token {
            surface_form: "憚ら".into(),
            basic_form: Some("憚る".into()),
            reading: None,
        };
        assert_eq!(d.conjugated_reading(&t).as_deref(), Some("はばから"));
    }

    #[test]
    fn paren_reading() {
        assert_eq!(split_paren_reading("漢字(かんじ)"), Some(("漢字", "かんじ")));
        assert_eq!(split_paren_reading("（あ）（い）"), Some(("（あ）", "い")));
        assert_eq!(split_paren_reading("()"), None);
    }
}
