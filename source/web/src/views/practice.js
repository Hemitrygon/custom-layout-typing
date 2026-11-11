// 練習の画面：待機 → カウントダウン → 練習 → 一時停止 → 結果。
// 文と数字は HTML、キーボードのガイド（次のキー・押したキー・ミスの多いキー）は 3D の舞台が受け持つ。
// 判定は Rust の TypingSession。流れ：KeyReader.resolve(e) → chooseInputChar → input。
import { core, TypingSession } from '../core.js';
import { S, bus, guideFor, courseInfo, sessionWords, sessionSize, isMix, currentPreset, currentWords, groupById, presetById,
  selectPreset, startPlaylist, setPlaylistOrder, playlistJump, playlistAdvance, nextTrackName, syncPlaylist, selectLayout, recordScore,
  BUILTIN_LAYOUT_KEYS, CUSTOM_SLOT_KEYS, slotHasData, ORDER_LABELS } from '../model.js';
import { newId } from '../store.js';
import { $, html, raw, setHtml, act, countUp } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast, openPop } from '../ui/overlay.js';
import { playSound } from '../sound.js';
import { FINGERS } from '../theme.js';
import { flatKeyboard } from '../ui/flatkb.js';
import { showText3d } from '../scene/score3d.js';

const P = {
  screen: 'start',          // 'start' | 'empty' | 'countdown' | 'typing' | 'paused' | 'result'
  session: null,
  meta: null,
  startTime: 0,
  pausedAt: 0,
  timer: 0,
  statTimer: 0,
  virtualShift: {},
  result: null,
  remap: { hits: 0, shown: false },
  targets: [],                // 次に押すキー（平面のガイドにも出す）
};
let ctx = null;             // {stage, switchTab, openShuttle, maybeBackupReminder, openCalibration}

export const practiceScreen = () => P.screen;
export const practiceBusy = () => P.screen === 'countdown' || P.screen === 'typing' || P.screen === 'paused';

// ---------- 画面の骨組み ----------

export function mountPractice(root, context) {
  ctx = context;
  setHtml(root, html`
    <div class="p-stage" id="pStage">
      <div class="p-screen" data-screen="start" id="pStart"></div>
      <div class="p-screen" data-screen="empty" hidden>
        <div class="p-empty">
          <p class="p-empty-title">練習文がありません</p>
          <p class="muted">このプリセットにはまだ文が登録されていません</p>
          <button class="btn btn-primary" data-act="nav" data-arg="words">練習文を編集する</button>
        </div>
      </div>
      <div class="p-screen" data-screen="countdown" hidden><div class="p-count num" id="pCount">3</div></div>
      <div class="p-screen" data-screen="typing" hidden>
        <div class="p-hud" id="pHud">
          <div class="p-track" id="pTrack"></div>
          <div class="p-stats">
            <span><i>進行</i><b class="num" id="stProgress">0/0</b></span>
            <span><i>WPM</i><b class="num" id="stWpm">0</b></span>
            <span><i>正確率</i><b class="num" id="stAcc">100.0%</b></span>
            <span><i>連続</i><b class="num" id="stCombo">0</b></span>
          </div>
          <button class="btn btn-s btn-ghost" data-act="practice.pause" id="pPauseBtn">${icon.pause}<span>一時停止</span></button>
        </div>
        <div class="p-progress"><div id="pProgressBar"></div></div>
        <div class="p-prompt" id="pPrompt">
          <div class="p-kana" id="pKana"></div>
          <div class="p-kanji" id="pKanji"></div>
          <div class="p-romaji mono" id="pRomaji"></div>
        </div>
        <div class="p-miss mono" id="pMiss"></div>
      </div>
      <div class="p-screen" data-screen="paused" hidden>
        <div class="p-paused">
          <p class="eyebrow">PAUSED</p>
          <p class="p-paused-title">一時停止中</p>
          <div class="row wrap p-center">
            <button class="btn btn-primary btn-l" data-act="practice.resume"><kbd>Space</kbd>再開する</button>
            <button class="btn btn-l" data-act="practice.restart"><kbd class="esc-hint">Esc</kbd>最初からやり直す</button>
            <button class="btn btn-ghost btn-l" data-act="practice.quit">待機画面へ</button>
          </div>
        </div>
      </div>
      <div class="p-screen" data-screen="result" id="pResult" hidden></div>
    </div>
    <div class="p-slot" id="kbSlot" aria-hidden="true"><div class="p-flat" id="pFlat" hidden></div></div>
    <div class="p-foot" id="pFoot">
      <div class="fingers" id="pFingers"></div>
    </div>`);

  act({
    'practice.start': () => startCountdown(),
    'practice.pause': () => pause(),
    'practice.resume': () => resume(),
    'practice.restart': () => startCountdown(),
    'practice.quit': () => resetToStart(),
    'practice.next': () => next(),
    'practice.shuffle': () => toggleShuffle(),
    'practice.pickLayout': (_, node) => openLayoutMenu(node),
    'practice.pickSource': (_, node) => openSourceMenu(node),
    'practice.order': (arg) => { abandonForNewSelection(); const msg = setPlaylistOrder(arg); if (msg) toast(msg); if (P.screen === 'result') resetToStart(); },
    'practice.jump': (arg) => { abandonForNewSelection(); playlistJump(Number(arg)); },
    'practice.detail': () => { const d = $('#resDetail'); if (d) d.hidden = !d.hidden; },
  });

  bus.on('layout', () => { abandonForNewSelection(); refreshIdle(); renderFlat(); });
  bus.on('source', () => refreshIdle());
  bus.on('reader', () => applyStage());
  bus.on('words', () => refreshIdle());
  bus.on('settings', (key) => {
    renderFingers();
    renderFlat();
    if (P.screen === 'typing') { renderSentence(); }
    if (key === 'romajiStyle') { abandonForNewSelection(); refreshIdle(); }
  });
  renderFingers();
  renderFlat();
  show(currentWords().length ? 'start' : 'empty');
}

