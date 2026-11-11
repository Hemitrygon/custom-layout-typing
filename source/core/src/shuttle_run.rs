//! シャトルランの進み方（旧版（v5）の shuttleBegin・shuttleStartLevel・shuttleLevelCleared・shuttleOnCorrect・
//! shuttleOnMiss・tick・shuttleTimeUp・shuttlePause/Resume を移したもの）。
//!
//! 時刻（`now`。`performance.now()` のミリ秒）と、出題の乱数は外から受ける。画面・音は呼ぶ側が `events` を見て出す。

use crate::kana::{Style, Word};
use crate::layout::{KeyboardType, Layout};
use crate::shuttle::{self, Freeze, LevelRecord, SH_RULES, ShuttleRecord};
use crate::typing::{Lang, Outcome, Session};

/// 今の段階。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// 始める前（この配列で文を打てずにやめたときも）。
    Intro,
    Run,
    Paused,
    /// 時間切れで終わった。
    Over,
}

/// 画面に知らせること。
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// 新しいステージ（5 レベルごと）。
    Stage(i32),
    /// 連続正解で時間が増えた。
    ComboBonus,
    /// ミスで時間が減った（秒）。
    MissPenalty(f64),
    /// シールドの後の無敵の時間なので、ミスを数えなかった。
    Guard,
    /// シールドをもらった（今の数）。
    ShieldGot(u32),
    /// レベルをクリアした（ミスなしか・持ち越す秒数）。
    LevelCleared { perfect: bool, carry: f64 },
    /// 分けて出した文の、次の部分へ。
    PartCleared,
    /// シールドで時間切れを防いだ。
    ShieldUsed,
    /// 時間切れで終わった。
    TimeUp,
    /// この配列では文を打てないので、やめた。
    Untypeable,
}

/// シャトルラン 1 回。
pub struct ShuttleRun {
    pub session: Session,
    /// 文ごとの（何番目の部分か, いくつに分けたか）。
    pub(crate) parts: Vec<(usize, usize)>,
    pub phase: Phase,
    pub level: i32,
    used: Vec<usize>,
    carry: f64,
    /// クリアしたレベル（と時間切れのレベル）の記録。
    pub records: Vec<LevelRecord>,
    pub(crate) perfect_streak: u32,
    pub shields: u32,
    pub(crate) combo_count: u32,
    skip_guard: u32,
    /// 時計が止まる時間。
    pub freezes: Vec<Freeze>,
    shields_got: u32,
    saves: u32,
    /// このレベルの基準の制限時間（秒）と、持ち越した秒数、制限時間（時間のバーの長さ）。
    pub level_base: f64,
    pub carry_in: f64,
    pub limit: f64,
    pub level_misses: u32,
    shield_used: bool,
    pub level_start_at: f64,
    /// 時間切れになる時刻。
    pub deadline: f64,
    pub started_at: f64,
    paused_at: f64,
    random: Box<dyn FnMut() -> f64>,
    /// 画面に知らせることがたまる。呼ぶ側が取り出して空にする。
    pub events: Vec<Event>,
}

fn words_of(picked: &[shuttle::PickedPart]) -> Vec<Word> {
    picked
        .iter()
        .map(|p| Word {
            kanji: p.kanji.clone(),
            kana: p.kana.clone(),
            romaji: String::new(),
            is_custom_romaji: false,
        })
        .collect()
}

/// 小数 2 桁に丸める（旧版（v5）の round2）。
fn round2(x: f64) -> f64 {
    crate::js::round(x * 100.0) / 100.0
}

impl ShuttleRun {
    /// 始める（旧版（v5）の shuttleBegin）。`random` は出題の乱数（0 以上 1 未満）。
    pub fn begin(layout: Layout, kind: KeyboardType, style: Style, now: f64, mut random: Box<dyn FnMut() -> f64>) -> ShuttleRun {
        let mut used = Vec::new();
        let first = shuttle::pick(1, &mut used, &mut *random);
        let words = words_of(&first);
        let n = words.len();
        let session = Session::with_auto_advance(words, vec![Some(Lang::Ja); n], Lang::Ja, style, layout, kind, false);
        let mut run = ShuttleRun {
            session,
            parts: first.iter().map(|p| (p.part, p.parts)).collect(),
            phase: Phase::Run,
            level: 1,
            used,
            carry: 0.0,
            records: Vec::new(),
            perfect_streak: 0,
            shields: 0,
            combo_count: 0,
            skip_guard: 0,
            freezes: Vec::new(),
            shields_got: 0,
            saves: 0,
            level_base: 0.0,
            carry_in: 0.0,
            limit: 0.0,
            level_misses: 0,
            shield_used: false,
            level_start_at: now,
            deadline: now,
            started_at: now,
            paused_at: 0.0,
            random,
            events: Vec::new(),
        };
        if run.load_word() {
            run.start_level(now);
        }
        run
    }

