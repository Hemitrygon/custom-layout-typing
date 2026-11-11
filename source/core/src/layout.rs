//! 配列（旧版（v5）の「keyboard type」「Shift」「keymap editor」の計算部分と、配列の分析を移したもの）。
//!
//! キーボードの種類（JIS / US）は、旧版（v5）では画面の状態から読んでいたが、ここでは必ず引数で受ける。

use crate::js;
use crate::kana::{self, Style, Word};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

// ---------- キーボードの種類と物理キー ----------

/// キーボードの種類。記号のキーがいくつか違う（JIS：@ [ : ] ^ ¥ \ / US：` = [ ] \ '）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum KeyboardType {
    #[default]
    Jis,
    Us,
}

impl KeyboardType {
    /// 保存データの値（'jis' / 'us'）から。知らない値は JIS。
    pub fn parse(s: &str) -> KeyboardType {
        if s == "us" { KeyboardType::Us } else { KeyboardType::Jis }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            KeyboardType::Jis => "jis",
            KeyboardType::Us => "us",
        }
    }
}

/// 物理キー 1 つ。
#[derive(Debug, PartialEq, Eq)]
pub struct PhysicalKey {
    /// `KeyboardEvent.code`（KeyA・Digit1・Space など）。
    pub code: &'static str,
    /// JIS キーボードでの刻印。
    pub jis: &'static str,
    /// US キーボードでの刻印（JIS と違うときだけ）。
    pub us: Option<&'static str>,
    /// ふつう使う指（0 左小指 〜 4 左親指、5 右親指 〜 9 右小指）。
    pub default_finger: u8,
    /// 片方の種類にしかないキー。
    pub only: Option<KeyboardType>,
    /// ホームポジションの突起（F・J）。
    pub home_bump: bool,
    /// Shift・Space（文字を割り当てないキー）。
    pub is_modifier: bool,
}

const fn pk(code: &'static str, jis: &'static str, finger: u8) -> PhysicalKey {
    PhysicalKey {
        code,
        jis,
        us: None,
        default_finger: finger,
        only: None,
        home_bump: false,
        is_modifier: false,
    }
}
const fn us(mut k: PhysicalKey, label: &'static str) -> PhysicalKey {
    k.us = Some(label);
    k
}
const fn only(mut k: PhysicalKey, t: KeyboardType) -> PhysicalKey {
    k.only = Some(t);
    k
}
const fn bump(mut k: PhysicalKey) -> PhysicalKey {
    k.home_bump = true;
    k
}
const fn modifier(mut k: PhysicalKey) -> PhysicalKey {
    k.is_modifier = true;
    k
}

use KeyboardType::{Jis, Us};

/// 両方の種類のキー（行ごと。数字段・上段・中段・下段・スペース）。
pub const ALL_PHYSICAL_ROWS: [&[PhysicalKey]; 5] = [
    &[
        only(pk("Backquote", "`", 0), Us),
        pk("Digit1", "1", 0),
        pk("Digit2", "2", 1),
        pk("Digit3", "3", 2),
        pk("Digit4", "4", 3),
        pk("Digit5", "5", 3),
        pk("Digit6", "6", 6),
        pk("Digit7", "7", 6),
        pk("Digit8", "8", 7),
        pk("Digit9", "9", 8),
        pk("Digit0", "0", 9),
        pk("Minus", "-", 9),
        us(pk("Equal", "^", 9), "="),
        only(pk("IntlYen", "¥", 9), Jis),
    ],
    &[
        pk("KeyQ", "Q", 0),
        pk("KeyW", "W", 1),
        pk("KeyE", "E", 2),
        pk("KeyR", "R", 3),
        pk("KeyT", "T", 3),
        pk("KeyY", "Y", 6),
        pk("KeyU", "U", 6),
        pk("KeyI", "I", 7),
        pk("KeyO", "O", 8),
        pk("KeyP", "P", 9),
        us(pk("BracketLeft", "@", 9), "["),
        us(pk("BracketRight", "[", 9), "]"),
        only(pk("Backslash", "\\", 9), Us),
    ],
    &[
        pk("KeyA", "A", 0),
        pk("KeyS", "S", 1),
        pk("KeyD", "D", 2),
        bump(pk("KeyF", "F", 3)),
        pk("KeyG", "G", 3),
        pk("KeyH", "H", 6),
        bump(pk("KeyJ", "J", 6)),
        pk("KeyK", "K", 7),
        pk("KeyL", "L", 8),
        pk("Semicolon", ";", 9),
        us(pk("Quote", ":", 9), "'"),
        // JIS では「:」の右（]）のキーが、US の \ のキーと同じ code を出す
        only(pk("Backslash", "]", 9), Jis),
    ],
    &[
        modifier(pk("ShiftLeft", "shift", 0)),
        pk("KeyZ", "Z", 0),
        pk("KeyX", "X", 1),
        pk("KeyC", "C", 2),
        pk("KeyV", "V", 3),
        pk("KeyB", "B", 3),
        pk("KeyN", "N", 6),
        pk("KeyM", "M", 6),
        pk("Comma", ",", 7),
        pk("Period", ".", 8),
        pk("Slash", "/", 9),
        only(pk("IntlRo", "\\", 9), Jis),
        modifier(pk("ShiftRight", "shift", 9)),
    ],
    &[modifier(pk("Space", "space", 4))],
];