function show(screen) {
  P.screen = screen;
  for (const node of document.querySelectorAll('#pStage .p-screen')) node.hidden = node.dataset.screen !== screen;
  document.body.dataset.pscreen = screen;
  if (screen === 'start') renderStart();
  applyStage();
}

/** 舞台（カメラ・光・次のキー）を、今の画面に合わせる。 */
export function applyStage() {
  if (!ctx || !ctx.isActive()) return;
  const st = ctx.stage;
  const focus = P.screen === 'typing' || P.screen === 'countdown' || P.screen === 'paused';
  document.body.dataset.focus = focus && S.settings.minimalMode ? '1' : '0';
  // キーボード調整で Esc が文字の位置に来ているときは、Esc で一時停止できない：最小構成でも「一時停止」ボタンを残し、Esc の案内を消す
  document.body.dataset.esc = S.reader && S.reader.escapeIsTypedKey() ? 'typed' : '';
  if (P.screen === 'result') { st.setPose('result', 1.4); st.setMood('studio'); }
  else if (focus) { st.setPose('typing', 1.1); st.setMood('focus'); }
  else { st.setPose('home', 1.3); st.setMood('studio'); }
  if (P.screen !== 'result') st.setHeat({});
  if (ctx.syncSlot) ctx.syncSlot();   // 画面ごとに、キーボードの枠を合わせ直す（結果の画面は固定の枠）
  updateGuide();
}

function refreshIdle() {
  if (P.screen === 'start' || P.screen === 'empty') show(sessionSize() ? 'start' : 'empty');
}

// ---------- 待機の画面 ----------

function renderStart() {
  const pl = S.playlist;
  const g = pl ? groupById(pl.groupId) : null;
  const preset = currentPreset();
  const mix = isMix() ? pl.mix : null;
  const title = g ? g.name : preset ? preset.name : 'プリセット';
  const count = sessionSize();
  const style = S.romajiStyle === 'hepburn' ? 'ヘボン式' : '日本式';
  const lang = preset && preset.lang === 'en' && !mix ? '英文' : style + 'ローマ字';
  const sub = g
    ? (mix ? '全シャッフル ・ ' + (mix.cursor + 1) + '〜' + Math.min(mix.cursor + mix.size, mix.pool.length) + ' / ' + mix.pool.length + ' 文' : 'グループ ・ ' + (pl.pos + 1) + ' / ' + pl.queue.length + ' ・ ' + (preset ? preset.name : ''))
    : (preset && preset.themeHint && preset.themeHint !== 'カスタム' ? preset.themeHint + ' ・ ' : '') + count + ' 文';
  const best = bestShuttle();
  setHtml('#pStart', html`
    <div class="p-hero">
      <button class="p-layout" data-act="practice.pickLayout" aria-haspopup="listbox" aria-expanded="false">
        <span class="p-layout-dot"></span><span>${S.layout.name}</span>${S.layoutDirty ? html`<span class="faint">（編集中）</span>` : ''}${icon.chevron}
      </button>
      <button class="p-title" data-act="practice.pickSource" aria-haspopup="listbox" aria-expanded="false">
        <span>${title}</span>${icon.chevron}
      </button>
      <p class="p-sub">${sub} ・ ${lang}</p>
      ${g ? html`
        <div class="p-playlist">
          <div class="seg" role="group" aria-label="練習の順番">
            ${['seq', 'shuffle', 'mix'].map((o) => html`<button data-act="practice.order" data-arg="${o}" aria-pressed="${pl.order === o}" title="${ORDER_TIPS[o]}">${o === 'seq' ? '順番に' : ORDER_LABELS[o]}</button>`)}
          </div>
          ${mix ? html`<p class="p-note">${pl.queue.length} 個のプリセットの計 ${mix.pool.length} 文を混ぜ、${mix.size} 文ずつ練習します</p>`
            : html`<div class="p-tracks">${pl.queue.map((pid, i) => { const p = presetById(pid); return html`<button class="p-trackchip" data-act="practice.jump" data-arg="${i}" data-state="${i === pl.pos ? 'now' : i < pl.pos ? 'done' : 'todo'}" title="ここから練習"><i class="num">${i + 1}</i>${p ? p.name : '?'}</button>`; })}</div>`}
        </div>` : ''}
      <button class="p-start" data-act="practice.start" id="pStartBtn">
        <span class="p-space">Space</span><span>を押して始める</span>
      </button>
      <div class="p-links">
        ${mix ? '' : html`<button class="p-link" data-act="practice.shuffle" aria-pressed="${S.sentenceShuffle}">${icon.shuffle}<span>文の順番をシャッフル</span><b>${S.sentenceShuffle ? 'オン' : 'オフ'}</b></button>`}
        <button class="p-link p-link-teal" data-act="shuttle.open">${icon.bolt}<span>シャトルランに挑戦</span>${best ? html`<b class="num">最高 Lv.${best.level}</b>` : ''}</button>
      </div>
    </div>`);
}

