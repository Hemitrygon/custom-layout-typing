//! キー入力の読み取り（旧版（v5）の「keyboard calibration」「reading a key event」「extra keys」の計算部分を移したもの）。
//!
//! キーの信号（`KeyboardEvent.code`）→ 物理的な位置（追加のキー → キーボード調整の表 → そのままの順）→ その位置の文字。
//! `code` は OS の配列や IME に左右されないので、JIS でも US でも同じ結果になる。

use crate::js;
use crate::layout::{KeyboardType, Layout, SHIFT_CODES, layout_shift_char};
use serde_json::Value;

/// 追加のキーで「Shift として使う」キーの印。
pub const SHIFT_ROLE: &str = "@shift";
/// Shift の記号（! ? など）のために登録した追加のキーの印（'Digit1+Shift'）。
pub const SHIFTED_SUFFIX: &str = "+Shift";
pub const CALIBRATION_STORAGE_KEY: &str = "custom_typing_calibration_v1";
pub const EXTRA_KEYS_STORAGE_KEY: &str = "custom_typing_extra_keys_v1";
/// 調整のときに無視するキー。
pub const CALIB_IGNORED_KEYS: [&str; 9] = ["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab", "Enter", "NumLock", "Fn"];
/// 練習の画面が自分で使うので、追加のキーにできないキー。
pub const EXTRA_BLOCKED_KEYS: [&str; 4] = ["Escape", "Enter", "Tab", "Backspace"];
pub const EXTRA_MODIFIER_KEYS: [&str; 10] = [
    "Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock", "NumLock", "Fn", "Process", "Dead",
];

/// キーの事件（`KeyboardEvent` のうち使うところ）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KeyEvent {
    pub code: String,
    pub key: String,
    pub shift_key: bool,
}

/// 1 打の信号。2 つのキーを区別するのに要るときだけ Shift を付ける（「:」を Shift + 「;」で送るキーボードがある）。
pub fn key_signal_of(e: &KeyEvent, with_shift: bool) -> String {
    let base = if !e.code.is_empty() && e.code != "Unidentified" {
        e.code.clone()
    } else {
        format!("key:{}", e.key.to_lowercase())
    };
    if with_shift && e.shift_key { base + SHIFTED_SUFFIX } else { base }
}

fn is_shifted_target(t: &str) -> bool {
    t.ends_with(SHIFTED_SUFFIX)
}

fn target_code_of(t: &str) -> &str {
    t.strip_suffix(SHIFTED_SUFFIX).unwrap_or(t)
}

// ---------- 保存データ ----------

/// 信号 → 何か、の表（旧版（v5）のオブジェクトと同じ並び）。
pub type SignalMap = Vec<(String, String)>;

fn lookup<'a>(m: &'a SignalMap, sig: &str) -> Option<&'a str> {
    m.iter().find(|(k, _)| k == sig).map(|(_, v)| v.as_str()).filter(|v| !v.is_empty())
}

/// キーボード調整：信号 → 物理的な位置。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Calibration {
    pub map: SignalMap,
    /// Shift と一緒に押したとき、キーボードが送る信号 → 位置。
    pub shift_map: SignalMap,
    pub at: f64,
    pub shift_at: f64,
    /// 位置が変わっている信号の数。
    pub remapped: usize,
    /// 調整で飛ばしたキー。
    pub skipped: Vec<String>,
}

/// JSON のオブジェクトのキーと値（配列なら添字が鍵。旧版（v5）の `Object.keys`）。
fn entries(v: &Value) -> Vec<(String, &Value)> {
    let mut out: Vec<(String, &Value)> = match v {
        Value::Object(o) => o.iter().map(|(k, v)| (k.clone(), v)).collect(),
        Value::Array(a) => a.iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect(),
        _ => Vec::new(),
    };
    js::object_key_order(&mut out);
    out
}

/// 文字を割り当てるキーの位置か（Shift・Space でない、この種類にあるキー）。
fn is_char_slot(kind: KeyboardType, code: &str) -> bool {
    kind.find_slot(code).is_some_and(|s| !s.key.is_modifier)
}

