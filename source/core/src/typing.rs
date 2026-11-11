//! 打鍵の判定（旧版（v5）の processCharacterInput・advanceToNextChunk・loadCurrentWord などの判定部分を移したもの）。
//!
//! 1 回の練習（練習文の並び）を `Session` として持ち、1 文字ずつ `input` で進める。
//! 旧版（v5）では画面の更新と混ざっていたが、ここでは結果（`Outcome`）を返すだけにし、画面・音・シャトルランは呼ぶ側に任せる。

use crate::js;
use crate::kana::{self, Chunk, Style, Word};
use crate::layout::{self, KeyboardType, Layout, Telemetry};
use std::collections::HashSet;

/// 練習文の言語。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lang {
    #[default]
    Ja,
    En,
}

/// 練習の 1 単位と、その打ち具合。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkState {
    pub kana: String,
    /// 打ち方の候補。打っている途中の候補が先頭に来るよう並べ替わる。
    pub options: Vec<String>,
    /// ここまで打った文字。
    pub typed: String,
    /// 打てない（候補がない）ので飛ばした。
    pub skipped: bool,
}

impl From<Chunk> for ChunkState {
    fn from(c: Chunk) -> Self {
        ChunkState {
            kana: c.kana,
            options: c.options,
            typed: String::new(),
            skipped: false,
        }
    }
}

/// 1 文字を打った結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// 練習中ではない（終わった後）。
    NotTyping,
    /// 文末の「ん」を NN と打った 2 つ目の N が、次の文の頭に来た：N で始まれない文なので受け流した。
    Swallowed,
    /// 正しい。`sentence_done` は文を打ち終えた、`finished` は練習を終えた。
    Correct { sentence_done: bool, finished: bool },
    /// まちがい。`expected` は打つはずだった文字。
    Mistake { expected: Option<String> },
    /// まちがいだが、シャトルランの無敵の時間なので数えない。
    Guarded,
}

/// 1 回の練習。
#[derive(Debug, Clone)]
pub struct Session {
    pub words: Vec<Word>,
    /// 文ごとの言語（`None` なら前の文と同じ）。
    pub word_langs: Vec<Option<Lang>>,
    /// 今の文の言語。
    pub lang: Lang,
    pub style: Style,
    pub layout: Layout,
    pub kind: KeyboardType,
    typeable: HashSet<char>,
    /// 文を打ち終えたら、次の文を自分で読むか（シャトルランでは呼ぶ側が決めるので `false`）。
    pub auto_advance: bool,

    pub word_index: usize,
    pub chunks: Vec<ChunkState>,
    pub chunk_index: usize,
    /// 直前の「ん」を N 1 つで打った：次に N を打てば NN として受ける。
    pub allow_optional_second_n: bool,
    /// 文末の「ん」を N 1 つで打った：次の文の頭の N を受け流すことがある。
    pub trailing_second_n: bool,
    pub finished: bool,

    pub correct: u64,
    pub mistakes: u64,
    pub combo: u64,
    pub max_combo: u64,
    /// 打ち終えたかなの数（UTF-16 の単位）。
    pub completed_kana: u64,
    /// 打ち終えた文の標準打鍵数（訓令式のローマ字の長さ。英語は 1 文字 1 打）の合計。スコアの速さに使う。
    pub completed_ref_keys: u64,
    pub current_word_ref_keys: u64,
    /// まちがえたときに打つはずだった文字と回数（旧版（v5）のオブジェクトと同じ並び）。
    pub missed_chars: Vec<(String, u64)>,
    /// 正しい打鍵の間隔（ミリ秒）。文の最初の 1 打とミスの直後は数えない。
    pub key_intervals: Vec<f64>,
    last_correct_time: Option<f64>,
    /// 実測の配列の分析（正しく打ったキーだけ）。
    pub live: Telemetry,
}

impl Session {
    /// 練習を始める（最初の文を読む）。
    pub fn new(words: Vec<Word>, word_langs: Vec<Option<Lang>>, lang: Lang, style: Style, layout: Layout, kind: KeyboardType) -> Session {
        Session::with_auto_advance(words, word_langs, lang, style, layout, kind, true)
    }

