//! 段階 2b の正解データとの照らし合わせ：かな → ローマ字（kana）と、よみの辞書（dict）。

mod common;
use common::{Diffs, arr, load, s};
use serde_json::Value;
use std::collections::HashSet;
use typing_core::dict::{self, Token, UserDict};
use typing_core::kana::{self, Chunk, Style, Word};

fn chunks_json(cs: &[Chunk]) -> Value {
    Value::Array(cs.iter().map(|c| serde_json::json!([c.kana, c.options])).collect())
}

fn strs(v: &Value) -> Vec<String> {
    arr(v).iter().map(|x| s(x).to_string()).collect()
}

fn charset(v: &Value) -> HashSet<char> {
    arr(v).iter().map(|x| s(x).chars().next().unwrap()).collect()
}

#[test]
fn kana_matches_current_version() {
    let g = load("kana");
    let mut d = Diffs::new();
    for c in arr(&g["chunks"]) {
        let style = Style::parse(s(&c["style"]));
        let got = kana::build_kana_chunks(s(&c["r"]), style);
        d.check(chunks_json(&got) == c["out"], || {
            format!("buildKanaChunks {:?} {}: {}", s(&c["r"]), s(&c["style"]), chunks_json(&got))
        });
        let p = kana::primary_romaji(s(&c["r"]), style);
        d.check(p == s(&c["primary"]), || format!("primary {:?}: {p}", s(&c["r"])));
    }
    for c in arr(&g["baseOptions"]) {
        let got = kana::base_options(s(&c["t"]), Style::parse(s(&c["style"])));
        d.check(got == strs(&c["out"]), || format!("baseOptions {c}: {got:?}"));
    }
    for c in arr(&g["equivalents"]) {
        let got = kana::romaji_equivalents(s(&c["r"]));
        d.check(got == strs(&c["out"]), || format!("equivalents {c}: {got:?}"));
    }
    for c in arr(&g["normalize"]) {
        let t = s(&c["s"]);
        d.check(kana::normalize_reading(t) == s(&c["reading"]), || format!("normalizeReading {t:?}"));
        d.check(kana::kana_of_text(t) == s(&c["kanaOfText"]), || format!("kanaOfText {t:?}"));
        d.check(kana::normalize_romaji_input(t) == s(&c["romajiInput"]), || {
            format!("romajiInput {t:?}")
        });
        d.check(kana::has_unconverted_kanji(t) == c["hasKanji"].as_bool().unwrap(), || {
            format!("hasKanji {t:?}")
        });
    }
    for c in arr(&g["words"]) {
        let style = Style::parse(s(&c["style"]));
        let word = Word {
            kanji: String::new(),
            kana: s(&c["kana"]).into(),
            romaji: s(&c["romaji"]).into(),
            is_custom_romaji: true,
        };
        let custom = kana::word_chunks(&word, style);
        d.check(chunks_json(&custom) == c["custom"], || {
            format!(
                "word {:?} / {:?} {}: {}",
                word.kana,
                word.romaji,
                s(&c["style"]),
                chunks_json(&custom)
            )
        });
        let plain_word = Word {
            is_custom_romaji: false,
            ..word.clone()
        };
        d.check(chunks_json(&kana::word_chunks(&plain_word, style)) == c["plain"], || {
            format!("word plain {:?}", word.kana)
        });
        d.check(kana::effective_word_romaji(&word, style) == s(&c["effective"]), || {
            format!("effective {:?}", word.romaji)
        });
        d.check(kana::effective_word_romaji(&plain_word, style) == s(&c["effectivePlain"]), || {
            format!("effective plain {:?}", word.kana)
        });
    }
    for c in arr(&g["english"]) {
        let chars = charset(&c["chars"]);
        let t = s(&c["t"]);
        d.check(kana::normalize_english_text(t) == s(&c["normalized"]), || {
            format!("normalizeEnglish {t:?}: {:?}", kana::normalize_english_text(t))
        });
        let got = kana::english_chunks(t, &chars);
        d.check(chunks_json(&got) == c["out"], || {
            format!("englishChunks {t:?}: {}", chunks_json(&got))
        });
    }
    for c in arr(&g["drop"]) {
        let chars = charset(&c["chars"]);
        let mut cs = kana::build_kana_chunks(s(&c["r"]), Style::Nihon);
        kana::drop_untypeable_options(&mut cs, &chars);
        d.check(chunks_json(&cs) == c["out"], || {
            format!("drop {:?}: {}", s(&c["r"]), chunks_json(&cs))
        });
    }
    d.finish("kana");
}

fn segs_json(segs: &[dict::Segment]) -> Value {
    Value::Array(
        segs.iter()
            .map(|x| serde_json::json!([x.text, x.reading, x.user, x.base]))
            .collect(),
    )
}