/// 保存したキーボード調整を読む（旧版（v5）の loadCalibration）。使えるものがなければ `None`。
pub fn load_calibration(raw: Option<&str>, kind: KeyboardType) -> Option<Calibration> {
    let parsed: Value = serde_json::from_str(raw?).ok()?;
    let map_v = parsed.get("map").filter(|m| m.is_object() || m.is_array())?;
    let mut map = SignalMap::new();
    for (sig, v) in entries(map_v) {
        if sig == "__proto__" {
            continue; // 旧版（v5）では {} への __proto__ の代入は効かない
        }
        if let Some(code) = v.as_str().filter(|c| is_char_slot(kind, c)) {
            map.push((sig, code.to_string()));
        }
    }
    let mut shift_map = SignalMap::new();
    if let Some(sm) = parsed.get("shiftMap").filter(|m| m.is_object()) {
        for (sig, v) in entries(sm) {
            if js::len16(&sig) > 64 || sig == "__proto__" {
                continue;
            }
            if let Some(code) = v.as_str().filter(|c| is_char_slot(kind, c)) {
                shift_map.push((sig, code.to_string()));
            }
        }
    }
    if map.is_empty() && shift_map.is_empty() {
        return None;
    }
    let remapped = map.iter().filter(|(s, c)| s != c).count();
    let skipped = parsed
        .get("skipped")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .filter(|c| kind.find_slot(c).is_some())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    Some(Calibration {
        map,
        shift_map,
        at: js::or_zero(js::to_number(parsed.get("at"))),
        shift_at: js::or_zero(js::to_number(parsed.get("shiftAt"))),
        remapped,
        skipped,
    })
}

/// 保存した追加のキーを読む（旧版（v5）の loadExtraKeys）。信号 → 位置（'Digit1'・'Digit1+Shift'）か `@shift`。
pub fn load_extra_keys(raw: Option<&str>, kind: KeyboardType) -> SignalMap {
    let mut map = SignalMap::new();
    let Some(parsed) = raw.and_then(|r| serde_json::from_str::<Value>(r).ok()) else {
        return map;
    };
    let Some(m) = parsed.get("map").filter(|m| m.is_object()) else {
        return map;
    };
    for (sig, v) in entries(m) {
        if js::len16(&sig) > 64 || sig == "__proto__" {
            continue;
        }
        match v.as_str() {
            Some(SHIFT_ROLE) => map.push((sig, SHIFT_ROLE.into())),
            Some(t) if is_char_slot(kind, target_code_of(t)) => map.push((sig, t.into())),
            _ => {}
        }
    }
    map
}

// ---------- 読み取り ----------

/// 読み取りに要るもの：配列・キーボードの種類・調整・追加のキー・仮想の Shift を押しているか。
#[derive(Debug, Clone, Copy)]
pub struct KeyContext<'a> {
    pub layout: &'a Layout,
    pub kind: KeyboardType,
    pub calibration: Option<&'a Calibration>,
    pub extra_keys: &'a SignalMap,
    /// Shift として登録したキーを、今押しているか。
    pub virtual_shift_held: bool,
}

/// どこから読んだか。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Extra,
    Calib,
    Std,
}

/// このキーが今すること：位置（または `SHIFT_ROLE`）・読んだところ・信号・Shift の記号のキーか。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reading {
    pub code: String,
    pub via: Via,
    pub sig: String,
    pub shift: bool,
}