/// Shift・Space。
pub const MODIFIER_CODES: [&str; 3] = ["ShiftLeft", "ShiftRight", "Space"];
pub const SHIFT_CODES: [&str; 2] = ["ShiftLeft", "ShiftRight"];

/// 選んだ種類のキーボードにあるキー（刻印と行の番号つき）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slot {
    pub key: &'static PhysicalKey,
    /// この種類での刻印。
    pub label: &'static str,
    /// 行の番号（0 数字段 〜 4 スペース）。
    pub row: usize,
}

impl KeyboardType {
    /// その種類での刻印。
    pub fn label(self, key: &PhysicalKey) -> &'static str {
        match (self, key.us) {
            (Us, Some(u)) => u,
            _ => key.jis,
        }
    }

    fn slot(self, key: &'static PhysicalKey, row: usize) -> Slot {
        Slot {
            key,
            label: self.label(key),
            row,
        }
    }

    /// この種類にあるキー（行ごと）。旧版（v5）の PHYSICAL_ROWS。
    pub fn rows(self) -> Vec<Vec<Slot>> {
        ALL_PHYSICAL_ROWS
            .iter()
            .enumerate()
            .map(|(r, row)| {
                row.iter()
                    .filter(|k| k.only.is_none_or(|o| o == self))
                    .map(|k| self.slot(k, r))
                    .collect()
            })
            .collect()
    }

    /// code のキー（この種類にあるものだけ）。
    pub fn find_slot(self, code: &str) -> Option<Slot> {
        self.rows().into_iter().flatten().find(|s| s.key.code == code)
    }

    /// code ごとに 1 つ（両方の種類から。同じ code はこの種類のものが勝つ）。どの配列もすべてのキーの文字を持つように。
    pub fn all_key_slots(self) -> Vec<Slot> {
        let mut out: Vec<Slot> = Vec::new();
        for (r, row) in ALL_PHYSICAL_ROWS.iter().enumerate() {
            for k in row.iter() {
                let mine = k.only.is_none_or(|o| o == self);
                match out.iter().position(|s| s.key.code == k.code) {
                    None => out.push(self.slot(k, r)),
                    Some(i) if mine => out[i] = self.slot(k, r),
                    Some(_) => {}
                }
            }
        }
        out
    }

    /// 文字を割り当てるキー（Shift・Space 以外）の code（画面の並び順）。
    pub fn editable_codes(self) -> Vec<&'static str> {
        self.rows()
            .into_iter()
            .flatten()
            .filter(|s| !s.key.is_modifier)
            .map(|s| s.key.code)
            .collect()
    }

    /// Shift と一緒に押したとき、コンピューターが出す文字（OS の設定と同じ）。表にない文字はそのまま。
    pub fn shifted_char(self, ch: &str) -> String {
        let table: &[(&str, &str)] = match self {
            Jis => &[
                ("1", "!"),
                ("2", "\""),
                ("3", "#"),
                ("4", "$"),
                ("5", "%"),
                ("6", "&"),
                ("7", "'"),
                ("8", "("),
                ("9", ")"),
                ("-", "="),
                ("^", "~"),
                ("¥", "|"),
                ("@", "`"),
                ("[", "{"),
                (";", "+"),
                (":", "*"),
                ("]", "}"),
                (",", "<"),
                (".", ">"),
                ("/", "?"),
                ("\\", "_"),
            ],
            Us => &[
                ("`", "~"),
                ("1", "!"),
                ("2", "@"),
                ("3", "#"),
                ("4", "$"),
                ("5", "%"),
                ("6", "^"),
                ("7", "&"),
                ("8", "*"),
                ("9", "("),
                ("0", ")"),
                ("-", "_"),
                ("=", "+"),
                ("[", "{"),
                ("]", "}"),
                ("\\", "|"),
                (";", ":"),
                ("'", "\""),
                (",", "<"),
                (".", ">"),
                ("/", "?"),
            ],
        };
        table
            .iter()
            .find(|(k, _)| *k == ch)
            .map_or_else(|| ch.to_string(), |(_, v)| v.to_string())
    }
}

// ---------- 配列 ----------

/// 1 つのキーに割り当てた文字。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyDef {
    /// 文字（大文字。1 文字）。
    pub ch: String,
    /// Shift と一緒に押したときの文字（ないときはコンピューターが出す文字）。
    pub shift_char: Option<String>,
    /// 指（0〜9）。
    pub finger: u8,
    /// 行（0〜4）。
    pub row: usize,
}

/// 配列。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Layout {
    pub name: String,
    pub description: Option<String>,
    /// code → キーの文字。
    pub keys: BTreeMap<String, KeyDef>,
}

impl Layout {
    /// 保存・比較用の JSON（旧版（v5）の形：{name, description, keys: {code: {char, finger, row, shiftChar}}}）。
    pub fn to_json(&self) -> Value {
        let keys: serde_json::Map<String, Value> = self
            .keys
            .iter()
            .map(|(code, k)| {
                let mut o = serde_json::json!({ "char": k.ch, "finger": k.finger, "row": k.row });
                if let Some(s) = &k.shift_char {
                    o["shiftChar"] = Value::String(s.clone());
                }
                (code.clone(), o)
            })
            .collect();
        let mut o = serde_json::json!({ "name": self.name, "keys": keys });
        if let Some(d) = &self.description {
            o["description"] = Value::String(d.clone());
        }
        o
    }
}

