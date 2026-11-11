//! 照らし合わせのテストの共通部分（正解データの読み込み・食い違いの集め方・小数の比べ方）。
#![allow(dead_code)]

use serde_json::Value;

pub fn load(name: &str) -> Value {
    let path = format!("{}/tests/golden/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path} が読めない（node golden/generate.mjs で作る）: {e}"));
    serde_json::from_str(&raw).unwrap()
}

pub fn arr(v: &Value) -> &Vec<Value> {
    v.as_array().expect("配列のはず")
}

pub fn f(v: &Value) -> f64 {
    v.as_f64().expect("数のはず")
}

pub fn s(v: &Value) -> &str {
    v.as_str().expect("文字列のはず")
}

/// 完全には一致せず、誤差の許しで通った小数の数（報告用）
static NEAR: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// 小数の比べ方：まず完全一致。違えば、JS と Rust の `pow` の最後の 1 ビットの差だけは許す（数を数えて報告する）。
pub fn close(a: f64, b: f64) -> bool {
    if a == b {
        return true;
    }
    let ok = (a - b).abs() <= 1e-12 * a.abs().max(b.abs());
    if ok {
        NEAR.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    ok
}

/// 食い違いを集めて、最後にまとめて報告する（最初の 5 件を表示）。
pub struct Diffs(Vec<String>, usize);

impl Diffs {
    pub fn new() -> Self {
        Diffs(Vec::new(), 0)
    }
    pub fn check(&mut self, ok: bool, what: impl FnOnce() -> String) {
        self.1 += 1;
        if !ok {
            self.0.push(what());
        }
    }
    pub fn finish(self, name: &str) {
        let Diffs(bad, n) = self;
        assert!(
            bad.is_empty(),
            "{name}: {} / {n} 件が今の版と違う。最初の 5 件:\n{}",
            bad.len(),
            bad.iter().take(5).cloned().collect::<Vec<_>>().join("\n")
        );
        assert!(n > 0, "{name}: 比べたものが 0 件");
        eprintln!(
            "{name}: {n} 件 一致（小数の誤差の許しで通ったもの：これまでに {} 件）",
            NEAR.load(std::sync::atomic::Ordering::Relaxed)
        );
    }
}