// ランクのひとこと：中身（Rust）の文は旧版（v5）と同じ答えを確かめるのに使うので変えず、画面ではこちらを出す（段階の名前 → 文）
const RANK_COMMENTS = {
  '達人': 'タイピングが得意な人の中でもトップクラスで、速さと正確さを高い水準で両立できています',
  '上級': '人から「速いね」と言われる水準で、ミスを減らして連続記録を伸ばせば S に届きます',
  '中級': 'チャットや文章入力に困らない速さで、手元を見ずに打てるようになるとさらに伸びます',
  '初中級': '基本が身に付いてきたので、速さよりもミスを減らすことを意識するとスコアが一気に上がります',
  '初級': 'キーの位置を覚えてきた段階なので、焦らず正確に打つ練習を続けましょう',
  '入門': 'まずはキーの位置に慣れる段階なので、キーボードのガイドを見ながら 1 文字ずつ確実に打ちましょう',
};

const ORDER_TIPS = {
  seq: 'グループに並べた順で練習します',
  shuffle: 'プリセットの順番を無作為に並べ替えます（押すたびに引き直し、一巡ごとに再抽選）',
  mix: 'プリセットをまたいで全ての文を混ぜます',
};

function bestShuttle() {
  try { return core.shuttleBestFor(S.layout.name, localStorage.getItem('custom_typing_shuttle_history_v1')); } catch { return null; }
}

function toggleShuffle() {
  S.sentenceShuffle = !S.sentenceShuffle;
  renderStart();
  toast(S.sentenceShuffle ? '文の順番を毎回シャッフルします（設定は保存されません）' : '文を登録順に練習します');
}

function openLayoutMenu(anchor) {
  const item = (key) => ({
    text: S.layouts[key].name, selected: S.activeLayoutKey === key,
    meta: CUSTOM_SLOT_KEYS.includes(key) ? (slotHasData(key) ? '保存枠' : '保存枠・未使用') : '',
    onPick: () => ctx.requestLayout(key),
  });
  openPop(anchor, [
    { label: 'プリセット' }, ...BUILTIN_LAYOUT_KEYS.map(item),
    { label: '自分の配列' }, ...CUSTOM_SLOT_KEYS.map(item),
    { sep: true },
    { text: '配列エディタを開く', link: true, onPick: () => ctx.switchTab('editor') },
  ]);
}

function openSourceMenu(anchor) {
  const pl = S.playlist;
  openPop(anchor, [
    { label: 'プリセット（繰り返し練習）' },
    ...S.presets.map((p, i) => ({
      text: p.name + (p.lang === 'en' ? '（英文）' : ''), meta: p.words.length + ' 文', selected: !pl && S.activePreset === i,
      onPick: () => { const was = Boolean(S.playlist); abandonForNewSelection(); selectPreset(i); if (was) toast('「' + p.name + '」を繰り返し練習します'); },
    })),
    ...(S.groups.length ? [{ label: 'グループ（プレイリスト）' }] : []),
    ...S.groups.map((g) => ({
      text: g.name, meta: g.presetIds.length + ' プリセット', selected: Boolean(pl && pl.groupId === g.id),
      onPick: () => {
        abandonForNewSelection();
        const err = startPlaylist(g.id);
        if (err) toast(err);
        else toast('グループ「' + g.name + '」を' + ORDER_LABELS[S.playlist.order] + 'で練習します');
      },
    })),
    { sep: true },
    { text: '練習文を編集する', link: true, onPick: () => ctx.switchTab('words') },
  ]);
}

// 練習の途中で配列や練習文を変えたら、その回は記録せずに最初へ戻す
function abandonForNewSelection() {
  if (!practiceBusy()) return;
  resetToStart();
  toast('練習中に切り替えたため、今回の結果は記録せずに待機画面へ戻りました');
}
export { abandonForNewSelection };

// ---------- 指の案内 ----------

function renderFingers() {
  const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  setHtml('#pFingers', order.map((i) => html`<span class="finger" data-finger="${i}" ${i === 5 ? raw('data-gap') : ''}><i></i>${FINGERS[i].short}</span>`));
  const box = $('#pFingers');
  box.classList.toggle('is-plain', !S.settings.showFingerColors);
  for (const node of box.children) node.style.setProperty('--c', FINGERS[Number(node.dataset.finger)].color);
}