/// Shift と一緒に押したとき、この配列で出る文字（エディタで決めた Shift の文字、なければコンピューターが出す文字）。
pub fn layout_shift_char(kind: KeyboardType, k: Option<&KeyDef>) -> String {
    match k {
        None => String::new(),
        Some(k) => match k.shift_char.as_deref() {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => kind.shifted_char(&k.ch),
        },
    }
}

/// 文字を打つキーと、Shift が要るか。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reach {
    pub code: String,
    pub shift: bool,
}

/// 文字（大文字）→ 打ち方。Shift なしで打てるキーが勝つ。同じ条件なら画面の並びで先のキー。
pub type CharReach = HashMap<String, Reach>;

/// 配列のすべての文字の打ち方。
pub fn char_reach(layout: &Layout, kind: KeyboardType) -> CharReach {
    let codes = kind.editable_codes();
    let mut map = CharReach::new();
    for shift in [false, true] {
        for code in &codes {
            let Some(k) = layout.keys.get(*code) else { continue };
            if k.ch.is_empty() {
                continue;
            }
            let ch = k.ch.to_uppercase();
            let out = if shift {
                layout_shift_char(kind, Some(k)).to_uppercase()
            } else {
                ch.clone()
            };
            if shift && out == ch {
                continue;
            }
            map.entry(out).or_insert_with(|| Reach {
                code: code.to_string(),
                shift,
            });
        }
    }
    map
}

/// 打てる文字（1 文字のものだけ）。
pub fn typeable_chars(reach: &CharReach) -> HashSet<char> {
    reach
        .keys()
        .filter_map(|k| {
            let mut it = k.chars();
            match (it.next(), it.next()) {
                (Some(c), None) => Some(c),
                _ => None,
            }
        })
        .collect()
}

/// その文字の打ち方（打てなければ `None`）。
pub fn find_char_path<'a>(target: &str, reach: &'a CharReach) -> Option<&'a Reach> {
    reach.get(&target.to_uppercase())
}

/// ガイドで光らせる Shift の決め方。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ShiftGuide {
    /// いつも左（既定）。
    #[default]
    Left,
    /// いつも右。
    Right,
    /// キーを押さない方の手。
    Opposite,
}

impl ShiftGuide {
    pub fn parse(s: &str) -> ShiftGuide {
        match s {
            "right" => ShiftGuide::Right,
            "opposite" => ShiftGuide::Opposite,
            _ => ShiftGuide::Left,
        }
    }
}

/// ガイドで光らせる Shift のキー。
pub fn guide_shift_code(finger: u8, guide: ShiftGuide) -> &'static str {
    match guide {
        ShiftGuide::Right => "ShiftRight",
        ShiftGuide::Opposite if finger <= 4 => "ShiftRight",
        _ => "ShiftLeft",
    }
}

/// 配列を作る：すべてのキーに、指定がなければ刻印と、ふつうの指を入れる。
pub fn create_layout_config(name: &str, description: &str, overrides: &[(&str, &str)], kind: KeyboardType) -> Layout {
    let mut keys = BTreeMap::new();
    for slot in kind.all_key_slots() {
        let ch = overrides
            .iter()
            .rev()
            .find(|(c, _)| *c == slot.key.code)
            .map_or(slot.label, |(_, v)| *v);
        keys.insert(
            slot.key.code.to_string(),
            KeyDef {
                ch: ch.to_string(),
                shift_char: None,
                finger: slot.key.default_finger,
                row: slot.row,
            },
        );
    }
    Layout {
        name: name.to_string(),
        description: Some(description.to_string()),
        keys,
    }
}

// ---------- 組み込みの配列 ----------

/// 組み込みの配列の名前（保存のキー）。
pub const BUILTIN_LAYOUT_KEYS: [&str; 4] = ["oonishi", "qwerty", "dvorak", "colemak"];

