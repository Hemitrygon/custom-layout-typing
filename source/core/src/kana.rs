//! かな → ローマ字（旧版（v5）の KANA_ROMAJI_MAP・buildKanaChunks・buildWordChunksForPractice などを移したもの）。
//!
//! 練習の 1 単位（チャンク）は「かな 1〜2 文字」と「打ち方の候補（先頭が標準）」の組。
//! 流儀（訓令式 / ヘボン式）は、旧版（v5）では画面の状態から読んでいたが、ここでは必ず引数で受ける。
//!
//! 旧版（v5）との違い：かなの並びを UTF-16 の単位で区切っていたため、絵文字など BMP の外の文字は
//! 2 つのチャンク（どちらも候補なし）になっていた。ここでは 1 文字 1 チャンク（候補なし）にする。

use crate::js;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

// ---------- 流儀 ----------

/// ローマ字の流儀。候補の並び（どれを標準にするか）だけが変わる。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Style {
    /// 訓令式・日本式寄り（SI, TI, TU, HU）。旧版（v5）の既定。
    #[default]
    Nihon,
    /// ヘボン式（SHI, CHI, TSU, FU）。
    Hepburn,
}

impl Style {
    /// 保存データの値（'nihon' / 'hepburn'）から。知らない値は既定（nihon）。
    pub fn parse(s: &str) -> Style {
        if s == "hepburn" { Style::Hepburn } else { Style::Nihon }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Style::Nihon => "nihon",
            Style::Hepburn => "hepburn",
        }
    }
}

// ---------- 表 ----------

