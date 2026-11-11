//! 練習文の貼り付け欄の道具（旧版（v5）の「tools for the paste box」から、計算だけを移したもの）：
//! 長い行を読みやすい長さで自動改行する。

use crate::js;

/// 行に、よみの指定（「|」・タブ・行末の（かな））があるか。あれば自動改行しない。
pub fn is_reading_spec_line(line: &str) -> bool {
    if line.contains(['|', '\t']) {
        return true;
    }
    // 行末の「（かな）」：閉じかっこの後は空白だけ、かっこの中はかな・空白が 1 文字以上
    let t = line.trim_end_matches(js::is_space);
    let Some(inner) = t.strip_suffix([')', '）']) else { return false };
    let in_class = |c: char| matches!(c, '\u{3041}'..='\u{309F}' | '\u{30A0}'..='\u{30FF}') || js::is_space(c);
    let kept = inner.trim_end_matches(in_class);
    kept.len() < inner.len() && kept.ends_with(['(', '（'])
}

/// 自動改行のための文字の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CharKind {
    Kanji,
    Hira,
    Kata,
    Alnum,
    Other,
}

pub fn char_kind(c: char) -> CharKind {
    match c {
        '\u{4E00}'..='\u{9FAF}' | '\u{3400}'..='\u{4DBF}' | '々' | '〆' => CharKind::Kanji,
        '\u{3041}'..='\u{3096}' | '\u{309D}' | '\u{309E}' => CharKind::Hira,
        '\u{30A1}'..='\u{30FA}' | '\u{30FC}'..='\u{30FE}' => CharKind::Kata,
        'A'..='Z' | 'a'..='z' | '0'..='9' | 'Ａ'..='Ｚ' | 'ａ'..='ｚ' | '０'..='９' => CharKind::Alnum,
        _ => CharKind::Other,
    }
}

/// 行頭に来てはいけない文字（小さいかな・長音・句読点・閉じかっこなど）。
const NO_LINE_START: &str = "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶー々ゝゞ、。，．,.!！?？」』）)】〕・…‥";
/// 行末に来てはいけない文字（開きかっこ）。
const NO_LINE_END: &str = "「『（(【〔";
/// この後ろは切りやすい（句読点・閉じかっこ）。
const GOOD_LINE_END: &str = "、。，．,.!！?？」』）)】〕";

/// 文字 `a` と `b` の間で改行する悪さ（小さいほど切りやすい。負は自然な切れ目）。
pub fn break_cost(a: char, b: char) -> i32 {
    if NO_LINE_START.contains(b) || NO_LINE_END.contains(a) {
        return 10;
    }
    if GOOD_LINE_END.contains(a) {
        return -2;
    }
    let (ka, kb) = (char_kind(a), char_kind(b));
    if ka == kb && matches!(ka, CharKind::Kanji | CharKind::Kata | CharKind::Alnum) {
        5 // 言葉の途中
    } else if ka == CharKind::Kanji && kb == CharKind::Hira {
        3 // 送りがなの前
    } else if ka == CharKind::Hira && kb != CharKind::Hira {
        -1 // 助詞の後、次の言葉の前
    } else {
        0
    }
}

/// 1 行を、だいたい `size` 文字（空白は数えない）ずつの行に分ける。
/// 半行より多い余りは 1 行にし、少ない余りは前の行から 1 文字ずつ（足りなければ 2 文字ずつ）配る。
/// 言葉の途中で切らないよう、切れ目を 1〜2 文字ずらすことがある。
/// `size` が 0 のときは分けない（旧版（v5）は 0 を渡さない）。
pub fn auto_break_line(line: &str, size: usize) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let pos: Vec<usize> = (0..chars.len()).filter(|&i| !js::is_space(chars[i])).collect();
    let total = pos.len();
    if size == 0 || total <= size {
        return vec![js::trim(line).to_string()];
    }
    let (k, rest) = (total / size, total % size);
    let lengths: Vec<usize> = if rest == 0 {
        vec![size; k]
    } else if rest * 2 > size {
        let mut v = vec![size; k];
        v.push(rest);
        v
    } else {
        (0..k).map(|i| size + rest / k + usize::from(i < rest % k)).collect()
    };
    let reach: i64 = if size <= 6 { 1 } else { 2 };
    let mut shifts = vec![0i64];
    for d in 1..=reach {
        shifts.push(d);
        shifts.push(-d);
    }
    let total = total as i64;
    let mut cuts = Vec::with_capacity(lengths.len());
    let (mut ideal, mut prev) = (0i64, 0i64);
    for len in &lengths[..lengths.len() - 1] {
        ideal += *len as i64;
        let mut best = -1i64;
        let mut best_score = f64::INFINITY;
        for &d in &shifts {
            let c = ideal + d;
            if c - prev < 2 || total - c < 2 {
                continue; // どの行にも 2 文字以上
            }
            let score = break_cost(chars[pos[c as usize - 1]], chars[pos[c as usize]]) as f64 + d.abs() as f64 * 1.5;
            if score < best_score {
                best_score = score;
                best = c;
            }
        }
        if best < 0 {
            best = ideal;
        }
        cuts.push(best as usize);
        prev = best;
    }
    let mut out = Vec::with_capacity(cuts.len() + 1);
    let mut from = 0;
    for c in cuts {
        out.push(js::trim(&chars[from..pos[c]].iter().collect::<String>()).to_string());
        from = pos[c];
    }
    out.push(js::trim(&chars[from..].iter().collect::<String>()).to_string());
    out.retain(|s| !s.is_empty());
    out
}

/// 空白を除いた文字の数（コードポイントで数える）。
pub fn counted_length(s: &str) -> usize {
    s.chars().filter(|&c| !js::is_space(c)).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_spec() {
        assert!(is_reading_spec_line("テスト（てすと）"));
        assert!(is_reading_spec_line("漢字|かんじ"));
        assert!(!is_reading_spec_line("テスト（漢字）"));
        assert!(!is_reading_spec_line("（）"));
    }

    #[test]
    fn short_line_is_kept() {
        assert_eq!(auto_break_line("  みじかい  ", 12), vec!["みじかい"]);
    }
}
