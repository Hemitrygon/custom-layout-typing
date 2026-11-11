//! シャトルランの式・練習文・記録の形（旧版（v5）の「shuttle run」「records」から）。
//! 遊んでいる最中の進み方は `shuttle_run.rs`。

use crate::js;
use crate::kana::{self, Style};
use serde_json::{Value, json};
use std::sync::OnceLock;

/// シャトルランのルール。
#[derive(Debug, Clone, PartialEq)]
pub struct ShuttleRules {
    /// レベル 1 で要る速さ（打/秒）。
    pub start_kps: f64,
    /// 1 レベルごとに速さが何倍になるか（`late_from` より前）。
    pub growth: f64,
    /// 同じく `late_from` から。
    pub growth_late: f64,
    pub late_from: i32,
    /// この打数を続けてミスなしで打つと……
    pub combo_every: u32,
    /// ……この秒数が足される。
    pub combo_bonus: f64,
    /// 1 回のミスで減る秒数。
    pub miss_penalty: f64,
    /// 同じレベルで `heavy_after` 回を超えたミスで減る秒数。
    pub miss_penalty_heavy: f64,
    pub heavy_after: u32,
    /// 残り時間のうち、次のレベルに持ち越す割合……
    pub carry_rate: f64,
    /// ……と、その上限（秒）。
    pub carry_max: f64,
    /// ミスのないレベルの次に足される秒数。
    pub perfect_bonus: f64,
    /// ミスのないレベルがこれだけ続くとシールドがもらえる。
    pub shield_streak: u32,
    /// 持てるシールドの数。
    pub shield_max: u32,
    /// シールドが補う時間（そのレベルの基準の時間に対する割合）。
    pub shield_refill: f64,
    /// シールドの後、時計が止まりミスを数えない秒数。
    pub invincible_sec: f64,
    /// このレベルから、長い文を 2 つに分けて出す。
    pub two_parts_from: i32,
    /// このレベルから 3 つに。
    pub three_parts_from: i32,
    /// 1 ステージのレベルの数。
    pub levels_per_stage: i32,
}

pub const SH_RULES: ShuttleRules = ShuttleRules {
    start_kps: 0.8,
    growth: 1.08,
    growth_late: 1.07,
    late_from: 16,
    combo_every: 20,
    combo_bonus: 0.5,
    miss_penalty: 0.2,
    miss_penalty_heavy: 0.4,
    heavy_after: 3,
    carry_rate: 0.3,
    carry_max: 3.0,
    perfect_bonus: 0.5,
    shield_streak: 3,
    shield_max: 2,
    shield_refill: 0.5,
    invincible_sec: 3.0,
    two_parts_from: 18,
    three_parts_from: 31,
    levels_per_stage: 5,
};

// ---------- レベルごとの式 ----------

/// そのレベルで出す文の、目安の打鍵数。レベル 31 まで伸び、その後は少しだけ伸びる。
pub fn target_keys(level: i32) -> f64 {
    let l = level as f64;
    if level <= 31 {
        f64::min(61.0, 10.0 + 1.8 * (l - 1.0))
    } else {
        f64::min(67.0, 61.0 + 0.6 * (l - 31.0))
    }
}

/// 文を読む時間として足す秒数。
pub fn read_time(level: i32) -> f64 {
    f64::max(0.6, 2.0 - 0.05 * (level as f64 - 1.0))
}

/// そのレベルで要る速さ（打/秒）。
pub fn kps(level: i32) -> f64 {
    let r = &SH_RULES;
    let early = level.min(r.late_from - 1) - 1;
    let late = (level - r.late_from + 1).max(0);
    r.start_kps * r.growth.powf(early as f64) * r.growth_late.powf(late as f64)
}

/// 制限時間の基準（秒）＝ 読む時間 ＋ 打鍵数 ÷ 要る速さ。
pub fn base_limit(level: i32, keys: f64) -> f64 {
    read_time(level) + keys / kps(level)
}