/// かな → 打ち方の候補（先頭が標準）。並び順にも意味がある（`fallback_chunks` の候補の順）。
pub const KANA_ROMAJI_MAP: &[(&str, &[&str])] = &[
    ("あ", &["A"]),
    ("い", &["I", "YI"]),
    ("う", &["U", "WU"]),
    ("え", &["E"]),
    ("お", &["O"]),
    ("か", &["KA", "CA"]),
    ("き", &["KI"]),
    ("く", &["KU", "CU", "QU"]),
    ("け", &["KE"]),
    ("こ", &["KO", "CO"]),
    ("さ", &["SA"]),
    ("し", &["SI", "SHI", "CI"]),
    ("す", &["SU"]),
    ("せ", &["SE", "CE"]),
    ("そ", &["SO"]),
    ("た", &["TA"]),
    ("ち", &["TI", "CHI"]),
    ("つ", &["TU", "TSU"]),
    ("て", &["TE"]),
    ("と", &["TO"]),
    ("な", &["NA"]),
    ("に", &["NI"]),
    ("ぬ", &["NU"]),
    ("ね", &["NE"]),
    ("の", &["NO"]),
    ("は", &["HA"]),
    ("ひ", &["HI"]),
    ("ふ", &["HU", "FU"]),
    ("へ", &["HE"]),
    ("ほ", &["HO"]),
    ("ま", &["MA"]),
    ("み", &["MI"]),
    ("む", &["MU"]),
    ("め", &["ME"]),
    ("も", &["MO"]),
    ("や", &["YA"]),
    ("ゆ", &["YU"]),
    ("よ", &["YO"]),
    ("ら", &["RA"]),
    ("り", &["RI"]),
    ("る", &["RU"]),
    ("れ", &["RE"]),
    ("ろ", &["RO"]),
    ("わ", &["WA"]),
    ("を", &["WO", "O"]),
    ("が", &["GA"]),
    ("ぎ", &["GI"]),
    ("ぐ", &["GU"]),
    ("げ", &["GE"]),
    ("ご", &["GO"]),
    ("ざ", &["ZA"]),
    ("じ", &["ZI", "JI"]),
    ("ず", &["ZU"]),
    ("ぜ", &["ZE"]),
    ("ぞ", &["ZO"]),
    ("だ", &["DA"]),
    ("ぢ", &["DI", "JI", "ZI"]),
    ("づ", &["DU", "ZU"]),
    ("で", &["DE"]),
    ("ど", &["DO"]),
    ("ば", &["BA"]),
    ("び", &["BI"]),
    ("ぶ", &["BU"]),
    ("べ", &["BE"]),
    ("ぼ", &["BO"]),
    ("ぱ", &["PA"]),
    ("ぴ", &["PI"]),
    ("ぷ", &["PU"]),
    ("ぺ", &["PE"]),
    ("ぽ", &["PO"]),
    ("きゃ", &["KYA"]),
    ("きゅ", &["KYU"]),
    ("きょ", &["KYO"]),
    ("しゃ", &["SYA", "SHA"]),
    ("しゅ", &["SYU", "SHU"]),
    ("しょ", &["SYO", "SHO"]),
    ("ちゃ", &["TYA", "CHA"]),
    ("ちゅ", &["TYU", "CHU"]),
    ("ちょ", &["TYO", "CHO"]),
    ("ぢゃ", &["DYA", "JA", "ZYA"]),
    ("ぢゅ", &["DYU", "JU", "ZYU"]),
    ("ぢょ", &["DYO", "JO", "ZYO"]),
    ("にゃ", &["NYA"]),
    ("にゅ", &["NYU"]),
    ("にょ", &["NYO"]),
    ("ひゃ", &["HYA"]),
    ("ひゅ", &["HYU"]),
    ("ひょ", &["HYO"]),
    ("みゃ", &["MYA"]),
    ("みゅ", &["MYU"]),
    ("みょ", &["MYO"]),
    ("りゃ", &["RYA"]),
    ("りゅ", &["RYU"]),
    ("りょ", &["RYO"]),
    ("ぎゃ", &["GYA"]),
    ("ぎゅ", &["GYU"]),
    ("ぎょ", &["GYO"]),
    ("じゃ", &["ZYA", "JA", "JYA"]),
    ("じゅ", &["ZYU", "JU", "JYU"]),
    ("じょ", &["ZYO", "JO", "JYO"]),
    ("びゃ", &["BYA"]),
    ("びゅ", &["BYU"]),
    ("びょ", &["BYO"]),
    ("ぴゃ", &["PYA"]),
    ("ぴゅ", &["PYU"]),
    ("ぴょ", &["PYO"]),
    ("ふぁ", &["FA", "HWA"]),
    ("ふぃ", &["FI", "HWI"]),
    ("ふぇ", &["FE", "HWE"]),
    ("ふぉ", &["FO", "HWO"]),
    ("てぃ", &["THI", "TXI"]),
    ("でぃ", &["DHI", "DXI"]),
    ("うぃ", &["WI"]),
    ("うぇ", &["WE"]),
    ("うぉ", &["WHO"]),
    ("しぇ", &["SYE", "SHE"]),
    ("ちぇ", &["TYE", "CHE"]),
    ("じぇ", &["ZYE", "JE", "JYE"]),
    ("てゅ", &["THU"]),
    ("でゅ", &["DHU"]),
    ("とぅ", &["TWU"]),
    ("どぅ", &["DWU"]),
    ("つぁ", &["TSA"]),
    ("つぃ", &["TSI"]),
    ("つぇ", &["TSE"]),
    ("つぉ", &["TSO"]),
    ("くぁ", &["KWA", "QA"]),
    ("ぐぁ", &["GWA"]),
    ("うぁ", &["WHA"]),
    ("ゔ", &["VU"]),
    ("ゔぁ", &["VA"]),
    ("ゔぃ", &["VI"]),
    ("ゔぇ", &["VE"]),
    ("ゔぉ", &["VO"]),
    ("ゐ", &["WYI"]),
    ("ゑ", &["WYE"]),
    ("ゎ", &["XWA", "LWA"]),
    ("ゕ", &["XKA", "LKA"]),
    ("ゖ", &["XKE", "LKE"]),
    ("ぁ", &["XA", "LA"]),
    ("ぃ", &["XI", "LI"]),
    ("ぅ", &["XU", "LU"]),
    ("ぇ", &["XE", "LE"]),
    ("ぉ", &["XO", "LO"]),
    ("ゃ", &["XYA", "LYA"]),
    ("ゅ", &["XYU", "LYU"]),
    ("ょ", &["XYO", "LYO"]),
    ("っ", &["XTU", "LTU", "XTSU"]),
    ("ー", &["-"]),
    ("−", &["-"]),
    ("‐", &["-"]),
    ("、", &[","]),
    ("。", &["."]),
    ("・", &["/"]),
    // 「」はローマ字入力では [ と ] で打つ（『』は「」を変換したもの）
    ("「", &["["]),
    ("」", &["]"]),
    ("『", &["["]),
    ("』", &["]"]),
];

