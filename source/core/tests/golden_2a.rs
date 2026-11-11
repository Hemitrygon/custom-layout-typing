//! 段階 2a の正解データとの照らし合わせ：スコア・シャトルランの式・自動改行・圧縮。
//! 正解データは旧版（v5）から `node golden/generate.mjs` で作ったもの（tests/golden/*.json）。

mod common;
use common::{Diffs, arr, close, f, load, s};
use serde_json::Value;
use typing_core::{lz, score, shuttle, text};

// ---------- スコア ----------

#[test]
fn score_matches_current_version() {
    let g = load("score");
    let mut d = Diffs::new();

    let rhythms: Vec<score::Rhythm> = arr(&g["rhythm"])
        .iter()
        .map(|c| {
            let iv: Vec<f64> = arr(&c["intervals"]).iter().map(f).collect();
            let got = score::compute_rhythm(&iv);
            let o = &c["out"];
            let smooth_ok = match (got.smooth, o["smooth"].as_f64()) {
                (None, None) => true,
                (Some(a), Some(b)) => close(a, b),
                _ => false,
            };
            d.check(
                smooth_ok
                    && got.stalls as u64 == o["stalls"].as_u64().unwrap()
                    && got.samples as u64 == o["samples"].as_u64().unwrap()
                    && close(got.mul, f(&o["mul"])),
                || format!("rhythm {iv:?}: {got:?} / 旧版（v5） {o}"),
            );
            got
        })
        .collect();
    let none = score::compute_rhythm(&[]);
    d.check(none.samples == 0 && close(none.mul, f(&g["rhythmNull"]["mul"])), || {
        "rhythm(null)".into()
    });

    for c in arr(&g["composite"]) {
        let rhythm = c["rhythm"].as_u64().map(|i| &rhythms[i as usize]);
        let got = score::compute_composite_score(f(&c["refKpm"]), f(&c["accRatio"]), rhythm);
        let o = &c["out"];
        d.check(
            got.score == f(&o["score"])
                && close(got.speed_pts, f(&o["speedPts"]))
                && close(got.acc_mul, f(&o["accMul"]))
                && close(got.rhythm_mul, f(&o["rhythmMul"])),
            || format!("composite {c}: {got:?}"),
        );
    }

    for c in arr(&g["ranks"]) {
        let sc = f(&c["score"]);
        let rank = score::score_rank(sc).rank;
        let next = score::next_rank(sc).map(|r| r.rank);
        d.check(rank == s(&c["rank"]) && next == c["next"].as_str(), || {
            format!("rank {sc}: {rank} {next:?} / 旧版（v5） {c}")
        });
    }
    // JS の null は Rust では NaN で渡す（どちらも 0 として扱う）
    d.check(score::score_rank(f64::NAN).rank == s(&g["rankNull"]["rank"]), || {
        "rank(null)".into()
    });
    d.check(score::next_rank(f64::NAN).map(|r| r.rank) == g["rankNull"]["next"].as_str(), || {
        "next(null)".into()
    });

    let table = arr(&g["table"]);
    d.check(table.len() == score::SCORE_RANKS.len(), || "ランクの数".into());
    for (r, t) in score::SCORE_RANKS.iter().zip(table) {
        let info = r.tier.info();
        d.check(
            r.rank == s(&t["rank"])
                && r.min as f64 == f(&t["min"])
                && r.tier.as_str() == s(&t["tier"])
                && info.label == s(&t["label"])
                && info.color == s(&t["color"])
                && info.bg == s(&t["bg"])
                && info.comment == s(&t["comment"]),
            || format!("ランクの表 {}: {t}", r.rank),
        );
    }
    d.finish("score");
}

// ---------- シャトルラン ----------