function lightFingers(list) {
  for (const node of $('#pFingers').children) node.classList.toggle('is-on', list.includes(Number(node.dataset.finger)));
}

/** 次に押すキーを、舞台（と平面のガイド）と指の案内に出す。 */
function updateGuide() {
  if (!ctx || !ctx.isActive()) return;
  if (P.screen === 'start') {
    setTargets(S.settings.showKeyGuide ? [{ code: 'Space', role: 'accent' }] : []);
    lightFingers([]);
    return;
  }
  if (P.screen !== 'typing' || !P.session || !S.settings.showKeyGuide) { setTargets([]); lightFingers([]); return; }
  const g = guideFor(P.session.nextChar());
  if (!g) { setTargets([]); lightFingers([]); return; }
  const targets = [{ code: g.code }];
  const fingers = [g.finger];
  if (g.shiftCode) {
    targets.push({ code: g.shiftCode, role: 'shift' });
    const sd = S.layout.keys[g.shiftCode];
    fingers.push(sd ? sd.finger : (g.shiftCode === 'ShiftLeft' ? 0 : 9));
  }
  setTargets(targets);
  lightFingers(fingers);
}

function setTargets(list) {
  P.targets = list;
  ctx.stage.setTargets(list);
  markFlatTargets();
}

// ---------- 平面のキーボードガイド ----------
// 3D のキーボードは US 配置の形なので、JIS だけにあるキー（¥・ろ）がない。設定でオンにすると、平らなキーボードの絵を 3D の上に重ねる。

function renderFlat() {
  const box = $('#pFlat');
  if (!box) return;
  const on = S.settings.keyboardView === 'flat';
  box.hidden = !on;
  if (!on) { setHtml(box, ''); return; }
  const colors = S.settings.showFingerColors;
  setHtml(box, flatKeyboard(S.kind, (code) => {
    const slot = S.rows.flat().find((x) => x.code === code);
    if (!slot) return null;
    if (code === 'Space') return { cls: 'fk-mod', body: 'space', disabled: true };
    const key = S.layout.keys[code];
    const finger = FINGERS[key ? key.finger : slot.finger] || FINGERS[0];
    const tint = { cls: colors ? 'fk-finger' : '', style: colors ? '--fc:' + finger.color : '' };
    if (code === 'ShiftLeft' || code === 'ShiftRight') return { ...tint, cls: 'fk-mod ' + tint.cls, body: 'Shift', disabled: true };
    if (!key) return null;
    const ch = String(key.char || '');
    return {
      ...tint, disabled: true,
      body: html`${S.settings.showQwertySub && ch.toUpperCase() !== String(slot.label).toUpperCase() ? html`<span class="fk-sub">${slot.label}</span>` : ''}<span class="fk-main">${ch}</span>${slot.homeBump ? html`<i class="fk-bump"></i>` : ''}`,
    };
  }));
  markFlatTargets();
}

function markFlatTargets() {
  const box = $('#pFlat');
  if (!box || box.hidden) return;
  const roles = new Map((P.targets || []).map((t) => [t.code, t.role || 'key']));
  for (const node of box.querySelectorAll('.fk-key[data-code]')) {
    const role = roles.get(node.dataset.code);
    node.classList.toggle('is-target', role === 'key' || role === 'accent');
    node.classList.toggle('is-shift-target', role === 'shift');
  }
}

/** キーを沈める（3D）。平面のガイドでも、同じキーを一瞬光らせる。 */
function press(e, code, tone) {
  ctx.press(e, code, tone);
  const box = $('#pFlat');
  const node = box && !box.hidden ? box.querySelector('.fk-key[data-code="' + code + '"]') : null;
  if (!node) return;
  node.dataset.hit = tone;
  clearTimeout(node.hitTimer);
  node.hitTimer = setTimeout(() => { delete node.dataset.hit; }, 160);
}

// ---------- 始める・止める ----------

export function resetToStart() {
  clearInterval(P.timer);
  clearInterval(P.statTimer);
  disposeSession();
  P.result = null;
  show(sessionSize() ? 'start' : 'empty');
}

function disposeSession() {
  if (P.session) { try { P.session.free(); } catch { /* すでに解放済み */ } }
  P.session = null;
}

export function startCountdown() {
  const lost = syncPlaylist();
  if (lost) toast(lost);
  if (!sessionSize()) { toast('先に練習文を登録してください'); show('empty'); return; }
  if (!ctx.isActive()) ctx.switchTab('practice');
  clearInterval(P.timer);
  clearInterval(P.statTimer);
  disposeSession();
  if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
  show('countdown');
  let count = 3;
  const node = $('#pCount');
  const tick = () => {
    node.textContent = String(count);
    node.classList.remove('is-pop');
    void node.offsetWidth;
    node.classList.add('is-pop');
    playSound('count');
    ctx.stage.wave({ from: 'center', strength: 0.35, speed: 1.6, color: '#ffffff' });
  };
  tick();
  P.timer = setInterval(() => {
    count--;
    if (count > 0) tick();
    else { clearInterval(P.timer); startTyping(); }
  }, 650);
}