/// そのレベルのステージ（1 から）。
pub fn stage_of(level: i32) -> i32 {
    (level - 1).div_euclid(SH_RULES.levels_per_stage) + 1
}

/// そのレベルで文をいくつに分けて出すか（1〜3）。
pub fn parts_for(level: i32) -> usize {
    if level >= SH_RULES.three_parts_from {
        3
    } else if level >= SH_RULES.two_parts_from {
        2
    } else {
        1
    }
}

// ---------- 文を分ける ----------

/// 文を「、」のところで `n` 個に分ける。読みの長さがいちばんそろう分け方を選ぶ（同じなら先に見つけた方）。
/// 分けられない（`n` が 1 以下、「、」が足りない、表記と読みで「、」の数が違う）ときは、文をそのまま 1 つで返す。
/// 戻り値は（表記, 読み）の並び。切ったところの「、」は消える。
pub fn split(kanji: &str, kana: &str, n: usize) -> Vec<(String, String)> {
    let ks: Vec<&str> = kanji.split('、').collect();
    let rs: Vec<&str> = kana.split('、').collect();
    if n <= 1 || ks.len() < n || ks.len() != rs.len() {
        return vec![(kanji.to_string(), kana.to_string())];
    }
    // 区切りの間の読みの長さ（JS の length ＝ UTF-16 の単位で数える）
    let seg_len: Vec<usize> = rs.iter().map(|s| js::len16(s)).collect();

    struct Search<'a> {
        seg_len: &'a [usize],
        cuts: Vec<usize>,
        best: Option<(usize, Vec<usize>)>,
    }
    impl Search<'_> {
        fn walk(&mut self, from: usize, left: usize) {
            let segs = self.seg_len.len();
            if left == 0 {
                let mut edges = Vec::with_capacity(self.cuts.len() + 2);
                edges.push(0);
                edges.extend_from_slice(&self.cuts);
                edges.push(segs);
                let worst = edges
                    .windows(2)
                    .map(|w| self.seg_len[w[0]..w[1]].iter().sum::<usize>())
                    .max()
                    .unwrap_or(0);
                if self.best.as_ref().is_none_or(|(b, _)| worst < *b) {
                    self.best = Some((worst, edges));
                }
                return;
            }
            for c in from..=(segs - left) {
                self.cuts.push(c);
                self.walk(c + 1, left - 1);
                self.cuts.pop();
            }
        }
    }
    let mut search = Search {
        seg_len: &seg_len,
        cuts: Vec::new(),
        best: None,
    };
    search.walk(1, n - 1);
    let edges = search.best.expect("ks.len() >= n なので、少なくとも 1 つは分け方がある").1;
    edges
        .windows(2)
        .map(|w| (ks[w[0]..w[1]].join("、"), rs[w[0]..w[1]].join("、")))
        .collect()
}

// ---------- 時計が止まる時間 ----------

/// 時計が止まる時間（`performance.now()` のミリ秒）。シールドの後の無敵の時間なら `invincible`。
#[derive(Debug, Clone, PartialEq)]
pub struct Freeze {
    pub start: f64,
    pub end: f64,
    pub invincible: bool,
}

/// `from`〜`to` のうち、時計が止まっていたミリ秒（`to` は `f64::INFINITY` でもよい）。
pub fn frozen_ms(freezes: &[Freeze], from: f64, to: f64) -> f64 {
    freezes
        .iter()
        .map(|f| {
            let x = f64::max(from, f.start);
            let y = f64::min(to, f.end);
            if y > x { y - x } else { 0.0 }
        })
        .sum()
}

/// `now` に時計を止めている区間（なければ `None`）。
pub fn freeze_at(freezes: &[Freeze], now: f64) -> Option<&Freeze> {
    freezes.iter().find(|f| now >= f.start && now < f.end)
}