    /// `auto_advance` を選んで始める（シャトルランは `false`：文を打ち終えたら、呼ぶ側が次を決める）。
    pub fn with_auto_advance(
        words: Vec<Word>,
        word_langs: Vec<Option<Lang>>,
        lang: Lang,
        style: Style,
        layout: Layout,
        kind: KeyboardType,
        auto_advance: bool,
    ) -> Session {
        let typeable = layout::typeable_chars(&layout::char_reach(&layout, kind));
        let mut s = Session {
            words,
            word_langs,
            lang,
            style,
            layout,
            kind,
            typeable,
            auto_advance,
            word_index: 0,
            chunks: Vec::new(),
            chunk_index: 0,
            allow_optional_second_n: false,
            trailing_second_n: false,
            finished: false,
            correct: 0,
            mistakes: 0,
            combo: 0,
            max_combo: 0,
            completed_kana: 0,
            completed_ref_keys: 0,
            current_word_ref_keys: 0,
            missed_chars: Vec::new(),
            key_intervals: Vec::new(),
            last_correct_time: None,
            live: Telemetry::default(),
        };
        s.load_current_word();
        s
    }

    /// 今の文を読む。今の配列で打てるものが何もない文は飛ばす。文が尽きたら終わり（`auto_advance` が `false` なら、
    /// 終わりにせず `false` を返す：呼ぶ側が文を足して、もう一度呼ぶ）。
    pub fn load_current_word(&mut self) -> bool {
        loop {
            if self.word_index >= self.words.len() {
                if self.auto_advance {
                    self.finished = true;
                }
                return false;
            }
            if let Some(Some(l)) = self.word_langs.get(self.word_index) {
                self.lang = *l;
            }
            let word = &self.words[self.word_index];
            let chunks = match self.lang {
                Lang::En => kana::english_chunks(&word.kanji, &self.typeable),
                Lang::Ja => {
                    let mut c = kana::word_chunks(word, self.style);
                    kana::drop_untypeable_options(&mut c, &self.typeable);
                    c
                }
            };
            self.chunks = chunks.into_iter().map(ChunkState::from).collect();
            self.chunk_index = 0;
            self.allow_optional_second_n = false;
            self.skip_unproducible();
            if self.chunk_index < self.chunks.len() {
                break;
            }
            self.word_index += 1;
        }
        self.live.break_sequence();
        // 文の最初の 1 打は反応で、リズムには入れない
        self.last_correct_time = None;
        self.current_word_ref_keys = match self.lang {
            Lang::En => self.chunks.iter().filter(|c| !c.options.is_empty()).count() as u64,
            Lang::Ja => js::len16(&kana::primary_romaji(&self.words[self.word_index].kana, Style::Nihon)) as u64,
        };
        true
    }

    /// 文を後ろに足す（シャトルランの次の文）。
    pub fn push_words(&mut self, words: Vec<Word>, lang: Option<Lang>) {
        self.word_langs.extend(std::iter::repeat_n(lang, words.len()));
        self.words.extend(words);
    }

    /// 次の 1 打をリズムの起点にしない（一時停止から戻ったとき）。
    pub fn reset_rhythm_anchor(&mut self) {
        self.last_correct_time = None;
    }

    fn skip_unproducible(&mut self) {
        while let Some(c) = self.chunks.get_mut(self.chunk_index) {
            if !c.options.is_empty() {
                break;
            }
            c.skipped = true;
            self.chunk_index += 1;
            self.live.break_sequence();
        }
    }

    /// 次に打つ文字（ガイド用）。
    pub fn target_next_char(&self) -> Option<String> {
        if self.finished {
            return None;
        }
        let c = self.chunks.get(self.chunk_index)?;
        let first = c.options.first()?;
        first.chars().nth(c.typed.chars().count()).map(String::from)
    }

    /// この文字を打てば正しいか（何も変えずに調べる）。
    pub fn input_would_match(&self, ch: &str) -> bool {
        let Some(chunk) = self.chunks.get(self.chunk_index) else {
            return false;
        };
        let cand = format!("{}{ch}", chunk.typed);
        if chunk.options.iter().any(|o| o.starts_with(&cand)) {
            return true;
        }
        if self.allow_optional_second_n && ch == "N" && chunk.typed.is_empty() {
            return true;
        }
        if chunk.kana == "ん"
            && chunk.typed == "N"
            && chunk.options.iter().any(|o| o == "N")
            && let Some(next) = self.chunks.get(self.chunk_index + 1)
        {
            return next.options.iter().any(|o| o.starts_with(ch));
        }
        false
    }