fn token_of(v: &Value) -> Token {
    Token {
        surface_form: s(&v["surface_form"]).into(),
        basic_form: v["basic_form"].as_str().map(String::from),
        reading: v["reading"].as_str().map(String::from),
    }
}

#[test]
fn dict_matches_current_version() {
    let g = load("dict");
    let mut d = Diffs::new();
    // kuromoji の代わりの表：旧版（v5）で記録した「文 → 語の並び」をそのまま使う
    let calls = g["calls"].as_object().unwrap();
    let tokenize = |part: &str| -> Vec<Token> {
        arr(calls.get(part).unwrap_or_else(|| panic!("記録にない文 {part:?}")))
            .iter()
            .map(token_of)
            .collect()
    };
    for case in ["withUser", "withoutUser"] {
        let c = &g[case];
        let entries: Vec<(String, String)> = arr(&c["entries"]).iter().map(|e| (s(&e[0]).into(), s(&e[1]).into())).collect();
        let ud = UserDict::new(entries);
        for t in arr(&c["segments"]) {
            let text = s(&t["s"]);
            let got = ud.segments(text);
            d.check(segs_json(&got) == t["out"], || {
                format!("{case} dictSegments {text:?}: {}", segs_json(&got))
            });
            d.check(ud.apply(text) == s(&t["reading"]), || format!("{case} apply {text:?}"));
            d.check(ud.has_word_in(text) == t["hasUser"].as_bool().unwrap(), || {
                format!("{case} hasUserDictWord {text:?}")
            });
        }
        for t in arr(&c["tokenized"]) {
            let text = s(&t["s"]);
            let got = ud.tokenize_with(text, tokenize);
            d.check(segs_json(&got) == t["out"], || {
                format!("{case} tokenize {text:?}: {}", segs_json(&got))
            });
        }
        for t in arr(&c["pasted"]) {
            let line = s(&t["l"]);
            let got = ud.parse_pasted_line(line, Style::parse(s(&t["style"])));
            let want = &t["out"];
            let ok = match (&got, want) {
                (None, Value::Null) => true,
                (Some(p), w) if !w.is_null() => {
                    p.word.kanji == s(&w["kanji"])
                        && p.word.kana == s(&w["kana"])
                        && p.word.romaji == s(&w["romaji"])
                        && p.word.is_custom_romaji == w["isCustomRomaji"].as_bool().unwrap()
                        && p.reading_given == w["given"].as_bool().unwrap()
                        && p.auto_segments.as_deref().map(segs_json).unwrap_or(Value::Null) == w["auto"]
                }
                _ => false,
            };
            d.check(ok, || {
                format!("{case} parsePastedLine {line:?} {}: {got:?} / 旧版（v5） {want}", s(&t["style"]))
            });
        }
    }
    let user: Vec<(String, String)> = arr(&g["withUser"]["entries"])
        .iter()
        .map(|e| (s(&e[0]).into(), s(&e[1]).into()))
        .collect();
    let ud = UserDict::new(user);
    for c in arr(&g["conj"]) {
        let got = ud.conjugated_reading(&token_of(&c["token"]));
        d.check(got.as_deref() == c["out"].as_str(), || format!("conjugated {c}: {got:?}"));
    }
    for c in arr(&g["tails"]) {
        let got = dict::okurigana_tails(s(&c["b"]), s(&c["s"]));
        let want = c["out"]
            .as_object()
            .map(|o| (s(&o["baseTail"]).to_string(), s(&o["surfTail"]).to_string()));
        d.check(got == want, || format!("okuriganaTails {c}: {got:?}"));
    }
    for c in arr(&g["loads"]) {
        let got = UserDict::load(c["raw"].as_str());
        let want: Vec<(String, String)> = arr(&c["entries"]).iter().map(|e| (s(&e[0]).into(), s(&e[1]).into())).collect();
        d.check(got.entries == want && got.defaults_offered == strs(&c["offered"]), || {
            format!(
                "loadUserDict {:?}: {:?}",
                c["raw"].as_str().map(|r| r.chars().take(40).collect::<String>()),
                got.entries.iter().take(8).collect::<Vec<_>>()
            )
        });
    }
    for c in arr(&g["words"]) {
        d.check(dict::clean_word(s(&c["s"])) == s(&c["out"]), || format!("cleanWord {c}"));
    }
    for c in arr(&g["reads"]) {
        d.check(dict::clean_reading(s(&c["s"])) == s(&c["out"]), || {
            format!("cleanReading {c}: {:?}", dict::clean_reading(s(&c["s"])))
        });
    }
    d.finish("dict");
}