/// 流儀ごとに、標準（先頭）にする打ち方。
const STYLE_PRIMARY_HEPBURN: &[(&str, &str)] = &[
    ("し", "SHI"),
    ("しゃ", "SHA"),
    ("しゅ", "SHU"),
    ("しょ", "SHO"),
    ("じ", "JI"),
    ("じゃ", "JA"),
    ("じゅ", "JU"),
    ("じょ", "JO"),
    ("ち", "CHI"),
    ("ちゃ", "CHA"),
    ("ちゅ", "CHU"),
    ("ちょ", "CHO"),
    ("ぢ", "JI"),
    ("ぢゃ", "JA"),
    ("ぢゅ", "JU"),
    ("ぢょ", "JO"),
    ("つ", "TSU"),
    ("づ", "ZU"),
    ("ふ", "FU"),
    ("を", "O"),
    ("しぇ", "SHE"),
    ("ちぇ", "CHE"),
    ("じぇ", "JE"),
];
const STYLE_PRIMARY_NIHON: &[(&str, &str)] = &[
    ("し", "SI"),
    ("しゃ", "SYA"),
    ("しゅ", "SYU"),
    ("しょ", "SYO"),
    ("じ", "ZI"),
    ("じゃ", "ZYA"),
    ("じゅ", "ZYU"),
    ("じょ", "ZYO"),
    ("ち", "TI"),
    ("ちゃ", "TYA"),
    ("ちゅ", "TYU"),
    ("ちょ", "TYO"),
    ("ぢ", "DI"),
    ("ぢゃ", "DYA"),
    ("ぢゅ", "DYU"),
    ("ぢょ", "DYO"),
    ("つ", "TU"),
    ("づ", "DU"),
    ("ふ", "HU"),
    ("を", "WO"),
];

/// 同じ音の打ち方のまとまり（自分で決めたローマ字を、かなに割り当てるときに使う）。
pub const ROMAJI_EQUIVALENT_GROUPS: &[&[&str]] = &[
    &["SHI", "SI", "CI"],
    &["SHA", "SYA", "SIYA"],
    &["SHU", "SYU", "SIYU"],
    &["SHO", "SYO", "SIYO"],
    &["CHI", "TI"],
    &["CHA", "TYA", "TIYA"],
    &["CHU", "TYU", "TIYU"],
    &["CHO", "TYO", "TIYO"],
    &["TSU", "TU"],
    &["FU", "HU"],
    &["JI", "ZI", "DI"],
    &["JA", "ZYA", "JYA", "DYA"],
    &["JU", "ZYU", "JYU", "DYU"],
    &["JO", "ZYO", "JYO", "DYO"],
    &["ZU", "DU"],
    &["WO", "O"],
    &["KA", "CA"],
    &["KU", "CU", "QU"],
    &["KO", "CO"],
    &["SE", "CE"],
    &["FA", "HWA"],
    &["FI", "HWI"],
    &["FE", "HWE"],
    &["FO", "HWO"],
    &["SHE", "SYE"],
    &["CHE", "TYE"],
    &["JE", "ZYE", "JYE"],
    &["XTU", "LTU", "XTSU", "LTSU"],
    &["XA", "LA"],
    &["XI", "LI"],
    &["XU", "LU"],
    &["XE", "LE"],
    &["XO", "LO"],
    &["XYA", "LYA"],
    &["XYU", "LYU"],
    &["XYO", "LYO"],
    &["NN", "XN", "N"],
];

/// 記号として、そのまま打てる文字（ローマ字入力のときと同じ。！は Shift + 1 など）。
pub const ROMAJI_SYMBOLS: &str = "-,./@;:[]!?^\"#$%&'()=~|`{}+*<>_\\";

fn kana_map() -> &'static HashMap<&'static str, &'static [&'static str]> {
    static MAP: OnceLock<HashMap<&str, &[&str]>> = OnceLock::new();
    MAP.get_or_init(|| KANA_ROMAJI_MAP.iter().copied().collect())
}