/// 残りの秒数（これから止まる時間は数えない。負にもなる）。
pub fn time_left(deadline: f64, freezes: &[Freeze], now: f64) -> f64 {
    (deadline - now - frozen_ms(freezes, now, f64::INFINITY)) / 1000.0
}

// ---------- 記録 ----------

/// 1 レベルの結果（トロフィーの判定に使う分だけ）。
#[derive(Debug, Clone, PartialEq)]
pub struct LevelMark {
    /// 時間切れになったか。
    pub fail: bool,
    /// ミスの数。
    pub miss: u32,
}

/// 時間切れもミスもないレベルが、いちばん長く続いた数。
pub fn perfect_run(levels: &[LevelMark]) -> u32 {
    let (mut best, mut cur) = (0, 0);
    for l in levels {
        if !l.fail && l.miss == 0 {
            cur += 1;
            best = best.max(cur);
        } else {
            cur = 0;
        }
    }
    best
}

// ---------- 練習文 ----------

/// シャトルランの練習文（表記, よみ）。旧版（v5）から取り出したもの（core/data/shuttle_pool.json。golden/generate.mjs data で作り直す）。
pub fn pool() -> &'static [(String, String)] {
    static POOL: OnceLock<Vec<(String, String)>> = OnceLock::new();
    POOL.get_or_init(|| {
        let v: Vec<Value> = serde_json::from_str(include_str!("../data/shuttle_pool.json")).expect("shuttle_pool.json は JSON の配列");
        v.iter()
            .map(|p| (p[0].as_str().unwrap().to_string(), p[1].as_str().unwrap().to_string()))
            .collect()
    })
}

/// 練習文ごとの標準打鍵数（訓令式のローマ字の長さ。流儀の設定によらない）。
pub fn pool_key_counts() -> &'static [usize] {
    static COUNTS: OnceLock<Vec<usize>> = OnceLock::new();
    COUNTS.get_or_init(|| {
        pool()
            .iter()
            .map(|(_, kana)| js::len16(&kana::primary_romaji(kana, Style::Nihon)))
            .collect()
    })
}

/// 文を切れるところの数：表記にも読みにも、同じ数だけある「、」（数が違えば 0）。
pub fn comma_count(i: usize) -> usize {
    let (kanji, kana) = &pool()[i];
    let n = kanji.matches('、').count();
    if n == kana.matches('、').count() { n } else { 0 }
}

/// 出題する文 1 つ（分けて出すときは、そのうちの 1 つ）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickedPart {
    pub kanji: String,
    pub kana: String,
    pub part: usize,
    pub parts: usize,
}

/// レベルに合った長さの、この回でまだ使っていない文を選ぶ（旧版（v5）の shuttlePick）。`used` に足す。
/// `random` は 0 以上 1 未満の乱数（旧版（v5）は Math.random）。長い文は「、」で分けて出す。
pub fn pick(level: i32, used: &mut Vec<usize>, random: &mut dyn FnMut() -> f64) -> Vec<PickedPart> {
    let counts = pool_key_counts();
    if used.len() >= pool().len() {
        used.clear();
    }
    let target = target_keys(level);
    let want = parts_for(level);
    let mut free: Vec<usize> = (0..counts.len()).filter(|i| !used.contains(i)).collect();
    let mut cands: Vec<usize> = free.iter().copied().filter(|&i| (counts[i] as f64 - target).abs() <= 3.0).collect();
    // レベルが求める数に分けられる文が十分あれば、そちらから
    let cuttable: Vec<usize> = cands.iter().copied().filter(|&i| comma_count(i) + 1 >= want).collect();
    if cuttable.len() >= 2 {
        cands = cuttable;
    }
    if cands.len() < 2 {
        free.sort_by(|&a, &b| (counts[a] as f64 - target).abs().total_cmp(&(counts[b] as f64 - target).abs()));
        cands = free.into_iter().take(4).collect();
    }
    let idx = cands[(random() * cands.len() as f64).floor() as usize];
    used.push(idx);
    let (kanji, kana) = &pool()[idx];
    let parts = split(kanji, kana, want.min(comma_count(idx) + 1));
    let n = parts.len();
    parts
        .into_iter()
        .enumerate()
        .map(|(i, (kanji, kana))| PickedPart {
            kanji,
            kana,
            part: i,
            parts: n,
        })
        .collect()
}

