//! 段階 2e の正解データとの照らし合わせ：記録・トロフィー・バックアップ（records）と、シャトルランの進み方（shuttlerun）。

mod common;
use common::{Diffs, arr, close, f, load, s};
use serde_json::{Value, json};
use std::collections::VecDeque;
use typing_core::kana::Style;
use typing_core::layout::{self, KeyboardType};
use typing_core::records::{self, FinishInput, TrophyStore};
use typing_core::shuttle_run::{Phase, ShuttleRun};

/// JSON の値を比べる（数は小さな誤差を許す。オブジェクトはキーの並びを問わない）。
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => close(x.as_f64().unwrap(), y.as_f64().unwrap()),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

fn is_safe_id(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 新しい id が要る記録に、旧版（v5）が作った id を順に渡す。
fn ids_for(inputs: &[Value], outputs: &[Value]) -> VecDeque<String> {
    let objs = inputs.iter().filter(|r| r.is_object());
    objs.zip(outputs)
        .filter(|(i, _)| !is_safe_id(&i.get("id").and_then(Value::as_str).map(|x| x.replace('.', "_")).unwrap_or_default()))
        .map(|(_, o)| s(&o["id"]).to_string())
        .collect()
}

#[test]
fn records_match_current_version() {
    let g = load("records");
    let mut d = Diffs::new();

    for c in arr(&g["normalize"]) {
        let want = &c["out"];
        let mut id = || want.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let got = records::normalize_history_record(&c["raw"], &mut id).unwrap_or(Value::Null);
        d.check(same(&got, want), || {
            format!("normalizeHistoryRecord {}: {got} / 旧版（v5） {want}", c["raw"])
        });
    }
    for c in arr(&g["loads"]) {
        let raw = c["raw"].as_str();
        let inputs: Vec<Value> = raw
            .and_then(|r| serde_json::from_str::<Value>(r).ok())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        let from = inputs.len().saturating_sub(records::SCORE_HISTORY_MAX);
        let mut ids = ids_for(&inputs[from..], arr(&c["out"]));
        let (got, ok) = records::load_score_history(raw, raw.is_some(), &mut || ids.pop_front().unwrap_or_default());
        d.check(
            ok == c["ok"].as_bool().unwrap() && same(&Value::Array(got.clone()), &c["out"]),
            || {
                format!(
                    "loadScoreHistory {:?}: ok={ok}",
                    raw.map(|r| r.chars().take(30).collect::<String>())
                )
            },
        );
    }
    for c in arr(&g["finish"]) {
        let iv: Vec<f64> = arr(&c["intervals"]).iter().map(f).collect();
        let rec = &c["record"];
        let input = FinishInput {
            correct: c["correct"].as_u64().unwrap(),
            mistakes: c["mistakes"].as_u64().unwrap(),
            completed_kana: c["kana"].as_u64().unwrap(),
            completed_ref_keys: c["ref"].as_u64().unwrap(),
            key_intervals: &iv,
            max_combo: c["maxCombo"].as_u64().unwrap(),
            sentences: c["sentences"].as_u64().unwrap() as usize,
            elapsed_ms: f(&c["elapsedMs"]),
            is_english: s(&c["lang"]) == "en",
            course_key: "ck",
            course_name: "cn",
            group_name: None,
            layout_key: "lk",
            layout_name: "L",
            romaji_style: s(&c["style"]),
            id: rec.get("id").and_then(Value::as_str).unwrap_or(""),
            timestamp: 1_700_000_000_000.0,
        };
        let got = records::finish_session(&input);
        let ok = match (&got, s(&c["screen"])) {
            (None, screen) => screen != "result",
            (Some(r), "result") => same(&r.record.clone().unwrap_or(Value::Null), rec),
            _ => false,
        };
        d.check(ok, || format!("finishTypingSession {c}: {:?}", got.map(|r| r.record)));
    }
    for c in arr(&g["shuttleHistory"]) {
        let got: Vec<Value> = records::load_shuttle_history(c["raw"].as_str())
            .iter()
            .map(|r| r.to_json())
            .collect();
        d.check(same(&Value::Array(got.clone()), &c["out"]), || {
            format!(
                "loadShuttleHistory {:?}: {}",
                c["raw"].as_str().map(|r| r.chars().take(40).collect::<String>()),
                json!(got)
            )
        });
    }
    let hist = records::load_shuttle_history(arr(&g["shuttleHistory"])[5]["raw"].as_str());
    for c in arr(&g["trophyLoads"]) {
        let got = TrophyStore::load(c["raw"].as_str(), &hist, 0.0).to_json();
        d.check(same(&got, &c["out"]), || {
            format!("loadShuttleTrophies {:?}: {got} / 旧版（v5） {}", c["raw"], c["out"])
        });
    }
    for c in arr(&g["trophyUpdates"]) {
        let history = records::load_shuttle_history(c["history"].as_str());
        let rec = records::load_shuttle_history(Some(&format!("[{}]", c["rec"]))).remove(0);
        let (store, fresh) = TrophyStore::update(c["raw"].as_str(), &history, &rec, 0.0);
        let fresh: Vec<&str> = fresh.iter().map(|t| t.id).collect();
        d.check(same(&store.to_json(), &c["store"]) && json!(fresh) == c["fresh"], || {
            format!(
                "updateShuttleTrophies {:?}: {} {fresh:?} / 旧版（v5） {} {}",
                c["raw"],
                store.to_json(),
                c["store"],
                c["fresh"]
            )
        });
    }
    for c in arr(&g["backup"]) {
        let info = &c["info"];
        let got = records::validate_backup(s(&c["text"]), Some(20 * 1024 * 1024));
        let ok = match &got {
            Ok(b) => {
                info["ok"] == json!(true)
                    && b.exported_at.unwrap_or(0.0) == f(&info["exportedAt"])
                    && b.scores as u64 == info.get("scores").and_then(Value::as_u64).unwrap_or(0) // 旧版（v5）は配列でないと「数なし」
                    && b.shuttle as u64 == info["shuttle"].as_u64().unwrap_or(0)
                    && json!(b.entries.iter().map(|(k, _)| k).collect::<Vec<_>>()) == c["keys"]
            }
            // 「復元できるデータがない」は、上書き保存の読み取り（readBackupFileInfo）では確かめない
            Err(records::BackupError::Empty) => info["ok"] == json!(true) && c["keys"].as_array().is_some_and(Vec::is_empty),
            Err(e) => info["ok"] == json!(false) && s(&info["reason"]) == e.message(),
        };
        d.check(ok, || {
            format!(
                "backup {:?}: {got:?} / 旧版（v5） {info} {}",
                s(&c["text"]).chars().take(60).collect::<String>(),
                c["keys"]
            )
        });
    }
    for c in arr(&g["toFixed"]) {
        let x = f(&c[0]);
        for (i, digits) in [(1, 1), (2, 2), (3, 0)] {
            let got = records::to_fixed(x, digits);
            d.check(got == s(&c[i]), || format!("({x}).toFixed({digits}): {got} / 旧版（v5） {}", c[i]));
        }
    }
    for c in arr(&g["reminder"]) {
        let ts: Vec<f64> = arr(&c["scores"]).iter().chain(arr(&c["shuttles"])).map(f).collect();
        let info = records::reminder_info(c["last"].as_str(), c["changed"].as_str(), &ts);
        let want = &c["info"];
        let got = json!({ "last": info.last, "count": info.count, "dataChanged": info.data_changed, "since": info.since });
        d.check(same(&got, want), || format!("backupReminderInfo {c}: {got}"));
        let due = records::reminder_due(!c["off"].as_bool().unwrap(), &info, f(&c["now"]), c["snooze"].as_str());
        d.check(due == c["due"].as_bool().unwrap(), || format!("backupReminderDue {c}: {due}"));
    }
    let storage: Vec<(String, Option<String>)> = arr(&g["collect"]["storage"])
        .iter()
        .map(|p| (s(&p[0]).to_string(), Some(s(&p[1]).to_string())))
        .collect();
    let got: serde_json::Map<String, Value> = records::collect_app_storage(&storage)
        .into_iter()
        .map(|(k, v)| (k, Value::String(v)))
        .collect();
    d.check(Value::Object(got.clone()) == g["collect"]["out"], || {
        format!("collectAppStorage: {got:?}")
    });

    let k = &g["keys"];
    d.check(
        s(&k["BACKUP_META_KEY"]) == records::BACKUP_META_KEY
            && s(&k["BACKUP_SNOOZE_KEY"]) == records::BACKUP_SNOOZE_KEY
            && s(&k["BACKUP_REMINDER_OFF_KEY"]) == records::BACKUP_REMINDER_OFF_KEY
            && s(&k["DATA_CHANGED_KEY"]) == records::DATA_CHANGED_KEY
            && s(&k["COMPRESS_FLAG_KEY"]) == records::COMPRESS_FLAG_KEY
            && s(&k["SHUTTLE_TROPHY_KEY"]) == records::SHUTTLE_TROPHY_KEY
            && s(&k["SHUTTLE_HISTORY_KEY"]) == records::SHUTTLE_HISTORY_KEY
            && k["STORAGE_PREFIXES"] == json!(records::STORAGE_PREFIXES)
            && k["SCORE_HISTORY_MAX"] == json!(records::SCORE_HISTORY_MAX)
            && k["SHUTTLE_HISTORY_MAX"] == json!(records::SHUTTLE_HISTORY_MAX),
        || format!("保存のキー {k}"),
    );
    let table: Vec<Value> = records::SHUTTLE_TROPHIES
        .iter()
        .map(|t| json!([t.id, t.tier, t.name, t.desc]))
        .collect();
    d.check(Value::Array(table) == g["trophyTable"], || "トロフィーの表".into());
    let tiers: Vec<Value> = records::TROPHY_TIERS.iter().map(|(k, l, st)| json!([k, l, st])).collect();
    d.check(Value::Array(tiers) == g["tiers"], || "トロフィーの格".into());
    d.finish("records");
}

fn phase_str(p: Phase) -> &'static str {
    match p {
        Phase::Intro => "intro",
        Phase::Run => "run",
        Phase::Paused => "paused",
        Phase::Over => "over",
    }
}

