//! 旧版（v5）（JavaScript）と答えをそろえるための小さな部品。
//! JS と Rust で決まりが違うもの（丸め・空白の種類・文字の数え方）を、JS の決まりで行う。

/// JS の `Math.round`：いちばん近い整数。ちょうど半分のときは大きい方（-2.5 → -2）。
/// Rust の `f64::round` は 0 から遠い方（-2.5 → -3）なので、そのままでは使えない。
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// JS の正規表現の `\s`（と `String.prototype.trim` が取り除く文字）。
/// Rust の `char::is_whitespace` とは、U+0085 と U+FEFF の扱いが違う。
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// JS の `trim()`。
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// JS の `length`（UTF-16 の単位の数）。かなや漢字は 1、絵文字などは 2 と数える。
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS の `String(数)`：整数なら小数点なし、とても大きい・小さい数は指数の形（1e+21, 1e-7）。
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x == 0.0 {
        return "0".into();
    }
    // いちばん短く元に戻せる桁（Rust と JS で同じ）と、10 の何乗か
    let sci = format!("{:e}", x.abs());
    let (mant, exp) = sci.split_once('e').expect("{:e} の形");
    let digits: String = mant.chars().filter(|c| c.is_ascii_digit()).collect();
    let exp: i32 = exp.parse().expect("指数");
    let k = digits.len() as i32;
    let n = exp + 1; // 小数点の位置（JS の仕様の n）
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e >= 0 { "+" } else { "-" };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    if x < 0.0 { format!("-{body}") } else { body }
}

/// JS の `String(値)`（JSON から読んだ値。ない・null は空文字にする：旧版（v5）の `String(s == null ? '' : s)`）。
pub fn to_js_string(v: Option<&serde_json::Value>) -> String {
    use serde_json::Value;
    fn inner(v: &Value) -> String {
        match v {
            Value::Null => String::new(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
            Value::String(s) => s.clone(),
            // 配列の join：null は空文字になる
            Value::Array(a) => a.iter().map(inner).collect::<Vec<_>>().join(","),
            Value::Object(_) => "[object Object]".into(),
        }
    }
    match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => inner(v),
    }
}

/// `split(/\r?\n/)`：改行（\n か \r\n）で分ける。
pub fn split_lines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find('\n') {
        let line = &rest[..i];
        out.push(line.strip_suffix('\r').unwrap_or(line));
        rest = &rest[i + 1..];
    }
    out.push(rest);
    out
}

/// JS の `Number(値)`（JSON から読んだ値。ないときは NaN）。文字列は前後の空白を除いて 10 進・16 進（0x）・Infinity を読む。
pub fn to_number(v: Option<&serde_json::Value>) -> f64 {
    use serde_json::Value;
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        Some(Value::Array(_)) => string_to_number(&to_js_string(v)),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// JS の `Number(文字列)`。
pub fn string_to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let (neg, body) = match t.strip_prefix('-') {
        Some(b) => (true, b),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let value = if body == "Infinity" {
        f64::INFINITY
    } else if let Some(hex) = body.strip_prefix("0x").or_else(|| body.strip_prefix("0X")) {
        if t.starts_with(['-', '+']) {
            return f64::NAN; // 符号つきの 16 進は読まない
        }
        if hex.is_empty() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return f64::NAN;
        }
        hex.chars().fold(0.0, |acc, c| acc * 16.0 + c.to_digit(16).unwrap() as f64)
    } else {
        let ok = !body.is_empty()
            && body
                .bytes()
                .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
            && body.bytes().next().is_some_and(|b| b.is_ascii_digit() || b == b'.');
        match (ok, body.parse::<f64>()) {
            (true, Ok(x)) => x,
            _ => return f64::NAN,
        }
    };
    if neg { -value } else { value }
}

/// JS の `x || 0`（NaN と 0 は 0）。
pub fn or_zero(x: f64) -> f64 {
    if x.is_nan() { 0.0 } else { x }
}

/// JS のオブジェクトのキーが「配列の添字」（"0"・"12" など。先頭の 0 なし・2³²−1 未満）か。
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|&n| n != u32::MAX)
}

/// JS のオブジェクトのキーの並び（`Object.keys` / `Object.entries`）にする：
/// 配列の添字のキーを先に小さい順、ほかは入れた順。
pub fn object_key_order<T>(entries: &mut [(String, T)]) {
    // 安定な並べ替え：添字のキーは数の順、ほかはすべて同じ扱い（入れた順のまま）
    entries.sort_by_key(|(k, _)| match array_index(k) {
        Some(n) => (0, n),
        None => (1, 0),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_like_js() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(1.4), 1.0);
    }

    #[test]
    fn spaces_like_js() {
        assert!(is_space('\u{3000}'));
        assert!(is_space('\u{FEFF}'));
        assert!(!is_space('\u{85}'));
        assert_eq!(trim("\u{3000} あ \u{FEFF}"), "あ");
        assert_eq!(len16("あ😀"), 3);
    }

    #[test]
    fn object_order() {
        let mut v: Vec<(String, ())> = ["b", "10", "a", "2", "01", "0"].iter().map(|k| (k.to_string(), ())).collect();
        object_key_order(&mut v);
        let keys: Vec<&str> = v.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["0", "2", "10", "b", "a", "01"]);
    }

    #[test]
    fn numbers_like_js() {
        for (x, want) in [
            (1.0, "1"),
            (-0.5, "-0.5"),
            (123.456, "123.456"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (1.5e-10, "1.5e-10"),
            (0.1 + 0.2, "0.30000000000000004"),
        ] {
            assert_eq!(number_to_string(x), want);
        }
    }
}