    fn push_pick(&mut self) {
        let picked = shuttle::pick(self.level, &mut self.used, &mut *self.random);
        self.parts.extend(picked.iter().map(|p| (p.part, p.parts)));
        self.session.push_words(words_of(&picked), Some(Lang::Ja));
    }

    /// 今の文を読む。打てない文は飛ばして次を引く（25 回続いたら、この配列では無理としてやめる）。
    fn load_word(&mut self) -> bool {
        loop {
            if self.session.load_current_word() {
                return true;
            }
            if self.phase != Phase::Run {
                return false;
            }
            self.skip_guard += 1;
            if self.skip_guard > 25 {
                self.phase = Phase::Intro;
                self.events.push(Event::Untypeable);
                return false;
            }
            self.push_pick();
        }
    }

    /// 今のレベルの文（分けた部分すべて）の標準打鍵数。
    fn level_keys(&self) -> usize {
        let words = &self.session.words;
        let last_parts = self.parts.last().map_or(1, |p| p.1.max(1));
        let from = words.len().saturating_sub(last_parts);
        words[from..]
            .iter()
            .map(|w| crate::js::len16(&crate::kana::primary_romaji(&w.kana, Style::Nihon)))
            .sum()
    }

    fn start_level(&mut self, now: f64) {
        let keys = self.level_keys().max(1);
        self.level_base = shuttle::base_limit(self.level, keys as f64);
        self.carry_in = self.carry;
        self.limit = self.level_base + self.carry_in;
        self.carry = 0.0;
        self.level_misses = 0;
        self.shield_used = false;
        self.level_start_at = now;
        // 無敵の残りは、そのレベルで終わる
        for f in &mut self.freezes {
            if f.end > now {
                f.end = f.start.max(now);
            }
        }
        self.deadline = now + self.limit * 1000.0;
        if self.level > 1 && (self.level - 1) % SH_RULES.levels_per_stage == 0 {
            self.events.push(Event::Stage(shuttle::stage_of(self.level)));
        }
    }

    /// シールドの後の無敵の時間か。
    pub fn guarding(&self, now: f64) -> bool {
        self.phase == Phase::Run && shuttle::freeze_at(&self.freezes, now).is_some_and(|f| f.invincible)
    }

    /// 残りの秒数。
    pub fn time_left(&self, now: f64) -> f64 {
        shuttle::time_left(self.deadline, &self.freezes, now)
    }

    /// 1 文字を打つ。
    pub fn input(&mut self, ch: &str, code: Option<&str>, now: f64) -> Outcome {
        if self.phase != Phase::Run {
            return Outcome::NotTyping;
        }
        let guarding = self.guarding(now);
        let out = self.session.input(ch, code, now, guarding);
        match &out {
            Outcome::Correct { sentence_done, .. } => {
                self.on_correct(now);
                if *sentence_done {
                    let (part, parts) = self.parts.get(self.session.word_index).copied().unwrap_or((0, 1));
                    if parts > 1 && part < parts - 1 {
                        self.part_cleared();
                    } else {
                        self.level_cleared(now);
                    }
                }
            }
            Outcome::Mistake { .. } => self.on_miss(now),
            Outcome::Guarded => self.events.push(Event::Guard),
            _ => {}
        }
        out
    }

    fn on_correct(&mut self, now: f64) {
        self.combo_count += 1;
        if self.combo_count >= SH_RULES.combo_every {
            self.combo_count = 0;
            self.add_time(SH_RULES.combo_bonus, now);
            self.events.push(Event::ComboBonus);
        }
    }

    fn on_miss(&mut self, now: f64) {
        self.level_misses += 1;
        self.combo_count = 0;
        let p = if self.level_misses > SH_RULES.heavy_after {
            SH_RULES.miss_penalty_heavy
        } else {
            SH_RULES.miss_penalty
        };
        self.add_time(-p, now);
        self.events.push(Event::MissPenalty(p));
    }

    fn add_time(&mut self, sec: f64, now: f64) {
        self.deadline += sec * 1000.0;
        if sec > 0.0 {
            // 時間のバーは、このレベルでいちばん多かった残り時間に対して測る
            let rem = self.time_left(now);
            if rem > self.limit {
                self.limit = rem;
            }
        }
    }

    /// このレベルでかかった時間（無敵の時間を除く。秒）。
    fn used_sec(&self, now: f64) -> f64 {
        (now - self.level_start_at - shuttle::frozen_ms(&self.freezes, self.level_start_at, now)) / 1000.0
    }

    fn part_cleared(&mut self) {
        self.session.word_index += 1;
        if self.load_word() {
            self.events.push(Event::PartCleared);
        }
    }