function startTyping() {
  const src = sessionWords();
  sessionWordList = src.words;   // 漢字の行の表示に使う
  const course = courseInfo();
  const g = S.playlist ? groupById(S.playlist.groupId) : null;
  P.meta = {
    course, groupName: g ? g.name : null, layoutKey: S.activeLayoutKey, layoutName: S.layout ? S.layout.name : 'カスタム',
    lang: src.lang, langs: src.langs, count: src.words.length,
  };
  P.session = new TypingSession({ words: src.words, langs: src.langs || undefined, lang: src.lang, style: S.romajiStyle, kind: S.kind, layout: S.layout });
  P.virtualShift = {};
  P.remap = { hits: 0, shown: P.remap.shown };
  P.startTime = performance.now();
  show('typing');
  $('#pMiss').textContent = '';
  if (P.session.state().finished) { finish(); return; }
  renderSentence(true);
  renderTrack();
  updateStats();
  clearInterval(P.statTimer);
  P.statTimer = setInterval(updateStats, 500);
}

export function pause() {
  if (P.screen !== 'typing') return;
  P.pausedAt = performance.now();
  show('paused');
}

function resume() {
  if (P.screen !== 'paused') return;
  P.startTime += performance.now() - P.pausedAt;
  show('typing');
  renderSentence(true);
}

function next() {
  if (S.playlist) {
    const note = playlistAdvance();
    if (note) toast(note);
    if (!S.playlist) { resetToStart(); return; }
  }
  startCountdown();
}

// ---------- 文の表示 ----------

function kanjiHtml(kanji, chunks, idx) {
  if (!kanji) return raw('');
  const total = chunks.length;
  if (!total) return html`${kanji}`;
  if (idx >= total) return html`<span class="t-done">${kanji}</span>`;
  const joined = chunks.map((c) => c.kana).join('');
  if (core.normalizeReading(kanji) === joined && kanji.length === joined.length) {
    let pos = 0, done = '', now = '', rest = '';
    chunks.forEach((c, i) => {
      const len = (c.kana || '').length;
      const slice = kanji.slice(pos, pos + len);
      pos += len;
      if (i < idx) done += slice; else if (i === idx) now += slice; else rest += slice;
    });
    return html`<span class="t-done">${done}</span><span class="t-now">${now}</span><span>${rest}</span>`;
  }
  // 漢字まじり：打った割合でおおよその位置まで色を付ける
  const split = Math.floor(kanji.length * (idx / total));
  return html`<span class="t-done">${kanji.slice(0, split)}</span><span>${kanji.slice(split)}</span>`;
}

function renderSentence(fresh = false) {
  const se = P.session;
  if (!se) return;
  const st = se.state();
  const prompt = $('#pPrompt');
  const kana = $('#pKana'), kanji = $('#pKanji'), romaji = $('#pRomaji');
  const en = st.lang === 'en';
  prompt.classList.toggle('is-en', en);
  const word = ctxWord(st.wordIndex);

  if (en) {
    kana.hidden = true; romaji.hidden = true;
    setHtml(kanji, st.chunks.map((c, i) => {
      if (i < st.chunkIndex) return html`<span class="${c.skipped ? 't-skip' : 't-done'}">${c.kana}</span>`;
      if (i === st.chunkIndex) return c.kana === ' ' ? html`<span class="t-now t-space">&nbsp;</span>` : html`<span class="t-now">${c.kana}</span>`;
      return html`<span>${c.kana}</span>`;
    }));
  } else {
    // かなだけの文は、よみがなの行が同じになるので出さない
    kana.hidden = !S.settings.showKana || Boolean(word && core.normalizeReading(word.kanji) === word.kana);
    romaji.hidden = !S.settings.showRomaji;
    let typed = '', cur = '', rest = '', kDone = '', kNow = '', kRest = '';
    st.chunks.forEach((c, i) => {
      const primary = c.options[0] || '';
      if (i < st.chunkIndex) { typed += c.typed; kDone += c.kana; }
      else if (i === st.chunkIndex) { typed += c.typed; const r = primary.slice(c.typed.length); cur = r[0] || ''; rest += r.slice(1); kNow += c.kana; }
      else { rest += primary; kRest += c.kana; }
    });
    setHtml(romaji, html`<span class="t-done">${typed}</span><span class="t-now" id="pCaretChar">${cur}</span><span>${rest}</span>`);
    setHtml(kana, html`<span class="t-done">${kDone}</span><span class="t-now">${kNow}</span><span>${kRest}</span>`);
    setHtml(kanji, kanjiHtml(word ? word.kanji : '', st.chunks, st.chunkIndex));
  }
  if (fresh) {
    prompt.classList.remove('is-in');
    void prompt.offsetWidth;
    prompt.classList.add('is-in');
  }
  $('#pProgressBar').style.width = Math.round((st.wordIndex / (st.words || 1)) * 100) + '%';
  updateGuide();
}

let sessionWordList = [];
function ctxWord(i) { return sessionWordList[i] || null; }