    /// キーが打った文字のうち、判定に使う方（Shift を押したままでも、Shift なしの文字だけが正しければそちら）。
    pub fn choose_input_char<'a>(&self, ch: &'a str, alt: Option<&'a str>) -> &'a str {
        match alt {
            Some(a) if !self.finished && !self.input_would_match(ch) && self.input_would_match(a) => a,
            _ => ch,
        }
    }

    /// 1 文字を打つ。`code` は押したキーの位置（実測の分析用。わからなければ `None`）、`now` は時刻（ミリ秒）、
    /// `guarding` はシャトルランの無敵の時間か。
    pub fn input(&mut self, ch: &str, code: Option<&str>, now: f64, guarding: bool) -> Outcome {
        if self.finished {
            return Outcome::NotTyping;
        }
        let idx = self.chunk_index;
        let Some(chunk) = self.chunks.get(idx) else {
            return Outcome::NotTyping;
        };

        if self.trailing_second_n {
            self.trailing_second_n = false;
            if ch == "N" && idx == 0 && chunk.typed.is_empty() && !chunk.options.iter().any(|o| o.starts_with('N')) {
                return Outcome::Swallowed;
            }
        }

        let cand = format!("{}{ch}", chunk.typed);
        let (matching, rest): (Vec<String>, Vec<String>) = chunk.options.iter().cloned().partition(|o| o.starts_with(&cand));
        if !matching.is_empty() {
            self.allow_optional_second_n = false;
            let chunk = &mut self.chunks[idx];
            chunk.options = matching.into_iter().chain(rest).collect();
            chunk.typed = cand;
            let complete = chunk.typed == chunk.options[0];
            let single_n = chunk.kana == "ん" && chunk.typed == "N";
            self.on_correct(code, now);
            if complete {
                if single_n {
                    self.allow_optional_second_n = true;
                    if idx == self.chunks.len() - 1 {
                        self.trailing_second_n = true;
                    }
                }
                if let Some(o) = self.advance() {
                    return o;
                }
            }
            return Outcome::Correct {
                sentence_done: false,
                finished: false,
            };
        }

        if self.allow_optional_second_n && ch == "N" && self.chunks[idx].typed.is_empty() {
            self.allow_optional_second_n = false;
            if idx > 0 && self.chunks[idx - 1].kana == "ん" {
                let prev = &mut self.chunks[idx - 1];
                prev.typed = "NN".into();
                prev.options = std::iter::once("NN".to_string())
                    .chain(prev.options.iter().filter(|o| *o != "NN").cloned())
                    .collect();
            }
            self.on_correct(code, now);
            return Outcome::Correct {
                sentence_done: false,
                finished: false,
            };
        }

        let chunk = &self.chunks[idx];
        if chunk.kana == "ん" && chunk.typed == "N" && chunk.options.iter().any(|o| o == "N") && idx + 1 < self.chunks.len() {
            let (next_matches, next_rest): (Vec<String>, Vec<String>) =
                self.chunks[idx + 1].options.iter().cloned().partition(|o| o.starts_with(ch));
            if !next_matches.is_empty() {
                let chunk = &mut self.chunks[idx];
                chunk.options = std::iter::once("N".to_string())
                    .chain(chunk.options.iter().filter(|o| *o != "N").cloned())
                    .collect();
                self.completed_kana += js::len16(&chunk.kana) as u64;
                self.chunk_index += 1;
                let next = &mut self.chunks[idx + 1];
                next.options = next_matches.into_iter().chain(next_rest).collect();
                next.typed = ch.to_string();
                let complete = next.typed == next.options[0];
                self.on_correct(code, now);
                if complete && let Some(o) = self.advance() {
                    return o;
                }
                return Outcome::Correct {
                    sentence_done: false,
                    finished: false,
                };
            }
        }

        self.allow_optional_second_n = false;
        self.on_mistake(guarding)
    }