fn style_primary(style: Style, token: &str) -> Option<&'static str> {
    let table = match style {
        Style::Hepburn => STYLE_PRIMARY_HEPBURN,
        Style::Nihon => STYLE_PRIMARY_NIHON,
    };
    table.iter().find(|(k, _)| *k == token).map(|(_, v)| *v)
}

/// 打てる文字（英大文字・数字・記号）か。
pub fn is_romaji_char(c: char) -> bool {
    c.is_ascii_uppercase() || c.is_ascii_digit() || ROMAJI_SYMBOLS.contains(c)
}

// ---------- 文字のそろえ方 ----------

/// 全角の英数字（Ａ-Ｚａ-ｚ０-９）を半角に。
fn halfwidth_alnum(c: char) -> char {
    match c {
        'Ａ'..='Ｚ' | 'ａ'..='ｚ' | '０'..='９' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
        _ => c,
    }
}

/// カタカナ → ひらがな、全角英数字 → 半角、全角の空白 → 半角。前後の空白は残す（文の部分を足すと全体になるように）。
pub fn kana_of_text(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\u{30A1}'..='\u{30F6}' => char::from_u32(c as u32 - 0x60).unwrap_or(c),
            '　' => ' ',
            _ => halfwidth_alnum(c),
        })
        .collect()
}

/// よみをそろえる（`kana_of_text` の後、前後の空白を取る）。
pub fn normalize_reading(s: &str) -> String {
    js::trim(&kana_of_text(s)).to_string()
}

/// 自分で決めたローマ字をそろえる：全角 → 半角、大文字に、打てない文字は捨てる。
pub fn normalize_romaji_input(s: &str) -> String {
    let half: String = s.chars().map(halfwidth_alnum).collect();
    half.to_uppercase().chars().filter(|&c| is_romaji_char(c)).collect()
}

/// まだ漢字が残っているか。
pub fn has_unconverted_kanji(s: &str) -> bool {
    s.chars()
        .any(|c| matches!(c, '\u{4E00}'..='\u{9FAF}' | '\u{3400}'..='\u{4DBF}' | '々'))
}

// ---------- チャンク ----------

/// 練習の 1 単位。`options` が空なら、打たずに飛ばす。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub kana: String,
    /// 打ち方の候補（先頭が標準）。すべて大文字。
    pub options: Vec<String>,
}

