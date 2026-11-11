//! 保存データの圧縮（旧版（v5）の lzCompress16 / lzDecompress16 / decodeStored / encodeForStorage を移したもの）。
//! lz-string と同じやり方で、1 文字に 15 ビットずつ詰めた UTF-16 の文字列にする。
//! 旧版（v5）が保存したデータを読めるよう、出力は 1 ビットも変えない。

use std::collections::{HashMap, HashSet};

/// 圧縮した値の頭に付ける印。
pub const LZ_MARK: &str = "\u{2}lz1\u{2}";
/// 圧縮してよいキー（大きくなりやすいものだけ）。
pub const COMPRESSIBLE_KEYS: [&str; 4] = [
    "custom_typing_word_presets_v2",
    "custom_typing_word_groups_v1",
    "custom_typing_score_history_v1",
    "custom_typing_shuttle_history_v1",
];
/// これより短い値は圧縮しない。
pub const COMPRESS_MIN_LENGTH: usize = 2048;

const BITS_PER_CHAR: u32 = 15;

/// 展開できなかった理由。旧版（v5）は理由を区別せず、`Truncated` は `''`、ほかは `null` を返していた。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LzError {
    /// 途中で切れている。
    Truncated,
    /// 中身が壊れている。
    Invalid,
    /// 展開できたが、文字列として正しくない（対になっていないサロゲート）。
    BadText,
}

// ---------- 圧縮 ----------

struct BitWriter {
    val: u32,
    pos: u32,
    out: Vec<u16>,
}

impl BitWriter {
    fn write(&mut self, mut value: u32, n: u32) {
        for _ in 0..n {
            self.val = (self.val << 1) | (value & 1);
            if self.pos == BITS_PER_CHAR - 1 {
                self.pos = 0;
                self.out.push((self.val + 32) as u16);
                self.val = 0;
            } else {
                self.pos += 1;
            }
            value >>= 1;
        }
    }
}

/// 文字列を圧縮する。空の文字列は空のまま。結果の最後には空白が 1 つ付く（旧版（v5）と同じ）。
pub fn compress16(input: &str) -> String {
    let units: Vec<u16> = input.encode_utf16().collect();
    if units.is_empty() {
        return String::new();
    }
    let mut dict: HashMap<Vec<u16>, u32> = HashMap::new();
    let mut created: HashSet<u16> = HashSet::new(); // 辞書に入れたが、まだ書き出していない 1 文字
    let mut w: Vec<u16> = Vec::new();
    let mut enlarge_in: u64 = 2;
    let mut dict_size: u32 = 3;
    let mut num_bits: u32 = 2;
    let mut bw = BitWriter {
        val: 0,
        pos: 0,
        out: Vec::new(),
    };

    let mut emit_w = |w: &[u16], dict: &HashMap<Vec<u16>, u32>, created: &mut HashSet<u16>, bw: &mut BitWriter| {
        if w.len() == 1 && created.contains(&w[0]) {
            let code = w[0] as u32;
            if code < 256 {
                bw.write(0, num_bits);
                bw.write(code, 8);
            } else {
                bw.write(1, num_bits);
                bw.write(code, 16);
            }
            enlarge_in -= 1;
            if enlarge_in == 0 {
                enlarge_in = 1 << num_bits;
                num_bits += 1;
            }
            created.remove(&w[0]);
        } else {
            bw.write(dict[w], num_bits);
        }
        enlarge_in -= 1;
        if enlarge_in == 0 {
            enlarge_in = 1 << num_bits;
            num_bits += 1;
        }
    };

    for &c in &units {
        if !dict.contains_key(&[c][..]) {
            dict.insert(vec![c], dict_size);
            dict_size += 1;
            created.insert(c);
        }
        let mut wc = w.clone();
        wc.push(c);
        if dict.contains_key(&wc) {
            w = wc;
        } else {
            emit_w(&w, &dict, &mut created, &mut bw);
            dict.insert(wc, dict_size);
            dict_size += 1;
            w = vec![c];
        }
    }
    if !w.is_empty() {
        emit_w(&w, &dict, &mut created, &mut bw);
    }
    bw.write(2, num_bits);
    // 最後の文字を書き出す
    loop {
        bw.val <<= 1;
        if bw.pos == BITS_PER_CHAR - 1 {
            bw.out.push((bw.val + 32) as u16);
            break;
        }
        bw.pos += 1;
    }
    // 出力の文字は 32〜32799 なので、サロゲートは含まれない
    let mut s = String::from_utf16(&bw.out).expect("圧縮の出力は正しい UTF-16");
    s.push(' ');
    s
}

// ---------- 展開 ----------

struct BitReader<'a> {
    units: &'a [u16],
    val: i32,
    position: i32,
    /// 次に読む文字の位置
    index: usize,
}