function renderTrack() {
  const pl = S.playlist;
  const g = pl ? groupById(pl.groupId) : null;
  const node = $('#pTrack');
  if (!pl || !g) { node.textContent = P.meta ? P.meta.course.name : ''; return; }
  const mix = pl.order === 'mix' ? pl.mix : null;
  const cur = presetById(pl.queue[pl.pos]);
  node.textContent = mix
    ? g.name + ' ・ 全シャッフル ' + (mix.cursor + 1) + '〜' + Math.min(mix.cursor + mix.size, mix.pool.length) + ' / ' + mix.pool.length + ' 文'
    : g.name + ' ' + (pl.pos + 1) + '/' + pl.queue.length + ' ・ ' + (cur ? cur.name : '');
}

function updateStats() {
  const se = P.session;
  if (!se || (P.screen !== 'typing' && P.screen !== 'paused')) return;
  const st = se.state();
  const min = Math.max((performance.now() - P.startTime) / 60000, 0.005);
  $('#stProgress').textContent = Math.min(st.wordIndex + 1, st.words) + '/' + st.words;
  $('#stWpm').textContent = String(P.screen === 'typing' && st.correct > 0 ? Math.round(st.correct / 5 / min) : 0);
  const total = st.correct + st.mistakes;
  $('#stAcc').textContent = (total > 0 ? ((st.correct / total) * 100).toFixed(1) : '100.0') + '%';
  const combo = $('#stCombo');
  combo.textContent = String(st.combo);
  combo.parentElement.classList.toggle('is-hot', st.combo >= 30);
}

// ---------- キー ----------

/** 練習のタブでのキー。 @returns {boolean} 受け取ったか */
export function practiceKeyDown(e) {
  const st = ctx.stage;
  const reader = S.reader;
  // キーボード調整で Esc が文字の位置に来ているときは、Esc も文字として打つ（一時停止はボタンで）
  if (e.key === 'Escape' && !reader.isCalibratedCharKey(e)) {
    e.preventDefault();
    if (P.screen === 'typing') pause();
    else if (P.screen === 'paused') startCountdown();
    else if (P.screen === 'countdown' || P.screen === 'result') resetToStart();
    return true;
  }
  if ((e.key === 'Enter' || e.code === 'Space') && P.screen === 'result') {
    e.preventDefault();
    if (!e.repeat) next();
    return true;
  }
  if (e.code === 'Space') {
    if (P.screen === 'start') { e.preventDefault(); if (!e.repeat) startCountdown(); return true; }
    if (P.screen === 'paused') { e.preventDefault(); if (!e.repeat) resume(); return true; }
  }
  // Ctrl+C などのショートカットは打鍵として数えない
  if (e.ctrlKey || e.metaKey || e.altKey) return false;

  // Shift として登録したキー（追加のキー）
  const reading = reader.reading(e);
  if (reading && reading.code === '@shift') {
    e.preventDefault();
    P.virtualShift[core.keySignalOf(e.code || '', e.key || '', Boolean(e.shiftKey), false)] = true;
    if (!e.repeat) press(e, 'ShiftLeft', 'neutral');
    return true;
  }
  if (e.key === 'Shift') return true;
  if (['Control', 'Alt', 'Meta', 'Tab', 'CapsLock'].includes(e.key)) return false;

  if (e.code === 'Space' || e.key === ' ') {
    if (P.screen === 'typing') {
      e.preventDefault();
      // 英語の文ではスペースも文字。日本語では数えない
      if (P.session && P.session.state().lang === 'en' && !e.repeat) processInput(' ', 'Space', e);
    }
    return true;
  }

  const virtualShift = Object.keys(P.virtualShift).length > 0;
  const resolved = reader.resolve(e, virtualShift);
  if (!resolved || !resolved.char) {
    // Enter でフォーカスのあるボタン（スタートなど）が押されて、練習がやり直しにならないようにする
    if (e.key === 'Enter' && (P.screen === 'typing' || P.screen === 'countdown')) e.preventDefault();
    return false;
  }
  e.preventDefault();
  if (P.screen !== 'typing' || !P.session) {
    if (!e.repeat) { press(e, resolved.code, 'neutral'); playSound('key'); const d = S.layout.keys[resolved.code]; if (d) lightFingers([d.finger]); }
    return true;
  }
  const ch = P.session.chooseInputChar(resolved.char, resolved.altChar);
  if (!reader.hasCalibration()) noteRemapSuspicion(e, ch);
  processInput(ch, resolved.code, e);
  return true;
}

export function practiceKeyUp(e) {
  const sig = core.keySignalOf(e.code || '', e.key || '', Boolean(e.shiftKey), false);
  if (P.virtualShift[sig]) delete P.virtualShift[sig];
}

export function clearVirtualShift() { P.virtualShift = {}; }