#[test]
fn shuttle_matches_current_version() {
    let g = load("shuttle");
    let mut d = Diffs::new();
    let r = &g["rules"];
    let rr = &shuttle::SH_RULES;
    let pairs: [(&str, f64); 19] = [
        ("startKps", rr.start_kps),
        ("growth", rr.growth),
        ("growthLate", rr.growth_late),
        ("lateFrom", rr.late_from as f64),
        ("comboEvery", rr.combo_every as f64),
        ("comboBonus", rr.combo_bonus),
        ("missPenalty", rr.miss_penalty),
        ("missPenaltyHeavy", rr.miss_penalty_heavy),
        ("heavyAfter", rr.heavy_after as f64),
        ("carryRate", rr.carry_rate),
        ("carryMax", rr.carry_max),
        ("perfectBonus", rr.perfect_bonus),
        ("shieldStreak", rr.shield_streak as f64),
        ("shieldMax", rr.shield_max as f64),
        ("shieldRefill", rr.shield_refill),
        ("invincibleSec", rr.invincible_sec),
        ("twoPartsFrom", rr.two_parts_from as f64),
        ("threePartsFrom", rr.three_parts_from as f64),
        ("levelsPerStage", rr.levels_per_stage as f64),
    ];
    d.check(r.as_object().unwrap().len() == pairs.len(), || {
        format!("ルールの項目の数が違う：{r}")
    });
    for (k, v) in pairs {
        d.check(r[k].as_f64() == Some(v), || format!("ルール {k}: {v} / 旧版（v5） {}", r[k]));
    }

    for c in arr(&g["levels"]) {
        let lv = c["level"].as_i64().unwrap() as i32;
        let keys = shuttle::target_keys(lv);
        d.check(
            close(keys, f(&c["targetKeys"]))
                && close(shuttle::read_time(lv), f(&c["readTime"]))
                && close(shuttle::kps(lv), f(&c["kps"]))
                && close(shuttle::base_limit(lv, keys), f(&c["baseLimit"]))
                && close(shuttle::base_limit(lv, 40.0), f(&c["baseLimit40"]))
                && shuttle::stage_of(lv) as f64 == f(&c["stage"])
                && shuttle::parts_for(lv) as f64 == f(&c["parts"]),
            || format!("レベル {lv}: {c}"),
        );
    }

    for c in arr(&g["splits"]) {
        let got = shuttle::split(s(&c["kanji"]), s(&c["kana"]), c["n"].as_u64().unwrap() as usize);
        let want: Vec<(String, String)> = arr(&c["out"])
            .iter()
            .map(|p| (s(&p[0]).to_string(), s(&p[1]).to_string()))
            .collect();
        d.check(got == want, || format!("split {c}: {got:?}"));
    }

    let sets: Vec<Vec<shuttle::Freeze>> = arr(&g["freezeSets"])
        .iter()
        .map(|set| {
            arr(set)
                .iter()
                .map(|fz| shuttle::Freeze {
                    start: f(&fz[0]),
                    end: f(&fz[1]),
                    invincible: fz.get(2).and_then(Value::as_str) == Some("inv"),
                })
                .collect()
        })
        .collect();
    for c in arr(&g["freezes"]) {
        let set = &sets[c["set"].as_u64().unwrap() as usize];
        let from = f(&c["from"]);
        let to = c["to"].as_f64().unwrap_or(f64::INFINITY);
        let at = shuttle::freeze_at(set, from).map(|x| set.iter().position(|y| std::ptr::eq(x, y)).unwrap() as u64);
        d.check(
            close(shuttle::frozen_ms(set, from, to), f(&c["frozenMs"]))
                && at == c["freezeAt"].as_u64()
                && close(shuttle::time_left(f(&c["deadline"]), set, from), f(&c["timeLeft"])),
            || format!("freeze {c}"),
        );
    }

    for c in arr(&g["perfect"]) {
        let levels: Vec<shuttle::LevelMark> = arr(&c["levels"])
            .iter()
            .map(|l| shuttle::LevelMark {
                fail: l["fail"].as_bool().unwrap(),
                miss: l["miss"].as_u64().unwrap() as u32,
            })
            .collect();
        d.check(shuttle::perfect_run(&levels) as f64 == f(&c["out"]), || format!("perfect {c}"));
    }
    d.finish("shuttle");
}

// ---------- 自動改行 ----------

#[test]
fn text_matches_current_version() {
    let g = load("text");
    let mut d = Diffs::new();
    for c in arr(&g["breaks"]) {
        let got = text::auto_break_line(s(&c["line"]), c["size"].as_u64().unwrap() as usize);
        let want: Vec<&str> = arr(&c["out"]).iter().map(s).collect();
        d.check(got == want, || format!("autoBreakLine {c}: {got:?}"));
    }
    for c in arr(&g["counted"]) {
        d.check(text::counted_length(s(&c["s"])) as u64 == c["n"].as_u64().unwrap(), || {
            format!("countedLength {c}")
        });
    }
    for c in arr(&g["spec"]) {
        d.check(text::is_reading_spec_line(s(&c["line"])) == c["out"].as_bool().unwrap(), || {
            format!("isReadingSpecLine {c}")
        });
    }
    d.finish("text");
}

// ---------- 圧縮 ----------

#[test]
fn lz_matches_current_version() {
    let g = load("lz");
    let mut d = Diffs::new();
    d.check(s(&g["mark"]) == lz::LZ_MARK, || "LZ_MARK".into());
    for c in arr(&g["compressed"]) {
        let (plain, packed) = (s(&c["s"]), s(&c["c"]));
        let got = lz::compress16(plain);
        d.check(got == packed, || {
            format!(
                "compress {:?}: 長さ {} / 旧版（v5） {}",
                plain.chars().take(30).collect::<String>(),
                got.len(),
                packed.len()
            )
        });
        d.check(lz::decompress16(packed).as_deref() == Ok(plain), || {
            format!("decompress {:?}", plain.chars().take(30).collect::<String>())
        });
    }
    for c in arr(&g["bad"]) {
        let got = lz::decompress16(s(&c["input"]));
        let o = &c["out"];
        // 旧版（v5）の答え → Rust の答え：null → 壊れている、'' → 途中で切れている（か、本当に空）、{lone} → 文字列にならない
        let ok = match (o, &got) {
            (Value::Null, Err(lz::LzError::Invalid)) => true,
            (Value::String(w), Err(lz::LzError::Truncated)) => w.is_empty(),
            (Value::String(w), Ok(x)) => w == x,
            (Value::Object(m), Err(lz::LzError::BadText)) => m.contains_key("lone"),
            _ => false,
        };
        d.check(ok, || {
            format!(
                "壊れたデータ {:?}: {got:?} / 旧版（v5） {o}",
                s(&c["input"]).chars().take(20).collect::<String>()
            )
        });
    }
    for c in arr(&g["stored"]) {
        let got = lz::decode_stored(s(&c["raw"]));
        d.check(got.as_deref() == c["out"].as_str(), || {
            format!(
                "decodeStored {:?}: {got:?} / 旧版（v5） {}",
                s(&c["raw"]).chars().take(20).collect::<String>(),
                c["out"]
            )
        });
    }
    for c in arr(&g["encode"]) {
        let got = lz::encode_for_storage(c["on"].as_bool().unwrap(), s(&c["key"]), s(&c["value"]));
        d.check(got == s(&c["out"]), || format!("encodeForStorage on={} key={}", c["on"], c["key"]));
    }
    d.finish("lz");
}