impl BitReader<'_> {
    const RESET: i32 = 16384;

    /// 範囲の外は 0 として読む（JS では NaN になり、ビット演算で 0 になる）
    fn get(&self, i: usize) -> i32 {
        self.units.get(i).map_or(0, |&u| u as i32 - 32)
    }

    fn read(&mut self, n: u32) -> u32 {
        let mut bits = 0u32;
        for i in 0..n {
            let resb = self.val & self.position;
            self.position >>= 1;
            if self.position == 0 {
                self.position = Self::RESET;
                self.val = self.get(self.index);
                self.index += 1;
            }
            if resb != 0 {
                bits |= 1 << i;
            }
        }
        bits
    }
}

/// 圧縮した文字列を元に戻す。
pub fn decompress16(compressed: &str) -> Result<String, LzError> {
    let units: Vec<u16> = compressed.encode_utf16().collect();
    if units.is_empty() {
        return Ok(String::new());
    }
    let mut br = BitReader {
        units: &units,
        val: 0,
        position: BitReader::RESET,
        index: 1,
    };
    br.val = br.get(0);

    // 0〜2 は合図用の番号で、辞書の中身は使わない
    let mut dict: Vec<Vec<u16>> = vec![Vec::new(), Vec::new(), Vec::new()];
    let mut enlarge_in: u64 = 4;
    let mut num_bits: u32 = 3;
    let first: Vec<u16> = match br.read(2) {
        0 => vec![br.read(8) as u16],
        1 => vec![br.read(16) as u16],
        2 => return Ok(String::new()),
        _ => return Err(LzError::Invalid),
    };
    dict.push(first.clone());
    let mut w = first.clone();
    let mut result = first;
    loop {
        if br.index > units.len() {
            return Err(LzError::Truncated);
        }
        let mut code = br.read(num_bits) as usize;
        match code {
            0 | 1 => {
                let unit = br.read(if code == 0 { 8 } else { 16 }) as u16;
                dict.push(vec![unit]);
                code = dict.len() - 1;
                enlarge_in -= 1;
            }
            2 => return String::from_utf16(&result).map_err(|_| LzError::BadText),
            _ => {}
        }
        if enlarge_in == 0 {
            enlarge_in = 1 << num_bits;
            num_bits += 1;
        }
        let entry: Vec<u16> = if code < dict.len() {
            dict[code].clone()
        } else if code == dict.len() {
            let mut e = w.clone();
            e.push(w[0]);
            e
        } else {
            return Err(LzError::Invalid);
        };
        result.extend_from_slice(&entry);
        let mut next = w;
        next.push(entry[0]);
        dict.push(next);
        enlarge_in -= 1;
        w = entry;
        if enlarge_in == 0 {
            enlarge_in = 1 << num_bits;
            num_bits += 1;
        }
    }
}

// ---------- 保存する値 ----------

/// 保存されていた値を読める形にする（印がなければそのまま）。
/// 5.4.3 までは圧縮を 2 回かけることがあったので、4 回まで展開する。
/// 戻り値は旧版（v5）と同じ：途中で切れていたものは空の文字列、壊れていたもの・展開しきれないものは `None`。
pub fn decode_stored(raw: &str) -> Option<String> {
    if !raw.starts_with(LZ_MARK) {
        return Some(raw.to_string());
    }
    let mut plain = raw.to_string();
    for _ in 0..4 {
        if !plain.starts_with(LZ_MARK) {
            break;
        }
        plain = match decompress16(&plain[LZ_MARK.len()..]) {
            Ok(s) => s,
            Err(LzError::Truncated) => String::new(),
            Err(_) => return None,
        };
    }
    if plain.starts_with(LZ_MARK) { None } else { Some(plain) }
}

/// 保存する形にする：圧縮が ON（`enabled`）で、圧縮してよいキーで、長くて、1 割以上小さくなり、
/// 元に戻せることを確かめられたときだけ、印を付けて圧縮する。それ以外はそのまま。
pub fn encode_for_storage(enabled: bool, key: &str, value: &str) -> String {
    let len = crate::js::len16(value);
    if value.starts_with(LZ_MARK) || len < COMPRESS_MIN_LENGTH || !COMPRESSIBLE_KEYS.contains(&key) || !enabled {
        return value.to_string();
    }
    let packed = compress16(value);
    let packed_len = crate::js::len16(&packed) + crate::js::len16(LZ_MARK);
    if (packed_len as f64) < len as f64 * 0.9 && decompress16(&packed).as_deref() == Ok(value) {
        return format!("{LZ_MARK}{packed}");
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        for s in ["", "a", "abababab", "あいうえおあいうえお", "😀🎉😀"] {
            assert_eq!(decompress16(&compress16(s)).as_deref(), Ok(s));
        }
    }

    #[test]
    fn mark_is_five_units() {
        assert_eq!(crate::js::len16(LZ_MARK), 5);
        assert_eq!(LZ_MARK.len(), 5);
    }
}