function processInput(ch, code, e) {
  const se = P.session;
  const expected = se.nextChar();
  const out = se.input(ch, code, performance.now());
  const st = ctx.stage;
  if (out.kind === 'correct') {
    press(e, code, 'correct');
    playSound('key');
    $('#pMiss').textContent = '';
    if (out.finished) { finish(); return; }
    if (out.sentenceDone) {
      playSound('wordDone');
      st.wave({ from: 'left', strength: 0.22, speed: 2.2, color: '#ffffff' });
      renderSentence(true);
    } else renderSentence();
    updateStats();
  } else if (out.kind === 'mistake') {
    press(e, code, 'miss');
    playSound('error');
    const prompt = $('#pPrompt');
    prompt.classList.remove('is-miss');
    void prompt.offsetWidth;
    prompt.classList.add('is-miss');
    $('#pMiss').textContent = 'MISS  ' + (ch === ' ' ? 'Space' : ch) + '  →  ' + ((out.expected || expected || '-') === ' ' ? 'Space' : (out.expected || expected || '-'));
    updateStats();
  }
}

// 調整していないのに、ミスのほとんどが「QWERTY でその文字があるキー」で、正確率もとても低いときは、キーボード調整をすすめる
// （キーボード側で配列を変えていて、二重に読み替えられている人。旧版（v5）と同じ条件：8 回以上・ミスの 8 割以上・正確率 5 割未満）
function noteRemapSuspicion(e, inputChar) {
  if (P.remap.shown || !P.session) return;
  const expected = P.session.nextChar();
  const raw = S.rows.flat().find((s) => s.code === e.code);
  if (!expected || !raw || raw.isModifier || P.session.inputWouldMatch(inputChar)) return;
  if (Object.keys(S.reader.extraKeys()).length) return;
  if (String(raw.label).toUpperCase() === String(expected).toUpperCase()) P.remap.hits++;
  const st = P.session.state();
  const misses = st.mistakes + 1;
  if (P.remap.hits >= 8 && P.remap.hits / misses >= 0.8 && st.correct / (st.correct + misses) < 0.5) {
    P.remap.shown = true;
    ctx.suggestCalibration();
  }
}

// ---------- 結果 ----------