const OONISHI: &[(&str, &str)] = &[
    ("Digit1", "1"),
    ("Digit2", "2"),
    ("Digit3", "3"),
    ("Digit4", "4"),
    ("Digit5", "5"),
    ("Digit6", "6"),
    ("Digit7", "7"),
    ("Digit8", "8"),
    ("Digit9", "9"),
    ("Digit0", "0"),
    ("Minus", "/"),
    ("KeyQ", "Q"),
    ("KeyW", "L"),
    ("KeyE", "U"),
    ("KeyR", ","),
    ("KeyT", "."),
    ("KeyY", "F"),
    ("KeyU", "W"),
    ("KeyI", "R"),
    ("KeyO", "Y"),
    ("KeyP", "P"),
    ("BracketLeft", "@"),
    ("KeyA", "E"),
    ("KeyS", "I"),
    ("KeyD", "A"),
    ("KeyF", "O"),
    ("KeyG", "-"),
    ("KeyH", "K"),
    ("KeyJ", "T"),
    ("KeyK", "N"),
    ("KeyL", "S"),
    ("Semicolon", "H"),
    ("Quote", ":"),
    ("KeyZ", "Z"),
    ("KeyX", "X"),
    ("KeyC", "C"),
    ("KeyV", "V"),
    ("KeyB", ";"),
    ("KeyN", "G"),
    ("KeyM", "D"),
    ("Comma", "M"),
    ("Period", "J"),
    ("Slash", "B"),
];
const DVORAK: &[(&str, &str)] = &[
    ("KeyQ", ":"),
    ("KeyW", ","),
    ("KeyE", "."),
    ("KeyR", "P"),
    ("KeyT", "Y"),
    ("KeyY", "F"),
    ("KeyU", "G"),
    ("KeyI", "C"),
    ("KeyO", "R"),
    ("KeyP", "L"),
    ("BracketLeft", "/"),
    ("KeyA", "A"),
    ("KeyS", "O"),
    ("KeyD", "E"),
    ("KeyF", "U"),
    ("KeyG", "I"),
    ("KeyH", "D"),
    ("KeyJ", "H"),
    ("KeyK", "T"),
    ("KeyL", "N"),
    ("Semicolon", "S"),
    ("Quote", "-"),
    ("KeyZ", ";"),
    ("KeyX", "Q"),
    ("KeyC", "J"),
    ("KeyV", "K"),
    ("KeyB", "X"),
    ("KeyN", "B"),
    ("KeyM", "M"),
    ("Comma", "W"),
    ("Period", "V"),
    ("Slash", "Z"),
];
const COLEMAK: &[(&str, &str)] = &[
    ("KeyQ", "Q"),
    ("KeyW", "W"),
    ("KeyE", "F"),
    ("KeyR", "P"),
    ("KeyT", "G"),
    ("KeyY", "J"),
    ("KeyU", "L"),
    ("KeyI", "U"),
    ("KeyO", "Y"),
    ("KeyP", ";"),
    ("BracketLeft", "@"),
    ("KeyA", "A"),
    ("KeyS", "R"),
    ("KeyD", "S"),
    ("KeyF", "T"),
    ("KeyG", "D"),
    ("KeyH", "H"),
    ("KeyJ", "N"),
    ("KeyK", "E"),
    ("KeyL", "I"),
    ("Semicolon", "O"),
    ("Quote", "-"),
    ("KeyZ", "Z"),
    ("KeyX", "X"),
    ("KeyC", "C"),
    ("KeyV", "V"),
    ("KeyB", "B"),
    ("KeyN", "K"),
    ("KeyM", "M"),
    ("Comma", ","),
    ("Period", "."),
    ("Slash", "/"),
];
// US キーボードでは、組み込みの配列は JIS の @ と : の代わりに [ と ' を使う
const OONISHI_US: &[(&str, &str)] = &[("BracketLeft", "["), ("Quote", "'")];
const DVORAK_US: &[(&str, &str)] = &[("KeyQ", "'"), ("Minus", "["), ("Equal", "]"), ("BracketRight", "=")];
const COLEMAK_US: &[(&str, &str)] = &[("BracketLeft", "["), ("Quote", "'")];

/// （名前, 説明, QWERTY からの変更, US キーボードでの変更）。
type PresetDef = (
    &'static str,
    &'static str,
    &'static [(&'static str, &'static str)],
    &'static [(&'static str, &'static str)],
);

/// 組み込みの配列（`BUILTIN_LAYOUT_KEYS` の名前で）。知らない名前は `None`。
pub fn preset_layout(key: &str, kind: KeyboardType) -> Option<Layout> {
    let (name, desc, base, us_over): PresetDef = match key {
        "oonishi" => (
            "大西配列",
            "母音と長音「ー」を左手、子音を右手に集約した日本語ローマ字特化配列",
            OONISHI,
            OONISHI_US,
        ),
        "qwerty" => ("QWERTY", "標準QWERTY配列", &[], &[]),
        "dvorak" => ("Dvorak", "母音を左ホーム段に集めた配列", DVORAK, DVORAK_US),
        "colemak" => (
            "Colemak",
            "QWERTYからの移行しやすさとホーム段効率を両立した配列",
            COLEMAK,
            COLEMAK_US,
        ),
        _ => return None,
    };
    let mut overrides: Vec<(&str, &str)> = base.to_vec();
    if kind == Us {
        overrides.extend_from_slice(us_over);
    }
    Some(create_layout_config(name, desc, &overrides, kind))
}

// ---------- 保存データを整える ----------

/// 最初の 1 文字（コードポイント）。大文字にしても 1 文字のときだけ大文字にする（ß は SS にしない）。
pub fn upper_one_char(s: &str) -> String {
    let Some(c) = s.chars().next() else { return String::new() };
    let up: String = c.to_uppercase().collect();
    if up.chars().count() == 1 { up } else { c.to_string() }
}

/// 改行などの制御文字を空白に（名前は .ahk のコメントに入るので、改行があると次の行になってしまう）。
pub fn strip_control_chars(s: &str) -> String {
    s.chars()
        .map(|c| {
            if matches!(c, '\u{0}'..='\u{1F}' | '\u{7F}'..='\u{9F}' | '\u{2028}' | '\u{2029}') {
                ' '
            } else {
                c
            }
        })
        .collect()
}