    fn on_correct(&mut self, code: Option<&str>, now: f64) {
        match code {
            Some(c) => self.live.add_keystroke(c, &self.layout, self.kind),
            None => self.live.break_sequence(), // 配列にないキーで打った：続きが切れる
        }
        if let Some(last) = self.last_correct_time {
            self.key_intervals.push(now - last);
        }
        self.last_correct_time = Some(now);
        self.correct += 1;
        self.combo += 1;
        self.max_combo = self.max_combo.max(self.combo);
    }

    fn on_mistake(&mut self, guarding: bool) -> Outcome {
        if guarding {
            return Outcome::Guarded;
        }
        self.live.break_sequence();
        // ミスの後の立て直しは正確さの問題で、リズムには入れない
        self.last_correct_time = None;
        self.mistakes += 1;
        self.combo = 0;
        let expected = self.target_next_char();
        if let Some(e) = &expected {
            match self.missed_chars.iter_mut().find(|(c, _)| c == e) {
                Some((_, n)) => *n += 1,
                None => {
                    self.missed_chars.push((e.clone(), 1));
                    js::object_key_order(&mut self.missed_chars);
                }
            }
        }
        Outcome::Mistake { expected }
    }

    /// 今の単位を打ち終えた。文を打ち終えたら `Some`（次の文を読んだ・練習を終えた）。
    fn advance(&mut self) -> Option<Outcome> {
        if let Some(done) = self.chunks.get(self.chunk_index) {
            self.completed_kana += js::len16(&done.kana) as u64;
        }
        self.chunk_index += 1;
        self.skip_unproducible();
        if self.chunk_index < self.chunks.len() {
            return None;
        }
        self.completed_ref_keys += self.current_word_ref_keys;
        if self.auto_advance {
            self.word_index += 1;
            self.load_current_word();
        }
        Some(Outcome::Correct {
            sentence_done: true,
            finished: self.finished,
        })
    }

    /// 練習の数字（スコアの計算に渡すもの）。`elapsed_ms` は練習の時間。
    pub fn stats(&self, elapsed_ms: f64) -> SessionStats {
        let elapsed_min = f64::max(elapsed_ms / 60000.0, 0.005);
        let attempts = self.correct + self.mistakes;
        let acc_ratio = if attempts > 0 { self.correct as f64 / attempts as f64 } else { 1.0 };
        SessionStats {
            elapsed_min,
            ref_kpm: self.completed_ref_keys as f64 / elapsed_min,
            acc_ratio,
        }
    }
}

/// 練習の数字。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SessionStats {
    /// 経過した分（最低 0.005 分）。
    pub elapsed_min: f64,
    /// 標準打鍵/分。
    pub ref_kpm: f64,
    /// 正確率（0〜1）。
    pub acc_ratio: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::preset_layout;

    fn session(kana: &str) -> Session {
        let w = Word {
            kanji: kana.into(),
            kana: kana.into(),
            romaji: String::new(),
            is_custom_romaji: false,
        };
        Session::new(
            vec![w],
            vec![None],
            Lang::Ja,
            Style::Nihon,
            preset_layout("qwerty", KeyboardType::Jis).unwrap(),
            KeyboardType::Jis,
        )
    }

    fn type_all(s: &mut Session, keys: &str) -> Vec<Outcome> {
        keys.chars().map(|c| s.input(&c.to_string(), None, 0.0, false)).collect()
    }

    #[test]
    fn simple_word() {
        let mut s = session("かな");
        let out = type_all(&mut s, "KANA");
        assert_eq!(
            out.last(),
            Some(&Outcome::Correct {
                sentence_done: true,
                finished: true
            })
        );
        assert_eq!((s.correct, s.mistakes, s.completed_ref_keys), (4, 0, 4));
    }

    #[test]
    fn n_can_be_single_or_double() {
        let mut s = session("かんじ");
        type_all(&mut s, "KANZI");
        assert!(s.finished);
        let mut s = session("かんじ");
        type_all(&mut s, "KANNZI");
        assert!(s.finished && s.mistakes == 0);
    }

    #[test]
    fn mistake_records_expected() {
        let mut s = session("か");
        assert_eq!(
            s.input("X", None, 0.0, false),
            Outcome::Mistake {
                expected: Some("K".into())
            }
        );
        assert_eq!(s.missed_chars, vec![("K".to_string(), 1)]);
        assert_eq!(s.input("X", None, 0.0, true), Outcome::Guarded);
    }
}