impl Chunk {
    fn new(kana: impl Into<String>, options: Vec<String>) -> Chunk {
        Chunk {
            kana: kana.into(),
            options,
        }
    }
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// かな 1〜2 文字（または記号 1 文字）の打ち方の候補。表にない記号は、そのまま打てるなら 1 つ、打てなければ空。
pub fn base_options(token: &str, style: Style) -> Vec<String> {
    if let Some(list) = kana_map().get(token) {
        return match style_primary(style, token) {
            Some(p) => std::iter::once(p.to_string())
                .chain(list.iter().filter(|&&x| x != p).map(|s| s.to_string()))
                .collect(),
            None => strings(list),
        };
    }
    let half: String = token
        .chars()
        .map(|c| match c {
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            '〜' => '~',
            '“' | '”' | '„' | '″' => '"',
            '‘' | '’' | '‚' | '′' => '\'',
            _ => c,
        })
        .collect::<String>()
        .to_uppercase();
    if !half.is_empty() && half.chars().all(is_romaji_char) {
        vec![half]
    } else {
        Vec::new()
    }
}

/// よみ（かな）を練習の単位に分ける。2 文字の組（きゃ など）を優先する。
/// 「っ」は次の音の子音を重ねる打ち方と XTU / LTU、「ん」は次の音によって N を 1 つにできるかで候補の順を変える。
pub fn build_kana_chunks(reading: &str, style: Style) -> Vec<Chunk> {
    let kana: Vec<char> = normalize_reading(reading).chars().collect();
    let map = kana_map();
    let mut tokens: Vec<String> = Vec::new();
    let mut i = 0;
    while i < kana.len() {
        if kana[i] == ' ' {
            i += 1;
            continue;
        }
        if i + 1 < kana.len() {
            let two: String = kana[i..i + 2].iter().collect();
            if map.contains_key(two.as_str()) {
                tokens.push(two);
                i += 2;
                continue;
            }
        }
        tokens.push(kana[i].to_string());
        i += 1;
    }

    let mut chunks = Vec::with_capacity(tokens.len());
    for (t, token) in tokens.iter().enumerate() {
        let next_options = || tokens.get(t + 1).map_or_else(Vec::new, |n| base_options(n, style));
        match token.as_str() {
            "っ" => {
                let mut opts: Vec<String> = Vec::new();
                for opt in next_options() {
                    // X / L で始まるのは小さいかな（XA, LTU）：重ねると XTU / LTU と紛らわしいので使わない
                    if let Some(c) = opt.chars().next()
                        && c.is_ascii_uppercase()
                        && !"AIUEONXL".contains(c)
                        && !opts.iter().any(|o| o.len() == 1 && o.starts_with(c))
                    {
                        opts.push(c.to_string());
                    }
                }
                opts.push("XTU".into());
                opts.push("LTU".into());
                chunks.push(Chunk::new("っ", opts));
            }
            "ん" => {
                let next = next_options();
                let (mut single_n, mut before_bmp) = (false, false);
                match next.first().and_then(|o| o.chars().next()) {
                    Some(c) => {
                        single_n = !"AIUEONY".contains(c);
                        before_bmp = "BMP".contains(c);
                    }
                    None => {
                        // 次がない・次の候補がない：N 1 つでよい。候補の最初が空のときは旧版（v5）でも false のまま
                        if next.is_empty() {
                            single_n = true;
                        }
                    }
                }
                let opts: &[&str] = if style == Style::Hepburn && before_bmp {
                    &["M", "N", "NN", "XN"]
                } else if single_n {
                    &["N", "NN", "XN"]
                } else {
                    &["NN", "N", "XN"]
                };
                chunks.push(Chunk::new("ん", strings(opts)));
            }
            _ => chunks.push(Chunk::new(token.clone(), base_options(token, style))),
        }
    }
    chunks
}

/// 同じ音の打ち方（先頭は大文字にした自分自身）。
pub fn romaji_equivalents(token: &str) -> Vec<String> {
    let upper = token.to_uppercase();
    let mut result = vec![upper.clone()];
    for group in ROMAJI_EQUIVALENT_GROUPS {
        if group.contains(&upper.as_str()) {
            for item in group.iter() {
                if !result.iter().any(|r| r == item) {
                    result.push(item.to_string());
                }
            }
        }
    }
    result
}

/// 自分で決めたローマ字（そろえたもの）を、チャンクに割り当てる。割り当てられないときは `None`。
/// 戻り値はチャンクごとの打ち方（候補のないチャンクは空文字）。長い候補から試す。
pub fn segment_custom_romaji(chunks: &[Chunk], custom: &str) -> Option<Vec<String>> {
    struct Seg<'a> {
        chunks: &'a [Chunk],
        custom: &'a str,
        memo: HashMap<(usize, usize), Option<Vec<String>>>,
    }
    impl Seg<'_> {
        fn dfs(&mut self, idx: usize, pos: usize) -> Option<Vec<String>> {
            if idx == self.chunks.len() {
                return if pos == self.custom.len() { Some(Vec::new()) } else { None };
            }
            if let Some(hit) = self.memo.get(&(idx, pos)) {
                return hit.clone();
            }
            let chunk = &self.chunks[idx];
            let res = if chunk.options.is_empty() {
                self.dfs(idx + 1, pos).map(|sub| prepend(String::new(), sub))
            } else {
                let mut cands: Vec<String> = chunk.options.clone();
                for opt in &chunk.options {
                    for eq in romaji_equivalents(opt) {
                        if !cands.contains(&eq) {
                            cands.push(eq);
                        }
                    }
                }
                cands.sort_by_key(|c| std::cmp::Reverse(js::len16(c)));
                let mut found = None;
                for opt in cands {
                    if self.custom.get(pos..).is_some_and(|rest| rest.starts_with(opt.as_str()))
                        && let Some(sub) = self.dfs(idx + 1, pos + opt.len())
                    {
                        found = Some(prepend(opt, sub));
                        break;
                    }
                }
                found
            };
            self.memo.insert((idx, pos), res.clone());
            res
        }
    }
    fn prepend(first: String, mut rest: Vec<String>) -> Vec<String> {
        rest.insert(0, first);
        rest
    }
    Seg {
        chunks,
        custom,
        memo: HashMap::new(),
    }
    .dfs(0, 0)
}