/// JS の `parseInt(String(v), 10)`。読めなければ `None`。
fn js_parse_int(v: Option<&Value>) -> Option<i64> {
    let s = js::to_js_string(Some(v?));
    let t = s.trim_start_matches(js::is_space);
    let (neg, digits) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let ds: String = digits.chars().take_while(|c| c.is_ascii_digit()).collect();
    if ds.is_empty() {
        return None;
    }
    let n: i64 = ds.chars().take(18).collect::<String>().parse().ok()?;
    Some(if neg { -n } else { n })
}

/// 古い版で保存した配列（JSON）を、今の形に整える（旧版（v5）の ensureLayoutKeys）。
/// 足りないキーを足し、知らないキー・かな配列の名残を捨て、文字を 1 文字の大文字にする。
/// オブジェクトでなければ `None`（旧版（v5）は配列も配列のまま返し、配列としては使えない）。
pub fn ensure_layout_keys(v: &Value, kind: KeyboardType) -> Option<Layout> {
    let obj = match v {
        Value::Object(o) => Some(o),
        _ => return None,
    };
    let empty = serde_json::Map::new();
    let src_keys = obj.and_then(|o| o.get("keys")).and_then(Value::as_object).unwrap_or(&empty);
    let mut keys = BTreeMap::new();
    for slot in kind.all_key_slots() {
        let k = src_keys.get(slot.key.code).and_then(Value::as_object);
        let (ch, finger, shift) = match k {
            None => (
                Some(Value::String(slot.label.into())),
                Some(Value::from(slot.key.default_finger)),
                None,
            ),
            Some(k) => (k.get("char").cloned(), k.get("finger").cloned(), k.get("shiftChar").cloned()),
        };
        let finger = js_parse_int(finger.as_ref())
            .filter(|f| (0..=9).contains(f))
            .map_or(slot.key.default_finger, |f| f as u8);
        let ch_text = match &ch {
            Some(Value::String(_)) | Some(Value::Number(_)) => js::trim(&strip_control_chars(&js::to_js_string(ch.as_ref()))).to_string(),
            _ => String::new(),
        };
        let ch = if slot.key.is_modifier || ch_text.is_empty() {
            slot.label.to_string()
        } else {
            upper_one_char(&ch_text)
        };
        let sh = match &shift {
            Some(Value::String(s)) => upper_one_char(js::trim(&strip_control_chars(s))),
            _ => String::new(),
        };
        let shift_char = if !sh.is_empty() && !slot.key.is_modifier { Some(sh) } else { None };
        keys.insert(
            slot.key.code.to_string(),
            KeyDef {
                ch,
                shift_char,
                finger,
                row: slot.row,
            },
        );
    }
    let name = obj
        .and_then(|o| o.get("name"))
        .and_then(Value::as_str)
        .map(|n| js::trim(&strip_control_chars(n)).to_string())
        .unwrap_or_default();
    let name = if name.is_empty() {
        "読み込んだ配列".to_string()
    } else {
        name
    };
    // 40 文字まで（UTF-16 の単位で数える。サロゲートの対は切らない）
    let mut cut = String::new();
    for c in name.chars() {
        if js::len16(&cut) + c.len_utf16() > 40 {
            break;
        }
        cut.push(c);
    }
    let description = obj.and_then(|o| o.get("description")).and_then(Value::as_str).map(String::from);
    Some(Layout {
        name: cut,
        description,
        keys,
    })
}

// ---------- AutoHotkey ----------

/// .ahk ではスキャンコードで書くキー（JIS と US で刻印が違うもの）。
const AHK_SCANCODE_BY_CODE: &[(&str, &str)] = &[
    ("Backquote", "sc029"),
    ("Equal", "sc00d"),
    ("IntlYen", "sc07d"),
    ("BracketLeft", "sc01a"),
    ("BracketRight", "sc01b"),
    ("Backslash", "sc02b"),
    ("Quote", "sc028"),
    ("IntlRo", "sc073"),
    ("Semicolon", "sc027"), // ; はコメントの始まりになる
];
const AHK_CODE_BY_SCANCODE: &[(&str, &str)] = &[
    ("sc010", "KeyQ"),
    ("sc011", "KeyW"),
    ("sc012", "KeyE"),
    ("sc013", "KeyR"),
    ("sc014", "KeyT"),
    ("sc015", "KeyY"),
    ("sc016", "KeyU"),
    ("sc017", "KeyI"),
    ("sc018", "KeyO"),
    ("sc019", "KeyP"),
    ("sc01a", "BracketLeft"),
    ("sc01e", "KeyA"),
    ("sc01f", "KeyS"),
    ("sc020", "KeyD"),
    ("sc021", "KeyF"),
    ("sc022", "KeyG"),
    ("sc023", "KeyH"),
    ("sc024", "KeyJ"),
    ("sc025", "KeyK"),
    ("sc026", "KeyL"),
    ("sc027", "Semicolon"),
    ("sc028", "Quote"),
    ("sc02c", "KeyZ"),
    ("sc02d", "KeyX"),
    ("sc02e", "KeyC"),
    ("sc02f", "KeyV"),
    ("sc030", "KeyB"),
    ("sc031", "KeyN"),
    ("sc032", "KeyM"),
    ("sc033", "Comma"),
    ("sc034", "Period"),
    ("sc035", "Slash"),
    ("sc029", "Backquote"),
    ("sc00c", "Minus"),
    ("sc00d", "Equal"),
    ("sc07d", "IntlYen"),
    ("sc01b", "BracketRight"),
    ("sc02b", "Backslash"),
    ("sc073", "IntlRo"),
];