    fn level_cleared(&mut self, now: f64) {
        let rem = self.time_left(now).max(0.0);
        let perfect = self.level_misses == 0;
        self.records.push(LevelRecord {
            lv: self.level as f64,
            limit: round2(self.limit),
            used: round2(self.used_sec(now)),
            miss: self.level_misses as f64,
            fail: false,
        });
        let mut carry = f64::min(SH_RULES.carry_max, rem * SH_RULES.carry_rate);
        if perfect {
            carry += SH_RULES.perfect_bonus;
            self.perfect_streak += 1;
            if self.perfect_streak >= SH_RULES.shield_streak {
                self.perfect_streak = 0;
                if self.shields < SH_RULES.shield_max {
                    self.shields += 1;
                    self.shields_got += 1;
                    self.events.push(Event::ShieldGot(self.shields));
                }
            }
        } else {
            self.perfect_streak = 0;
        }
        self.carry = carry;
        self.events.push(Event::LevelCleared { perfect, carry });
        self.level += 1;
        self.skip_guard = 0;
        self.session.word_index += 1;
        self.push_pick();
        if self.load_word() && self.phase == Phase::Run {
            self.start_level(now);
        }
    }

    /// 時計を進める（旧版（v5）は毎フレーム）。時間切れなら、シールドがあれば使い、なければ終わる。
    pub fn tick(&mut self, now: f64) {
        if self.phase != Phase::Run || self.time_left(now) > 0.0 {
            return;
        }
        if self.shields > 0 {
            self.shields -= 1;
            self.shield_used = true;
            self.saves += 1;
            let refill = self.level_base * SH_RULES.shield_refill;
            let inv = SH_RULES.invincible_sec;
            // 止まっている時間の後から始める（2 つが重ならないように）
            let from = shuttle::freeze_at(&self.freezes, now).map_or(now, |f| f.end);
            self.freezes.push(Freeze {
                start: from,
                end: from + inv * 1000.0,
                invincible: true,
            });
            self.deadline = from + (inv + refill) * 1000.0;
            self.limit = self.limit.max(refill);
            self.events.push(Event::ShieldUsed);
        } else {
            self.time_up(now);
        }
    }

    fn time_up(&mut self, now: f64) {
        self.phase = Phase::Over;
        self.records.push(LevelRecord {
            lv: self.level as f64,
            limit: round2(self.limit),
            used: round2(self.used_sec(now)),
            miss: self.level_misses as f64,
            fail: true,
        });
        self.events.push(Event::TimeUp);
    }

    /// 終わった回の記録を作る（旧版（v5）の shuttleTimeUp の中）。`id` と `timestamp` は呼ぶ側が作る。
    pub fn record(&self, id: &str, timestamp: f64, now: f64, layout_name: &str) -> ShuttleRecord {
        let s = &self.session;
        let total = s.correct + s.mistakes;
        // 速さは、時計が動いていた時間だけで測る
        let active_min = f64::max(
            (now - self.started_at - shuttle::frozen_ms(&self.freezes, self.started_at, now)) / 60000.0,
            0.005,
        );
        ShuttleRecord {
            id: id.into(),
            timestamp,
            level: self.level as f64,
            cleared: (self.level - 1) as f64,
            keys: s.correct as f64,
            misses: s.mistakes as f64,
            accuracy: if total > 0 {
                crate::js::round(s.correct as f64 / total as f64 * 1000.0) / 10.0
            } else {
                100.0
            },
            max_combo: s.max_combo as f64,
            kpm: crate::js::round(s.correct as f64 / active_min),
            duration_sec: crate::js::round((now - self.started_at) / 100.0) / 10.0,
            layout_name: layout_name.into(),
            romaji_style: s.style.as_str().into(),
            shields: self.shields_got as f64,
            saves: self.saves as f64,
            levels: self.records.iter().take(80).cloned().collect(),
        }
    }

    /// 一時停止。
    pub fn pause(&mut self, now: f64) {
        if self.phase != Phase::Run {
            return;
        }
        self.phase = Phase::Paused;
        self.paused_at = now;
    }

    /// 続ける。止めていた時間だけ、時刻をずらす（止めている間に始まっていた無敵の時間は、前後に分ける）。
    pub fn resume(&mut self, now: f64) {
        if self.phase != Phase::Paused {
            return;
        }
        let d = now - self.paused_at;
        let mut later = Vec::new();
        for f in &mut self.freezes {
            if f.start >= self.paused_at {
                f.start += d;
                f.end += d;
            } else if f.end > self.paused_at {
                later.push(Freeze {
                    start: self.paused_at + d,
                    end: f.end + d,
                    invincible: f.invincible,
                });
                f.end = self.paused_at;
            }
        }
        self.freezes.extend(later);
        self.deadline += d;
        self.level_start_at += d;
        self.started_at += d;
        self.phase = Phase::Run;
        self.session.reset_rhythm_anchor();
    }

    /// やめる（始める前の画面へ）。
    pub fn quit(&mut self) {
        self.phase = Phase::Intro;
    }
}