/// すべての打ち方（表の順・同じ音のまとまりの順に重複なく、長い順）。
fn all_romaji_tokens() -> &'static [String] {
    static ALL: OnceLock<Vec<String>> = OnceLock::new();
    ALL.get_or_init(|| {
        let mut all: Vec<String> = Vec::new();
        let groups = KANA_ROMAJI_MAP
            .iter()
            .map(|(_, v)| *v)
            .chain(ROMAJI_EQUIVALENT_GROUPS.iter().copied());
        for list in groups {
            for tok in list {
                if !all.iter().any(|a| a == tok) {
                    all.push(tok.to_string());
                }
            }
        }
        all.sort_by_key(|t| std::cmp::Reverse(t.len()));
        all
    })
}

/// 自分で決めたローマ字が、かなにうまく割り当てられないとき：ローマ字だけから単位を作る。
/// かなは、よみのチャンクと数が合えばそれを、合わなければよみを等分して付ける。
pub fn fallback_chunks(custom: &str, raw_kana: &str, style: Style) -> Vec<Chunk> {
    let cs: Vec<char> = custom.chars().collect();
    let starts_at = |i: usize, tok: &str| tok.chars().enumerate().all(|(k, t)| cs.get(i + k) == Some(&t));
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut i = 0;
    while i < cs.len() {
        let ch = cs[i];
        if cs.get(i + 1) == Some(&ch) && ch.is_ascii_uppercase() && !"AIUEON".contains(ch) {
            chunks.push(Chunk::new("っ", vec![ch.to_string(), "XTU".into(), "LTU".into()]));
            i += 1;
            continue;
        }
        let matched = all_romaji_tokens().iter().find(|tok| starts_at(i, tok)).map(|tok| {
            if tok == "N" && starts_at(i, "NN") {
                "NN".to_string()
            } else {
                tok.clone()
            }
        });
        match matched {
            Some(m) => {
                i += m.chars().count();
                chunks.push(Chunk::new("", romaji_equivalents(&m)));
            }
            None => {
                chunks.push(Chunk::new("", vec![ch.to_string()]));
                i += 1;
            }
        }
    }
    let norm: Vec<char> = normalize_reading(raw_kana).chars().collect();
    if !norm.is_empty() && !chunks.is_empty() {
        let base = build_kana_chunks(&norm.iter().collect::<String>(), style);
        if base.len() == chunks.len() {
            for (c, b) in chunks.iter_mut().zip(base) {
                c.kana = b.kana;
            }
        } else {
            let n = chunks.len();
            for (idx, c) in chunks.iter_mut().enumerate() {
                let (start, end) = (idx * norm.len() / n, (idx + 1) * norm.len() / n);
                c.kana = norm[start..end].iter().collect();
            }
        }
    }
    chunks
}

// ---------- 練習文 1 つ ----------

/// 練習文 1 つ（旧版（v5）の語のオブジェクト）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Word {
    /// 画面に出す文（漢字かな混じり）。
    pub kanji: String,
    /// よみ（かな）。
    pub kana: String,
    /// ローマ字（自分で決めたもの、または標準の打ち方）。
    pub romaji: String,
    /// `romaji` を自分で決めたか。
    pub is_custom_romaji: bool,
}

/// 練習文を練習の単位にする。自分で決めたローマ字があれば、それを第一の候補にする。
pub fn word_chunks(word: &Word, style: Style) -> Vec<Chunk> {
    let kana_chunks = build_kana_chunks(&word.kana, style);
    if word.is_custom_romaji && !word.romaji.is_empty() {
        let clean = normalize_romaji_input(&word.romaji);
        if !clean.is_empty() {
            if let Some(seg) = segment_custom_romaji(&kana_chunks, &clean) {
                return kana_chunks
                    .into_iter()
                    .zip(seg)
                    .map(|(chunk, primary)| {
                        if primary.is_empty() {
                            return Chunk::new(chunk.kana, Vec::new());
                        }
                        let mut combined = vec![primary.clone()];
                        for o in chunk.options.into_iter().chain(romaji_equivalents(&primary)) {
                            if !combined.contains(&o) {
                                combined.push(o);
                            }
                        }
                        Chunk::new(chunk.kana, combined)
                    })
                    .collect();
            }
            return fallback_chunks(&clean, &word.kana, style);
        }
    }
    kana_chunks
}