fn ahk_from_key(slot: &Slot) -> String {
    AHK_SCANCODE_BY_CODE
        .iter()
        .find(|(c, _)| *c == slot.key.code)
        .map_or_else(|| slot.label.to_lowercase(), |(_, s)| s.to_string())
}

/// 1 文字の、スペース以外の ASCII の表示できる文字か（/^[\x21-\x7e]$/）。
fn is_ahk_char(s: &str) -> bool {
    let mut it = s.chars();
    matches!((it.next(), it.next()), (Some(c), None) if ('\x21'..='\x7e').contains(&c))
}

/// AutoHotkey のリマップのスクリプトを作る。
pub fn generate_ahk_script(layout: &Layout, kind: KeyboardType) -> String {
    let mut lines: Vec<String> = vec![
        "; ============================================================".into(),
        format!("; Custom Keyboard Layout: {}", strip_control_chars(&layout.name)),
        "; Generated by カスタム配列タイピング".into(),
        "; AutoHotkey Remapping Script".into(),
        "; ============================================================".into(),
        "#UseHook".into(),
        String::new(),
    ];
    let rows = kind.rows();
    for slot in rows.iter().flatten() {
        if slot.key.is_modifier {
            continue;
        }
        let from = ahk_from_key(slot);
        let to = layout.keys.get(slot.key.code).map_or(slot.label, |k| k.ch.as_str()).to_lowercase();
        if to == slot.label.to_lowercase() {
            continue;
        }
        if !is_ahk_char(&to) {
            lines.push(format!(
                "; {from} -> {}（AutoHotkey のリマップでは送れない文字のため省略）",
                strip_control_chars(&to)
            ));
            continue;
        }
        // ` は AutoHotkey のエスケープ文字
        lines.push(format!("{from}::{}", if to == "`" { "``" } else { &to }));
    }
    if lines.len() <= 7 {
        lines.push("; (標準QWERTYと同一のためリマップ定義はありません)".into());
    }
    // Shift の文字は Send が要り、AutoHotkey の v1 と v2 で書き方が違う：v2 の行をコメントで出す
    let mut shift_lines = Vec::new();
    for slot in rows.iter().flatten() {
        let Some(k) = layout.keys.get(slot.key.code) else { continue };
        let Some(sc) = k.shift_char.as_deref().filter(|s| !s.is_empty()) else {
            continue;
        };
        if slot.key.is_modifier {
            continue;
        }
        let ch = sc.to_lowercase();
        if !is_ahk_char(&ch) {
            continue;
        }
        shift_lines.push(format!(
            "; +{}::SendText \"{}\"",
            ahk_from_key(slot),
            if ch == "\"" { "\"\"" } else { &ch }
        ));
    }
    if !shift_lines.is_empty() {
        lines.push(String::new());
        lines.push("; ---- Shift と一緒に押したときの文字（AutoHotkey v2 で使うときは、行頭の ; を消してください）----".into());
        lines.extend(shift_lines);
    }
    lines.join("\n")
}

/// AutoHotkey のスクリプトを読む（QWERTY を元に、`a::b` の形のリマップを当てる）。リマップが 1 つもなければエラー。
pub fn parse_ahk_script(text: &str, kind: KeyboardType) -> Result<Layout, String> {
    let mut base = preset_layout("qwerty", kind).expect("qwerty はある");
    base.name = "AHK Imported".into();
    let mut qwerty_to_code: HashMap<String, &str> = HashMap::new();
    for slot in kind.rows().iter().flatten() {
        if !slot.key.is_modifier {
            qwerty_to_code.insert(slot.label.to_lowercase(), slot.key.code);
        }
    }
    let mut remaps = 0;
    for raw in js::split_lines(text) {
        let line = js::trim(cut_ahk_comment(raw));
        if line.is_empty() || line.starts_with(';') {
            continue;
        }
        let Some((src, dst)) = match_ahk_remap(line) else { continue };
        let src = src.trim_start_matches(['$', '*', '~']).to_lowercase();
        let dst = dst.to_uppercase();
        let target = AHK_CODE_BY_SCANCODE
            .iter()
            .find(|(s, _)| *s == src)
            .map(|(_, c)| *c)
            .or_else(|| qwerty_to_code.get(&src).copied());
        if let Some(code) = target
            && js::len16(&dst) == 1
            && let Some(k) = base.keys.get_mut(code)
        {
            k.ch = dst;
            remaps += 1;
        }
    }
    if remaps == 0 {
        return Err("有効なAHKリマップ定義 (例: d::a) が見つかりませんでした".into());
    }
    Ok(base)
}

/// 行のコメント（空白の後の ; と、// の後）を除く（`split(/\s+;|\s*\/\//)[0]`）。
fn cut_ahk_comment(line: &str) -> &str {
    let mut prev_space = false;
    for (i, c) in line.char_indices() {
        if (c == ';' && prev_space) || line[i..].starts_with("//") {
            return &line[..i];
        }
        prev_space = js::is_space(c);
    }
    line
}