fn snap(r: &ShuttleRun) -> Value {
    let se = &r.session;
    json!({
        "phase": phase_str(r.phase), "level": r.level, "shields": r.shields, "limit": r.limit, "deadline": r.deadline,
        "levelBase": r.level_base, "carryIn": r.carry_in, "levelMisses": r.level_misses, "records": r.records.len(),
        "lastRecord": r.records.last().map_or(Value::Null, |l| json!({ "lv": l.lv, "limit": l.limit, "used": l.used, "miss": l.miss, "fail": l.fail })),
        "freezes": r.freezes.iter().map(|f| if f.invincible { json!([f.start, f.end, "inv"]) } else { json!([f.start, f.end]) }).collect::<Vec<_>>(),
        "levelStartAt": r.level_start_at, "startedAt": r.started_at,
        "wi": se.word_index, "words": se.words.len(), "ci": se.chunk_index, "correct": se.correct, "mistakes": se.mistakes, "combo": se.combo,
    })
}

#[test]
fn shuttle_run_matches_current_version() {
    let g = load("shuttlerun");
    let mut d = Diffs::new();
    for run in arr(&g["runs"]) {
        let kind = KeyboardType::Jis;
        let l = layout::preset_layout(s(&run["layout"]), kind).unwrap();
        let layout_name = l.name.clone();
        let mut picks: VecDeque<f64> = arr(&run["picks"]).iter().map(f).collect();
        let steps = arr(&run["steps"]);
        let seed = &run["seed"];
        let random = Box::new(move || picks.pop_front().expect("旧版（v5）より多く文を選んだ"));
        let mut r = ShuttleRun::begin(l, kind, Style::parse(s(&run["style"])), f(&steps[0]["now"]), random);
        let mut over_at = None;
        for (k, step) in steps.iter().enumerate() {
            let now = f(&step["now"]);
            match s(&step["op"]) {
                "begin" => {}
                "tick" => r.tick(now),
                "key" => {
                    r.input(s(&step["ch"]), step["code"].as_str(), now);
                }
                "pause" => r.pause(now),
                "resume" => r.resume(now),
                op => panic!("知らない操作 {op}"),
            }
            if r.phase == Phase::Over && over_at.is_none() {
                over_at = Some(now);
            }
            let got = snap(&r);
            d.check(same(&got, &step["s"]), || {
                format!(
                    "シャトルラン seed={seed} の {k} 番目（{} {}）:\n  Rust   {got}\n  旧版（v5） {}",
                    s(&step["op"]),
                    step.get("ch").map_or(String::new(), |c| c.to_string()),
                    step["s"]
                )
            });
        }
        r.events.clear();
        let want = &run["record"];
        if !want.is_null() {
            let rec = r.record(s(&want["id"]), f(&want["timestamp"]), over_at.unwrap_or(0.0), &layout_name);
            d.check(same(&rec.to_json(), want), || {
                format!("シャトルラン seed={seed} の記録:\n  Rust   {}\n  旧版（v5） {want}", rec.to_json())
            });
        }
    }
    d.finish("shuttlerun");
}