/// 標準の打ち方をつないだもの（表示用）。
pub fn primary_romaji(kana: &str, style: Style) -> String {
    if kana.is_empty() {
        return String::new();
    }
    build_kana_chunks(kana, style)
        .iter()
        .map(|c| c.options.first().map_or("", String::as_str))
        .collect()
}

/// 練習文のローマ字（自分で決めたものがあればそれ、なければ標準の打ち方）。
pub fn effective_word_romaji(word: &Word, style: Style) -> String {
    if word.is_custom_romaji && !word.romaji.is_empty() {
        return normalize_romaji_input(&word.romaji);
    }
    primary_romaji(&word.kana, style)
}

// ---------- 英語の文 ----------

/// 英語の文をそろえる：全角 → 半角、引用符・ダッシュ・三点リーダーを打てる形に、空白を 1 つに。
pub fn normalize_english_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\u{FF01}'..='\u{FF5E}' => out.push(char::from_u32(c as u32 - 0xFEE0).unwrap_or(c)),
            '‘' | '’' | '‚' | '′' => out.push('\''),
            '“' | '”' | '„' | '″' => out.push('"'),
            '\u{2010}'..='\u{2015}' | '−' => out.push('-'),
            '…' => out.push_str("..."),
            _ => out.push(c),
        }
    }
    let mut collapsed = String::with_capacity(out.len());
    let mut in_space = false;
    for c in out.chars() {
        if js::is_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    js::trim(&collapsed).to_string()
}

/// 英語の文を 1 文字 1 単位にする。空白も打つ。大文字・小文字は区別しない。
/// 今の配列で打てない文字（`typeable` にない）は候補なし（飛ばす）にする。
pub fn english_chunks(text: &str, typeable: &HashSet<char>) -> Vec<Chunk> {
    normalize_english_text(text)
        .chars()
        .map(|ch| {
            let up = ch.to_uppercase().collect::<String>();
            let mut it = up.chars();
            let ok = ch == ' ' || matches!((it.next(), it.next()), (Some(u), None) if typeable.contains(&u));
            Chunk::new(ch.to_string(), if ok { vec![up] } else { Vec::new() })
        })
        .collect()
}

/// 今の配列で打てない文字を含む打ち方を除く（候補がなくなったチャンクは飛ばされる）。
pub fn drop_untypeable_options(chunks: &mut [Chunk], typeable: &HashSet<char>) {
    for chunk in chunks {
        chunk.options.retain(|o| o.chars().all(|c| typeable.contains(&c)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(chunks: &[Chunk]) -> Vec<(String, Vec<String>)> {
        chunks.iter().map(|c| (c.kana.clone(), c.options.clone())).collect()
    }

    #[test]
    fn example_from_the_current_version() {
        // 旧版（v5）で確かめた例：きゃっと → [きゃ:KYA] [っ:T,XTU,LTU] [と:TO]
        let c = build_kana_chunks("きゃっと", Style::Nihon);
        assert_eq!(
            opts(&c),
            vec![
                ("きゃ".into(), vec!["KYA".into()]),
                ("っ".into(), vec!["T".into(), "XTU".into(), "LTU".into()]),
                ("と".into(), vec!["TO".into()])
            ]
        );
    }

    #[test]
    fn n_before_vowel_needs_two() {
        let c = build_kana_chunks("かんい", Style::Nihon);
        assert_eq!(c[1].options[0], "NN");
        let c = build_kana_chunks("さんぽ", Style::Hepburn);
        assert_eq!(c[1].options[0], "M");
    }

    #[test]
    fn styles() {
        assert_eq!(primary_romaji("しち", Style::Nihon), "SITI");
        assert_eq!(primary_romaji("しち", Style::Hepburn), "SHICHI");
    }
}