/// `/^([^*~+#!^\s]+)::([^\s]+)$/`：（元のキー, 先の文字）。
fn match_ahk_remap(line: &str) -> Option<(&str, &str)> {
    if line.chars().any(js::is_space) {
        return None;
    }
    // 前半はできるだけ長く：いちばん右の :: から試す（重なる ::: も 1 つずつ）
    let positions: Vec<usize> = line
        .char_indices()
        .map(|(i, _)| i)
        .filter(|&i| line[i..].starts_with("::"))
        .collect();
    positions.into_iter().rev().find_map(|p| {
        let (src, dst) = (&line[..p], &line[p + 2..]);
        (!src.is_empty() && !dst.is_empty() && !src.contains(['*', '~', '+', '#', '!', '^'])).then_some((src, dst))
    })
}

// ---------- 配列の点検（エディタ） ----------

/// ローマ字入力に要る文字（A〜Z・ー・、。）。
pub const ROMAJI_REQUIRED_CHARS: [&str; 29] = [
    "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "-",
    ",", ".",
];

/// 文字（大文字）→ その文字があるキー（画面の並び順）。
/// 文字の並びは旧版（v5）のオブジェクトと同じ（数字の文字を先に小さい順、ほかは初めて出た順）。
pub fn char_usage(layout: &Layout, kind: KeyboardType) -> Vec<(String, Vec<String>)> {
    let mut usage: Vec<(String, Vec<String>)> = Vec::new();
    for code in kind.editable_codes() {
        let Some(k) = layout.keys.get(code) else { continue };
        let ch = k.ch.to_uppercase();
        if ch.is_empty() {
            continue;
        }
        match usage.iter_mut().find(|(c, _)| *c == ch) {
            Some((_, codes)) => codes.push(code.to_string()),
            None => usage.push((ch, vec![code.to_string()])),
        }
    }
    js::object_key_order(&mut usage);
    usage
}

/// 配列の点検の結果：ない文字と、2 つ以上のキーにある文字。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutHealth {
    pub missing: Vec<String>,
    pub duplicates: Vec<(String, Vec<String>)>,
}

pub fn layout_health(layout: &Layout, kind: KeyboardType) -> LayoutHealth {
    let reach = char_reach(layout, kind);
    let missing = ROMAJI_REQUIRED_CHARS
        .iter()
        .filter(|c| !reach.contains_key(**c))
        .map(|c| c.to_string())
        .collect();
    let duplicates = char_usage(layout, kind).into_iter().filter(|(_, codes)| codes.len() > 1).collect();
    LayoutHealth { missing, duplicates }
}

/// 2 つのキーの文字を入れ替える（`shift_layer` なら Shift の文字を）。どちらかのキーがなければ何もせず `false`。
pub fn swap_keys(layout: &mut Layout, a: &str, b: &str, shift_layer: bool) -> bool {
    if !layout.keys.contains_key(a) || !layout.keys.contains_key(b) {
        return false;
    }
    if shift_layer {
        let va = layout.keys[a].shift_char.clone();
        let vb = layout.keys[b].shift_char.clone();
        layout.keys.get_mut(a).unwrap().shift_char = vb;
        layout.keys.get_mut(b).unwrap().shift_char = va;
    } else {
        let va = layout.keys[a].ch.clone();
        let vb = layout.keys[b].ch.clone();
        layout.keys.get_mut(a).unwrap().ch = vb;
        layout.keys.get_mut(b).unwrap().ch = va;
    }
    true
}

/// キーに文字を割り当てた結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Assign {
    /// 割り当てられない（キーがない・Shift / Space・文字が空）。
    Rejected,
    /// もう同じだったので変えていない。
    Unchanged,
    /// 変えた。`swapped_with` は、入れ替えで元の文字を受け取ったキー。
    Changed { old: String, swapped_with: Option<String> },
}

/// キーに文字を割り当てる（エディタ）。`shift_layer` なら Shift の文字を。
/// `swap_on_assign` なら、その文字を持っていた別のキーに、このキーの元の文字を渡す（入れ替え）。
pub fn assign_char(layout: &mut Layout, code: &str, ch: &str, shift_layer: bool, swap_on_assign: bool, kind: KeyboardType) -> Assign {
    let Some(slot) = kind.find_slot(code) else {
        return Assign::Rejected;
    };
    let clean: String = ch.to_uppercase().chars().take(1).collect();
    if slot.key.is_modifier || !layout.keys.contains_key(code) || clean.is_empty() {
        return Assign::Rejected;
    }
    let key = &layout.keys[code];
    if shift_layer {
        if layout_shift_char(kind, Some(key)).to_uppercase() != clean || key.shift_char.as_deref().is_none_or(str::is_empty) {
            let old = key.shift_char.clone().unwrap_or_default();
            layout.keys.get_mut(code).unwrap().shift_char = Some(clean);
            return Assign::Changed { old, swapped_with: None };
        }
        return Assign::Unchanged;
    }
    if key.ch == clean {
        return Assign::Unchanged;
    }
    let old = key.ch.clone();
    let mut swapped_with = None;
    if swap_on_assign
        && let Some((_, holders)) = char_usage(layout, kind).into_iter().find(|(c, _)| *c == clean)
        && let Some(h) = holders.into_iter().find(|c| c != code)
    {
        layout.keys.get_mut(&h).unwrap().ch = old.clone();
        swapped_with = Some(h);
    }
    layout.keys.get_mut(code).unwrap().ch = clean;
    Assign::Changed { old, swapped_with }
}

