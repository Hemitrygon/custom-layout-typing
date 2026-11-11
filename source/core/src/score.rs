//! スコア（旧版（v5）の「composite score」を移したもの）。
//!
//! `score = 標準打鍵/分 ÷ 1.7 × 10 × 正確率³ × リズム`

use crate::js;

/// ローマ字で 1 文字（かな）を打つのに要る、ふつうの打鍵数。標準打鍵/分 を 文字/分 に直すのに使う。
pub const STANDARD_KEYS_PER_CHAR: f64 = 1.7;

/// リズムの係数。打鍵の間隔が 10 個より少ないときに使う値でもある。
pub const DEFAULT_RHYTHM_MUL: f64 = 0.9;

// ---------- ランク ----------

/// ランクの大きな区分（S〜E）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    S,
    A,
    B,
    C,
    D,
    E,
}

/// 区分の表示（色・名前・ひとこと）。
#[derive(Debug)]
pub struct TierInfo {
    pub color: &'static str,
    pub bg: &'static str,
    pub label: &'static str,
    pub comment: &'static str,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::S => "S",
            Tier::A => "A",
            Tier::B => "B",
            Tier::C => "C",
            Tier::D => "D",
            Tier::E => "E",
        }
    }

    pub fn info(self) -> &'static TierInfo {
        match self {
            Tier::S => &TierInfo {
                color: "#c2410c",
                bg: "#ffedd5",
                label: "達人",
                comment: "タイピングが得意な人の中でもトップクラス。速さと正確さを高い水準で両立できています。",
            },
            Tier::A => &TierInfo {
                color: "#047857",
                bg: "#ecfdf5",
                label: "上級",
                comment: "人から「速いね」と言われるレベル。ミスを減らして連続記録を伸ばすとSに届きます。",
            },
            Tier::B => &TierInfo {
                color: "#0369a1",
                bg: "#e0f2fe",
                label: "中級",
                comment: "チャットや文章入力に困らない速さです。手元を見ずに打てるとさらに伸びます。",
            },
            Tier::C => &TierInfo {
                color: "#4338ca",
                bg: "#eef2ff",
                label: "初中級",
                comment: "基本が身についてきました。速さよりミスを減らすことを意識するとスコアが一気に上がります。",
            },
            Tier::D => &TierInfo {
                color: "#475569",
                bg: "#f1f5f9",
                label: "初級",
                comment: "キーの位置を覚えてきた段階。ゆっくりでいいので正確に打つ練習を続けましょう。",
            },
            Tier::E => &TierInfo {
                color: "#64748b",
                bg: "#f8fafc",
                label: "入門",
                comment: "まずはキーの位置に慣れる段階。キーボード下のガイドを見ながら、1文字ずつ確実に打ちましょう。",
            },
        }
    }
}

/// 1 つのランク：このスコア（`min`）以上で、この名前（`rank`）になる。
#[derive(Debug)]
pub struct ScoreRank {
    pub rank: &'static str,
    pub min: u32,
    pub tier: Tier,
}

const fn r(rank: &'static str, min: u32, tier: Tier) -> ScoreRank {
    ScoreRank { rank, min, tier }
}

/// ランクの表（高い順）。最後の E は 0 から。
pub const SCORE_RANKS: [ScoreRank; 18] = [
    r("SSS", 3400, Tier::S),
    r("SS", 2900, Tier::S),
    r("S+", 2520, Tier::S),
    r("S", 2200, Tier::S),
    r("S-", 1920, Tier::S),
    r("A+", 1680, Tier::A),
    r("A", 1470, Tier::A),
    r("A-", 1280, Tier::A),
    r("B+", 1110, Tier::B),
    r("B", 960, Tier::B),
    r("B-", 820, Tier::B),
    r("C+", 700, Tier::C),
    r("C", 590, Tier::C),
    r("C-", 490, Tier::C),
    r("D+", 400, Tier::D),
    r("D", 320, Tier::D),
    r("D-", 250, Tier::D),
    r("E", 0, Tier::E),
];

/// 記録がない（JS の null）・数でない（NaN）スコアは 0 として扱う（JS の `score || 0`）。
fn or_zero(score: f64) -> f64 {
    if score.is_nan() { 0.0 } else { score }
}