// ---------- 記録 ----------

/// 1 レベルの記録。
#[derive(Debug, Clone, PartialEq)]
pub struct LevelRecord {
    pub lv: f64,
    /// 制限時間（秒。小数 2 桁）。
    pub limit: f64,
    /// かかった時間（秒。無敵の時間を除く。小数 2 桁）。
    pub used: f64,
    pub miss: f64,
    /// 時間切れ。
    pub fail: bool,
}

/// シャトルラン 1 回の記録（保存する形）。
#[derive(Debug, Clone, PartialEq)]
pub struct ShuttleRecord {
    pub id: String,
    pub timestamp: f64,
    /// 時間切れになったレベル。
    pub level: f64,
    /// クリアしたレベルの数。
    pub cleared: f64,
    pub keys: f64,
    pub misses: f64,
    /// 正確率（%。小数 1 桁）。
    pub accuracy: f64,
    pub max_combo: f64,
    /// 打鍵/分（時計が止まっていた時間を除く）。
    pub kpm: f64,
    pub duration_sec: f64,
    pub layout_name: String,
    pub romaji_style: String,
    /// もらったシールドの数、シールドで持ちこたえた数。
    pub shields: f64,
    pub saves: f64,
    pub levels: Vec<LevelRecord>,
}

impl ShuttleRecord {
    pub fn to_json(&self) -> Value {
        let n = crate::records::num;
        json!({
            "id": self.id, "timestamp": n(self.timestamp), "level": n(self.level), "cleared": n(self.cleared), "keys": n(self.keys),
            "misses": n(self.misses), "accuracy": n(self.accuracy), "maxCombo": n(self.max_combo), "kpm": n(self.kpm),
            "durationSec": n(self.duration_sec), "layoutName": self.layout_name, "romajiStyle": self.romaji_style,
            "shields": n(self.shields), "saves": n(self.saves),
            "levels": self.levels.iter().map(|l| json!({ "lv": n(l.lv), "limit": n(l.limit), "used": n(l.used), "miss": n(l.miss), "fail": l.fail })).collect::<Vec<_>>(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_is_loaded() {
        assert_eq!(pool().len(), 821);
        assert_eq!(pool()[0], ("青い空".to_string(), "あおいそら".to_string()));
        assert_eq!(pool_key_counts()[0], 7); // AOISORA
    }

    #[test]
    fn split_evenly() {
        // 読みの長さ [1, 2, 1]：「あ｜いい、う」も「あ、いい｜う」も最長 3 で同点。先に見つけた方を選ぶ
        let parts = split("あ、いい、う", "あ、いい、う", 2);
        assert_eq!(parts, vec![("あ".into(), "あ".into()), ("いい、う".into(), "いい、う".into())]);
        let parts = split("ああ、い、う", "ああ、い、う", 2);
        assert_eq!(parts, vec![("ああ".into(), "ああ".into()), ("い、う".into(), "い、う".into())]);
        assert_eq!(split("一つ", "ひとつ", 2).len(), 1);
    }

    #[test]
    fn frozen_time() {
        let f = [Freeze {
            start: 100.0,
            end: 200.0,
            invincible: true,
        }];
        assert_eq!(frozen_ms(&f, 150.0, f64::INFINITY), 50.0);
        assert!(freeze_at(&f, 199.0).unwrap().invincible);
        assert_eq!(time_left(1150.0, &f, 150.0), 0.95);
    }
}