// ---------- 配列の分析（打鍵の偏り） ----------

/// 打鍵の集計（配列の分析）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Telemetry {
    pub total_hits: u64,
    /// 行ごとの打鍵数（0 数字段 〜 3 下段、4 スペース）。
    pub row_hits: [u64; 5],
    pub left_hand_hits: u64,
    pub right_hand_hits: u64,
    /// 続けて打った 2 打の組の数。
    pub pairs: u64,
    /// そのうち左右の手が入れ替わったもの。
    pub alternation_count: u64,
    /// 同じ指で別のキー。
    pub same_finger_count: u64,
    /// 同じキーの連打。
    pub same_key_count: u64,
    /// 配列で打てなかった文字と回数（旧版（v5）のオブジェクトと同じ並び：数字の文字を先に、ほかは出てきた順）。
    pub skipped_chars: Vec<(String, u64)>,
    prev: Option<(bool, u8, String)>,
}

impl Telemetry {
    /// 続きを切る（次の打鍵を組に数えない）。
    pub fn break_sequence(&mut self) {
        self.prev = None;
    }

    /// 1 打を数える。配列にないキー・Shift / Space は数えず、続きを切る。
    pub fn add_keystroke(&mut self, code: &str, layout: &Layout, kind: KeyboardType) {
        let Some(info) = layout.keys.get(code).filter(|_| !MODIFIER_CODES.contains(&code)) else {
            self.prev = None;
            return;
        };
        self.total_hits += 1;
        let row = kind.find_slot(code).map_or(info.row, |s| s.row);
        if let Some(r) = self.row_hits.get_mut(row) {
            *r += 1;
        }
        let finger = info.finger;
        let left = finger <= 4;
        if left {
            self.left_hand_hits += 1;
        } else {
            self.right_hand_hits += 1;
        }
        if let Some((pl, pf, pc)) = &self.prev {
            self.pairs += 1;
            if *pl != left {
                self.alternation_count += 1;
            } else if *pf == finger {
                if pc == code {
                    self.same_key_count += 1;
                } else {
                    self.same_finger_count += 1;
                }
            }
        }
        self.prev = Some((left, finger, code.to_string()));
    }

    fn skip(&mut self, ch: String) {
        match self.skipped_chars.iter_mut().find(|(c, _)| *c == ch) {
            Some((_, n)) => *n += 1,
            None => {
                self.skipped_chars.push((ch, 1));
                js::object_key_order(&mut self.skipped_chars);
            }
        }
        self.prev = None;
    }
}

/// 理論値：登録した練習文を、すべてガイドどおり（標準の打ち方）に打ったときの集計。文ごとに続きを切る。
pub fn theoretical_telemetry(layout: &Layout, words: &[Word], style: Style, english: bool, kind: KeyboardType) -> Telemetry {
    let mut t = Telemetry::default();
    let reach = char_reach(layout, kind);
    for w in words {
        t.prev = None;
        let romaji = if english {
            kana::normalize_english_text(&w.kanji).to_uppercase()
        } else {
            kana::effective_word_romaji(w, style)
        };
        for ch in romaji.chars() {
            if ch == ' ' {
                // スペース（親指）は語の区切り：続きを切る
                t.prev = None;
                continue;
            }
            match find_char_path(&ch.to_string(), &reach) {
                Some(path) => {
                    let code = path.code.clone();
                    t.add_keystroke(&code, layout, kind);
                }
                None => t.skip(ch.to_string()),
            }
        }
    }
    t.prev = None;
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyboard_types() {
        assert_eq!(Jis.find_slot("BracketLeft").unwrap().label, "@");
        assert_eq!(Us.find_slot("BracketLeft").unwrap().label, "[");
        assert!(Jis.find_slot("Backquote").is_none());
        assert_eq!(Jis.find_slot("Backslash").unwrap().label, "]");
        assert_eq!(Jis.shifted_char("2"), "\"");
        assert_eq!(Us.shifted_char("2"), "@");
    }

    #[test]
    fn qwerty_reach() {
        let q = preset_layout("qwerty", Jis).unwrap();
        let reach = char_reach(&q, Jis);
        assert_eq!(
            find_char_path("a", &reach),
            Some(&Reach {
                code: "KeyA".into(),
                shift: false
            })
        );
        assert_eq!(
            find_char_path("!", &reach),
            Some(&Reach {
                code: "Digit1".into(),
                shift: true
            })
        );
    }

    #[test]
    fn ahk_remap_match() {
        assert_eq!(match_ahk_remap("a::b"), Some(("a", "b")));
        assert_eq!(match_ahk_remap("a:::b"), Some(("a:", "b")));
        assert_eq!(match_ahk_remap("a::+::b"), Some(("a", "+::b")));
        assert_eq!(match_ahk_remap("+a::b"), None);
        assert_eq!(match_ahk_remap("a::"), None);
        assert_eq!(cut_ahk_comment("a::b ; note"), "a::b ");
        assert_eq!(cut_ahk_comment("a::b;x"), "a::b;x");
    }
}