impl KeyContext<'_> {
    /// 調整がキーの位置を動かしているか（Shift の表だけでなく）。
    pub fn has_position_calibration(&self) -> bool {
        self.calibration.is_some_and(|c| !c.map.is_empty())
    }

    /// 読み取りの順：追加のキー → 調整の表 → 信号が名前のとおりの標準のキー。
    pub fn current_reading_of(&self, e: &KeyEvent) -> Option<Reading> {
        let s1 = key_signal_of(e, true);
        let s0 = key_signal_of(e, false);
        let extra = |t: &str, sig: &str| Reading {
            code: target_code_of(t).into(),
            via: Via::Extra,
            sig: sig.into(),
            shift: is_shifted_target(t),
        };
        if e.shift_key
            && let Some(t) = lookup(self.extra_keys, &s1)
        {
            return Some(extra(t, &s1));
        }
        if let Some(t) = lookup(self.extra_keys, &s0) {
            return Some(extra(t, &s0));
        }
        if let Some(cal) = self.calibration {
            // Shift の調整：Shift と一緒に押したとき、キーボードが送る信号（別のキーのこともある）
            if let Some(c) = lookup(&cal.shift_map, &s1) {
                return Some(Reading {
                    code: c.into(),
                    via: Via::Calib,
                    sig: s1,
                    shift: true,
                });
            }
            if e.shift_key
                && let Some(c) = lookup(&cal.map, &s1)
            {
                return Some(Reading {
                    code: c.into(),
                    via: Via::Calib,
                    sig: s1,
                    shift: false,
                });
            }
            if let Some(c) = lookup(&cal.map, &s0) {
                return Some(Reading {
                    code: c.into(),
                    via: Via::Calib,
                    sig: s0,
                    shift: false,
                });
            }
        }
        if !e.code.is_empty() && self.kind.find_slot(&e.code).is_some() {
            return Some(Reading {
                code: e.code.clone(),
                via: Via::Std,
                sig: s0,
                shift: false,
            });
        }
        None
    }

    /// キーの物理的な位置（キーボードの図にないキーは `None`）。
    pub fn resolve_physical_code(&self, e: &KeyEvent) -> Option<String> {
        if e.key == "Shift" {
            return Some(if SHIFT_CODES.contains(&e.code.as_str()) {
                e.code.clone()
            } else {
                "ShiftLeft".into()
            });
        }
        let r = self.current_reading_of(e)?;
        Some(if r.code == SHIFT_ROLE { "ShiftLeft".into() } else { r.code })
    }

    /// キーが打つ文字。`code` は物理的な位置（わからないときは `None`）。
    /// Shift を押していれば、コンピューターと同じように Shift の文字にする（1 → !）。`alt_char` は Shift なしの文字で、
    /// そちらだけが正しいときはそれを使う（うっかり Shift を押したままでも、前と同じに判定する）。
    /// 調整したキーボードで、調整したどのキーも送らない信号（40% キーボードのレイヤーの数字など）は、名前のとおりの標準のキーとして読む。
    pub fn resolve_key_event(&self, e: &KeyEvent) -> Option<Resolved> {
        let r = self.current_reading_of(e)?;
        if r.code == SHIFT_ROLE {
            return None;
        }
        let slot = self.kind.find_slot(&r.code)?;
        if slot.key.is_modifier {
            return None;
        }
        let pass_through = r.via == Via::Std && self.has_position_calibration();
        let shift_used = r.sig.ends_with(SHIFTED_SUFFIX);
        let shift_held = r.shift || (e.shift_key && !shift_used) || self.virtual_shift_held;
        let k = self.layout.keys.get(&r.code);
        let base = if pass_through {
            slot.label.to_string()
        } else {
            k.map_or_else(String::new, |k| k.ch.clone())
        };
        if base.is_empty() {
            return None;
        }
        let ch = base.to_uppercase();
        let out = if shift_held {
            if pass_through {
                self.kind.shifted_char(&base)
            } else {
                layout_shift_char(self.kind, k)
            }
            .to_uppercase()
        } else {
            ch.clone()
        };
        // Shift の記号のために登録したキーは、その文字だけを打つ
        let alt = (out != ch && !r.shift).then_some(ch);
        Some(Resolved {
            code: if pass_through { None } else { Some(r.code) },
            ch: out,
            alt_char: alt,
        })
    }

    /// 調整の表が、このキーを文字のキーとして読むか。
    pub fn is_calibrated_char_key(&self, e: &KeyEvent) -> bool {
        self.calibration.is_some() && self.resolve_physical_code(e).is_some_and(|c| is_char_slot(self.kind, &c))
    }
}

/// キーが打つ文字（`KeyContext::resolve_key_event`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub code: Option<String>,
    pub ch: String,
    pub alt_char: Option<String>,
}

/// 調整で、Esc の信号（Shift ありでもなしでも）を文字のキーとして読むようにしているか（それなら Esc で一時停止しない）。
pub fn escape_is_typed_key(cal: Option<&Calibration>, kind: KeyboardType) -> bool {
    cal.is_some_and(|c| {
        c.map.iter().any(|(sig, code)| {
            matches!(sig.as_str(), "Escape" | "key:escape" | "Escape+Shift" | "key:escape+Shift") && is_char_slot(kind, code)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::preset_layout;

    #[test]
    fn plain_qwerty() {
        let l = preset_layout("qwerty", KeyboardType::Jis).unwrap();
        let none = SignalMap::new();
        let ctx = KeyContext {
            layout: &l,
            kind: KeyboardType::Jis,
            calibration: None,
            extra_keys: &none,
            virtual_shift_held: false,
        };
        let e = KeyEvent {
            code: "Digit1".into(),
            key: "!".into(),
            shift_key: true,
        };
        let r = ctx.resolve_key_event(&e).unwrap();
        assert_eq!((r.ch.as_str(), r.alt_char.as_deref()), ("!", Some("1")));
        assert!(
            ctx.resolve_key_event(&KeyEvent {
                code: "Space".into(),
                key: " ".into(),
                shift_key: false
            })
            .is_none()
        );
    }
}