function finish() {
  clearInterval(P.statTimer);
  const se = P.session;
  const meta = P.meta;
  const stState = se.state();
  const langs = meta.langs;
  const isEnglish = meta.count ? Array.from({ length: meta.count }, (_, i) => (langs && langs[i]) || meta.lang).every((l) => l === 'en') : meta.lang === 'en';
  const result = se.finish({
    elapsedMs: performance.now() - P.startTime, isEnglish, courseKey: meta.course.key, courseName: meta.course.name, groupName: meta.groupName,
    layoutKey: meta.layoutKey, layoutName: meta.layoutName, id: newId('r_'), timestamp: Date.now(),
  });
  if (!result) {
    resetToStart();
    toast('この配列で入力できる文字が練習文にないため、配列か練習文を変更してください');
    return;
  }
  S.liveTelemetry = { data: stState.live, layoutName: meta.layoutName };   // 配列分析の「実測」に使う
  const prevBest = core.previousBest(S.history, meta.layoutName, meta.course.key);
  const isBest = stState.correct > 0 && prevBest >= 0 && result.score.score > prevBest;
  if (result.record) recordScore(result.record);
  P.result = { result, state: stState, meta, isBest };
  disposeSession();
  show('result');
  renderResult();
  playSound('finish');
  const stage = ctx.stage;
  setTargets([]);
  stage.wave({ rainbow: true, from: 'left', strength: 1, speed: 0.9 });
  // ミスの多かったキーを、キーボードの上で赤く灯す
  const missed = Object.entries(stState.missedChars || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const max = missed.length ? missed[0][1] : 1;
  const heat = {};
  for (const [c, n] of missed) { const g = guideFor(c); if (g) heat[g.code] = 0.45 + 0.55 * (n / max); }
  setTimeout(() => { if (P.screen === 'result' && document.body.dataset.tab === 'practice') stage.setHeat(heat); }, 900);
  ctx.maybeBackupReminder(1200, 'result');
}

function renderResult() {
  const { result: r, state: st, isBest } = P.result;
  const sc = r.score, rank = r.rank, nextRank = r.next, rh = r.rhythm;
  const secs = r.secs;
  const time = secs >= 60 ? Math.floor(secs / 60) + '分' + (secs % 60) + '秒' : secs + '秒';
  const attempts = st.correct + st.mistakes;
  const pct = nextRank ? Math.max(4, Math.min(100, ((sc.score - rank.min) / (nextRank.min - rank.min)) * 100)) : 100;
  const weak = Object.entries(st.missedChars || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const pl = S.playlist;
  const mixed = isMix();
  const escHint = S.reader.escapeIsTypedKey() ? '' : html`<span><kbd>Esc</kbd>待機画面へ</span>`;
  setHtml('#pResult', html`
    <div class="res">
      <div class="res-rank" id="resRankBox">
        <div class="res-letter3d" id="resRank3d" aria-hidden="true"></div>
        <div class="res-letter num" id="resRank">${rank.rank}</div>
        <div class="res-tier">${rank.label}レベル${isBest ? html`<span class="chip chip-accent">自己ベスト更新</span>` : ''}</div>
        <div class="res-comment">${RANK_COMMENTS[rank.label] || String(rank.comment || '').replace(/。/g, '')}</div>
      </div>
      <div class="res-main">
        <div class="res-scoreline">
          <div class="res-scorebox">
            <span class="eyebrow">SCORE</span>
            <div class="res-score num" id="resScore">0</div>
          </div>
          <div class="res-next">
            <div class="res-next-text">${nextRank ? html`次の <b>${nextRank.rank}</b> まで あと <b class="num">${(nextRank.min - sc.score).toLocaleString()}</b> 点` : '最高ランクに到達しました'}</div>
            <div class="res-bar"><div id="resNextBar"></div></div>
          </div>
        </div>
        <p class="res-summary">${st.words} 文（${st.completedKana} 文字）を ${time}で打ち終えました</p>
        <div class="res-pillars">
          <div class="res-pillar"><i>はやさ</i><b class="num">${r.cpm}</b><em>文字/分</em><small>1 秒に ${core.toFixed(r.cpmRaw / 60, 1)} 文字</small></div>
          <span class="res-x">×</span>
          <div class="res-pillar"><i>せいかくさ</i><b class="num">${core.toFixed(r.accPct, 1)}</b><em>%</em><small>${st.mistakes === 0 ? attempts + '回押して ミスなし' : attempts + '回押して ミス ' + st.mistakes + '回'}</small></div>
          <span class="res-x">×</span>
          <div class="res-pillar"><i>リズム</i><b class="num">${rh.smooth === null ? '—' : core.toFixed(rh.smooth * 100, 1)}</b><em>${rh.smooth === null ? '' : '%'}</em><small>${rh.smooth === null ? '文が短いため計測なし（×0.9 で計算）' : rh.stalls === 0 ? '一度も止まらずに打てました' : '立ち止まり ' + rh.stalls + '回（' + rh.samples + '打鍵中）'}</small></div>
        </div>
        <div class="res-weak ${weak.length ? '' : 'is-clean'}">
          ${weak.length
            ? html`<span class="res-weak-title">次に意識したいキー</span>${weak.map(([k, n]) => html`<span class="res-weak-key"><kbd>${k === ' ' ? 'Space' : k}</kbd><span class="num">${n}回</span></span>`)}<span class="faint res-weak-note">キーボードで赤く光っているキーです</span>`
            : html`<span class="res-weak-title">ノーミスで打ち終えました</span>`}
        </div>
        <div class="res-actions">
          ${pl ? html`<button class="btn btn-primary btn-l" data-act="practice.next"><kbd>Space</kbd>次へ：${nextTrackName()}</button>
              <button class="btn btn-l" data-act="practice.restart">${icon.retry}${mixed ? '同じ文でもう一度' : 'このプリセットをもう一度'}</button>`
            : html`<button class="btn btn-primary btn-l" data-act="practice.restart"><kbd>Space</kbd>もう一度</button>`}
          <button class="btn btn-ghost btn-l" data-act="practice.quit">待機画面へ</button>
          <button class="btn btn-ghost btn-l" data-act="practice.detail">${icon.list}内訳</button>
        </div>
        <div class="res-detail" id="resDetail" hidden>
          <div class="res-mini">
            <span><i>WPM</i><b class="num">${r.wpm}</b></span>
            <span><i>打鍵/分</i><b class="num">${r.kpm}</b></span>
            <span><i>正しい打鍵</i><b class="num">${st.correct}</b></span>
            <span><i>文字数</i><b class="num">${st.completedKana}</b></span>
            <span><i>最大連続</i><b class="num">${st.maxCombo}</b></span>
          </div>
          <p class="mono res-formula">はやさ 標準${Math.round(r.refKpm)}打鍵/分 ÷ 1.7 × 10 = ${Math.round(sc.speedPts).toLocaleString()}<br>
            × せいかくさ ${core.toFixed(sc.accMul, 3)}（正確率の3乗）<br>
            × リズム ${core.toFixed(sc.rhythmMul, 3)}${rh.smooth === null ? '（計測なし）' : '（立ち止まり ' + Math.round((1 - rh.smooth) * 100) + '%）'}<br>
            = <b>${sc.score.toLocaleString()}</b></p>
          <button class="btn btn-s btn-ghost" data-act="help.ranks">ランク一覧を見る</button>
        </div>
        <p class="res-hint"><span>結果は「記録」タブに保存されました</span>${escHint}</p>
      </div>
    </div>`);
  const box = $('#resRankBox');
  box.style.setProperty('--rank', rank.color || '#ff6a2b');
  // ランクは立体にして回す（描けない環境では、ふつうの文字）。スコアは数え上げる
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (showText3d($('#resRank3d'), { text: rank.rank, color: rank.color, crown: ['S', 'S+', 'SS', 'SSS'].includes(rank.rank), reducedMotion: reduced, low: S.settings.lowQuality })) box.classList.add('is-3d');
  const scoreBox = $('#resScore').parentElement;
  scoreBox.style.setProperty('--rank', rank.color || '#ff6a2b');
  countUp($('#resScore'), sc.score, { ms: 1100 });
  requestAnimationFrame(() => { const bar = $('#resNextBar'); if (bar) bar.style.width = pct.toFixed(0) + '%'; });
}
