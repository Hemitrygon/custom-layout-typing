//! 段階 2c の正解データとの照らし合わせ：打鍵の判定（typing）と、キーの読み取り（keys）。

mod common;
use common::{Diffs, arr, load, s};
use serde_json::{Value, json};
use typing_core::kana::{Style, Word};
use typing_core::keys::{self, KeyContext, KeyEvent, Via};
use typing_core::layout::{self, KeyboardType};
use typing_core::typing::{Lang, Session};

fn word_of(v: &Value) -> Word {
    Word {
        kanji: s(&v["kanji"]).into(),
        kana: s(&v["kana"]).into(),
        romaji: s(&v["romaji"]).into(),
        is_custom_romaji: v["isCustomRomaji"].as_bool().unwrap(),
    }
}

fn snap(se: &Session) -> Value {
    let t = &se.live;
    json!({
        "ci": se.chunk_index, "wi": se.word_index,
        "chunks": se.chunks.iter().map(|c| json!([c.kana, c.options, c.typed, c.skipped])).collect::<Vec<_>>(),
        "correct": se.correct, "mistakes": se.mistakes, "combo": se.combo, "maxCombo": se.max_combo,
        "kana": se.completed_kana, "ref": se.completed_ref_keys, "curRef": se.current_word_ref_keys,
        "allow": se.allow_optional_second_n, "trailing": se.trailing_second_n,
        "missed": se.missed_chars.iter().map(|(c, n)| json!([c, n])).collect::<Vec<_>>(),
        "finished": se.finished,
        "next": se.target_next_char(),
        "would": if se.finished { Value::Null } else { json!(["N", "A", "K", "I"].map(|c| se.input_would_match(c))) },
        "live": [t.total_hits, t.row_hits, t.left_hand_hits, t.right_hand_hits, t.pairs, t.alternation_count, t.same_finger_count, t.same_key_count],
    })
}

#[test]
fn typing_matches_current_version() {
    let g = load("typing");
    let mut d = Diffs::new();
    for (si, sess) in arr(&g["sessions"]).iter().enumerate() {
        let words: Vec<Word> = arr(&sess["words"]).iter().map(word_of).collect();
        let lang = if s(&sess["lang"]) == "en" { Lang::En } else { Lang::Ja };
        let kind = KeyboardType::Jis;
        let l = layout::preset_layout(s(&sess["layout"]), kind).unwrap();
        let n = words.len();
        let mut se = Session::new(words, vec![None; n], lang, Style::parse(s(&sess["style"])), l, kind);
        for (k, step) in arr(&sess["steps"]).iter().enumerate() {
            se.input(s(&step["ch"]), step["code"].as_str(), 0.0, false);
            let got = snap(&se);
            let want = &step["s"];
            d.check(&got == want, || {
                format!(
                    "練習 #{si}（{:?}）の {k} 打目 {:?}:\n  Rust   {got}\n  旧版（v5） {want}",
                    s(&sess["keys"]),
                    s(&step["ch"])
                )
            });
        }
    }
    d.finish("typing");
}

fn event_of(v: &Value) -> KeyEvent {
    KeyEvent {
        code: s(&v["code"]).into(),
        key: s(&v["key"]).into(),
        shift_key: v["shiftKey"].as_bool().unwrap(),
    }
}

fn pairs(m: &keys::SignalMap) -> Value {
    json!(m.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>())
}

#[test]
fn keys_match_current_version() {
    let g = load("keys");
    let mut d = Diffs::new();
    let calibs = arr(&g["calibs"]);
    let extras = arr(&g["extras"]);
    for c in arr(&g["cases"]) {
        let kind = KeyboardType::parse(s(&c["type"]));
        let l = layout::ensure_layout_keys(&c["layout"], kind).unwrap();
        let cal = keys::load_calibration(calibs[c["ci"].as_u64().unwrap() as usize].as_str(), kind);
        let ex = keys::load_extra_keys(extras[c["xi"].as_u64().unwrap() as usize].as_str(), kind);
        let what = format!(
            "{} {} 調整#{} 追加#{} 仮想Shift={}",
            c["type"], c["lname"], c["ci"], c["xi"], c["vs"]
        );
        let cal_json = cal.as_ref().map_or(Value::Null, |k| {
            json!({ "map": pairs(&k.map), "shiftMap": pairs(&k.shift_map), "at": k.at, "shiftAt": k.shift_at, "remapped": k.remapped, "skipped": k.skipped })
        });
        // 小数の 123 と整数の 123 を同じとみなすため、数を f64 にそろえて比べる
        let norm = |v: &Value| -> Value { serde_json::from_str(&v.to_string().replace(".0,", ",").replace(".0}", "}")).unwrap() };
        d.check(norm(&cal_json) == norm(&c["calibration"]), || {
            format!("{what} loadCalibration: {cal_json} / 旧版（v5） {}", c["calibration"])
        });
        d.check(pairs(&ex) == c["extra"], || format!("{what} loadExtraKeys: {}", pairs(&ex)));
        d.check(
            keys::escape_is_typed_key(cal.as_ref(), kind) == c["escTyped"].as_bool().unwrap(),
            || format!("{what} escapeIsTypedKey"),
        );
        let ctx = KeyContext {
            layout: &l,
            kind,
            calibration: cal.as_ref(),
            extra_keys: &ex,
            virtual_shift_held: c["vs"].as_bool().unwrap(),
        };
        for ev in arr(&c["events"]) {
            let e = event_of(&ev["e"]);
            d.check(
                keys::key_signal_of(&e, true) == s(&ev["sig1"]) && keys::key_signal_of(&e, false) == s(&ev["sig0"]),
                || format!("{what} keySignalOf {e:?}"),
            );
            let reading = ctx.current_reading_of(&e).map_or(Value::Null, |r| {
                let mut o = json!({ "code": r.code, "via": match r.via { Via::Extra => "extra", Via::Calib => "calib", Via::Std => "std" }, "sig": r.sig });
                // 旧版（v5）は shift を、追加のキーでは必ず、調整の Shift の表では true のときだけ持つ
                if r.via == Via::Extra || r.shift {
                    o["shift"] = json!(r.shift);
                }
                o
            });
            d.check(reading == ev["reading"], || {
                format!("{what} currentReadingOf {e:?}: {reading} / 旧版（v5） {}", ev["reading"])
            });
            d.check(ctx.resolve_physical_code(&e).as_deref() == ev["phys"].as_str(), || {
                format!("{what} resolvePhysicalCode {e:?}")
            });
            let resolved = ctx
                .resolve_key_event(&e)
                .map_or(Value::Null, |r| json!({ "code": r.code, "char": r.ch, "altChar": r.alt_char }));
            d.check(resolved == ev["resolved"], || {
                format!("{what} resolveKeyEvent {e:?}: {resolved} / 旧版（v5） {}", ev["resolved"])
            });
            d.check(ctx.is_calibrated_char_key(&e) == ev["calibChar"].as_bool().unwrap(), || {
                format!("{what} isCalibratedCharKey {e:?}")
            });
        }
    }
    d.finish("keys");
}