/// そのスコアのランク。
pub fn score_rank(score: f64) -> &'static ScoreRank {
    let s = or_zero(score);
    SCORE_RANKS
        .iter()
        .find(|r| s >= r.min as f64)
        .unwrap_or(&SCORE_RANKS[SCORE_RANKS.len() - 1])
}

/// 次のランク（いちばん上なら `None`）。
pub fn next_rank(score: f64) -> Option<&'static ScoreRank> {
    let s = or_zero(score);
    SCORE_RANKS.iter().rev().find(|r| r.min as f64 > s)
}

// ---------- リズム ----------

/// リズム：止まらずに打てた打鍵の割合。
#[derive(Debug, Clone, PartialEq)]
pub struct Rhythm {
    /// 止まらずに打てた割合（0〜1）。間隔が 10 個より少ないときは `None`。
    pub smooth: Option<f64>,
    /// 止まった回数（その回の間隔の中央値の 2 倍以上かかった打鍵）。
    pub stalls: usize,
    /// 間隔の数。
    pub samples: usize,
    /// スコアに掛ける係数（0.7〜1）。
    pub mul: f64,
}

/// 打鍵の間隔（ミリ秒）の並びから、リズムを求める。長さに左右されない割合で表す。
pub fn compute_rhythm(intervals: &[f64]) -> Rhythm {
    if intervals.len() < 10 {
        return Rhythm {
            smooth: None,
            stalls: 0,
            samples: intervals.len(),
            mul: DEFAULT_RHYTHM_MUL,
        };
    }
    let mut sorted = intervals.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len() / 2;
    let median = if sorted.len() % 2 == 1 {
        sorted[mid]
    } else {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    };
    let stalls = intervals.iter().filter(|&&x| x >= median * 2.0).count();
    let rate = stalls as f64 / intervals.len() as f64;
    Rhythm {
        smooth: Some(1.0 - rate),
        stalls,
        samples: intervals.len(),
        mul: f64::max(0.7, 1.0 - rate),
    }
}

// ---------- スコア ----------

/// スコアと、その内訳。
#[derive(Debug, Clone, PartialEq)]
pub struct CompositeScore {
    /// スコア（整数に丸めたもの）。
    pub score: f64,
    /// 速さの点（文字/分 × 10）。
    pub speed_pts: f64,
    /// 正確さの係数（正確率の 3 乗）。
    pub acc_mul: f64,
    /// リズムの係数。
    pub rhythm_mul: f64,
}

/// スコアを求める。`ref_kpm` は標準打鍵/分、`acc_ratio` は正確率（0〜1）、`rhythm` はリズム（ないときは 0.9 とする）。
pub fn compute_composite_score(ref_kpm: f64, acc_ratio: f64, rhythm: Option<&Rhythm>) -> CompositeScore {
    let speed_pts = (ref_kpm / STANDARD_KEYS_PER_CHAR) * 10.0;
    let acc_mul = acc_ratio.powf(3.0);
    let rhythm_mul = rhythm.map_or(DEFAULT_RHYTHM_MUL, |r| r.mul);
    CompositeScore {
        score: js::round(speed_pts * acc_mul * rhythm_mul),
        speed_pts,
        acc_mul,
        rhythm_mul,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn example_from_the_current_version() {
        // 旧版（v5）で確かめた例（研究メモ）：300 打/分・正確率 97%・12 個の間隔のうち 2 個が止まり
        let rhythm = compute_rhythm(&[120.0, 130.0, 110.0, 400.0, 125.0, 118.0, 122.0, 140.0, 135.0, 128.0, 119.0, 500.0]);
        assert_eq!(rhythm.stalls, 2);
        assert_eq!(compute_composite_score(300.0, 0.97, Some(&rhythm)).score, 1342.0);
    }

    #[test]
    fn ranks() {
        assert_eq!(score_rank(3400.0).rank, "SSS");
        assert_eq!(score_rank(3399.9).rank, "SS");
        assert_eq!(score_rank(f64::NAN).rank, "E");
        assert_eq!(next_rank(0.0).unwrap().rank, "D-");
        assert!(next_rank(3400.0).is_none());
    }
}
