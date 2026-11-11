//! 段階 2d の正解データとの照らし合わせ：配列（キーボードの種類・逆引き・整え方・AHK・分析）。

mod common;
use common::{Diffs, arr, load, s};
use serde_json::{Value, json};
use typing_core::kana::{Style, Word};
use typing_core::layout::{self, KeyboardType, Layout};

fn reach_json(r: &layout::CharReach) -> Value {
    Value::Object(
        r.iter()
            .map(|(k, v)| (k.clone(), json!({ "code": v.code, "shift": v.shift })))
            .collect(),
    )
}

fn analyse(d: &mut Diffs, l: &Layout, kind: KeyboardType, want: &Value, what: &str) {
    let reach = layout::char_reach(l, kind);
    d.check(reach_json(&reach) == want["reach"], || format!("{what} reach"));
    let usage: Vec<Value> = layout::char_usage(l, kind)
        .into_iter()
        .map(|(c, codes)| json!([c, codes]))
        .collect();
    d.check(Value::Array(usage) == want["usage"], || format!("{what} usage"));
    let health = layout::layout_health(l, kind);
    d.check(json!(health.missing) == want["missing"], || {
        format!("{what} missing {:?}", health.missing)
    });
    let ahk = layout::generate_ahk_script(l, kind);
    d.check(ahk == s(&want["ahk"]), || {
        format!("{what} ahk:\n{ahk}\n--- 旧版（v5） ---\n{}", s(&want["ahk"]))
    });
    for p in arr(&want["paths"]) {
        let got = layout::find_char_path(s(&p[0]), &reach)
            .map(|r| json!({ "code": r.code, "shift": r.shift }))
            .unwrap_or(Value::Null);
        d.check(got == p[1], || format!("{what} findCharPath {}", p[0]));
    }
}

fn word_of(v: &Value) -> Word {
    Word {
        kanji: s(&v["kanji"]).into(),
        kana: s(&v["kana"]).into(),
        romaji: s(&v["romaji"]).into(),
        is_custom_romaji: v["isCustomRomaji"].as_bool().unwrap(),
    }
}

#[test]
fn layout_matches_current_version() {
    let g = load("layout");
    let mut d = Diffs::new();
    let words: Vec<Word> = arr(&g["words"]).iter().map(word_of).collect();
    let english: Vec<Word> = arr(&g["englishWords"]).iter().map(word_of).collect();
    for kname in ["jis", "us"] {
        let kind = KeyboardType::parse(kname);
        let t = &g[kname];
        let rows: Vec<Value> = kind
            .rows()
            .iter()
            .map(|r| {
                json!(
                    r.iter()
                        .map(|s| json!([s.key.code, s.label, s.row, s.key.is_modifier]))
                        .collect::<Vec<_>>()
                )
            })
            .collect();
        d.check(Value::Array(rows) == t["rows"], || format!("{kname} rows"));
        let all: Vec<Value> = kind.all_key_slots().iter().map(|s| json!([s.key.code, s.label, s.row])).collect();
        d.check(Value::Array(all) == t["allKeySlots"], || format!("{kname} allKeySlots"));
        d.check(json!(kind.editable_codes()) == t["editable"], || format!("{kname} editable"));
        for p in arr(&t["shifted"]) {
            d.check(kind.shifted_char(s(&p[0])) == s(&p[1]), || format!("{kname} shifted {}", p[0]));
        }
        for p in arr(&t["presets"]) {
            let key = s(&p["key"]);
            let l = layout::preset_layout(key, kind).unwrap();
            d.check(l.to_json() == p["layout"], || format!("{kname} preset {key}: {}", l.to_json()));
            analyse(&mut d, &l, kind, p, &format!("{kname} preset {key}"));
        }
        for (i, e) in arr(&t["ensured"]).iter().enumerate() {
            let got = layout::ensure_layout_keys(&e["raw"], kind);
            match (&got, e["layout"].is_null()) {
                (None, true) => d.check(true, String::new),
                (Some(l), false) => {
                    let mut want = e["layout"].clone();
                    if want["description"].is_null() {
                        want.as_object_mut().unwrap().remove("description");
                    }
                    d.check(l.to_json() == want, || {
                        format!("{kname} ensure #{i}: {}\n--- 旧版（v5） ---\n{want}", l.to_json())
                    });
                    analyse(&mut d, l, kind, e, &format!("{kname} ensure #{i}"));
                }
                _ => d.check(false, || format!("{kname} ensure #{i}: {got:?} / 旧版（v5） {}", e["layout"])),
            }
        }
        for a in arr(&t["ahk"]) {
            let got = layout::parse_ahk_script(s(&a["text"]), kind);
            let ok = match (&got, a.get("error")) {
                (Err(m), Some(w)) => m == s(w),
                (Ok(l), None) => l.to_json() == a["layout"],
                _ => false,
            };
            d.check(ok, || {
                format!("{kname} parseAhk {:?}: {:?}", s(&a["text"]), got.map(|l| l.to_json()))
            });
        }
        let layouts: Vec<Layout> = vec![
            layout::preset_layout("qwerty", kind).unwrap(),
            layout::preset_layout("oonishi", kind).unwrap(),
            layout::preset_layout("dvorak", kind).unwrap(),
            layout::ensure_layout_keys(&g["randomLayouts"][0], kind).unwrap(),
        ];
        for c in arr(&t["telemetry"]) {
            let l = &layouts[c["layoutIndex"].as_u64().unwrap() as usize];
            let en = c["english"].as_bool().unwrap();
            let tm = layout::theoretical_telemetry(l, if en { &english } else { &words }, Style::parse(s(&c["style"])), en, kind);
            let got = json!({
                "totalHits": tm.total_hits, "rowHits": tm.row_hits, "left": tm.left_hand_hits, "right": tm.right_hand_hits, "pairs": tm.pairs,
                "alternation": tm.alternation_count, "sameFinger": tm.same_finger_count, "sameKey": tm.same_key_count,
                "skipped": tm.skipped_chars.iter().map(|(c, n)| json!([c, n])).collect::<Vec<_>>(),
            });
            d.check(got == c["out"], || format!("{kname} telemetry {c}: {got}"));
        }
    }
    d.finish("layout");
}
