// シャトルラン：だんだん短くなる制限時間に挑む。進み方は Rust の ShuttleGame（毎フレーム tick → takeEvents）。
// 画面は暗くなり、キーボードが青緑に灯る。残り時間が減ると、光は橙 → 赤に変わり、文にひびが入る。
import { showText3d } from '../scene/score3d.js';
import { core, ShuttleGame } from '../core.js';
import { S, guideFor } from '../model.js';
import { K, lsRead, lsWrite, rawGet, newId, markDataChanged } from '../store.js';
import { $, $$, html, raw, setHtml, act, formatDate } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast, openModal } from '../ui/overlay.js';
import { playSound } from '../sound.js';
import { SHUTTLE, GOLD, DANGER } from '../theme.js';

const SH = {
  open: false,
  phase: 'closed',       // 'intro' | 'count' | 'run' | 'paused' | 'over'
  game: null,
  raf: 0,
  timer: 0,
  virtualShift: {},
  lastBeat: 0,
  band: '',
  dq: -1,
  hudKey: '',
  wordKey: '',
  freezeKind: '',
  rules: null,
  rec: null,
};
let ctx = null;   // {stage, press, applyStage, syncSlot, maybeBackupReminder}

export const shuttleActive = () => SH.open;
// トロフィーの絵。プラチナ以上は格が上がるほど飾りを足す（プラチナ：星の紋章ときらめき、ダイヤモンド：宝石、ゴッド：月桂樹と光の輪）
const TIER_RANK = { bronze: 0, silver: 1, gold: 2, platinum: 3, diamond: 4, god: 5 };
const sparkle = (x, y, r, o = 1) => `<path d="M${x} ${y - r}L${x + r * 0.28} ${y - r * 0.28}L${x + r} ${y}L${x + r * 0.28} ${y + r * 0.28}L${x} ${y + r}L${x - r * 0.28} ${y + r * 0.28}L${x - r} ${y}L${x - r * 0.28} ${y - r * 0.28}Z" fill="#fff" opacity="${o}"/>`;
export const trophySvg = (t, tiers, big = false) => {
  const tier = tiers.find((x) => x.id === t.tier) || tiers[0];
  const id = 'tg-' + t.id + (big ? 'b' : '');
  const rank = TIER_RANK[tier.id] ?? 0;
  const g = `url(#${id})`;
  let back = '', front = '';
  if (rank >= 5) {
    // 光の輪と、両側の月桂樹
    back += `<ellipse cx="24" cy="4.5" rx="8.5" ry="2.2" fill="none" stroke="#ffe58a" stroke-width="1.6" opacity="0.95"/>`;
    const leaves = (side) => [0, 1, 2, 3].map((k) => {
      const y = 30 - k * 5.5, x = side < 0 ? 9 - k * 0.6 : 39 + k * 0.6;
      return `<ellipse cx="${x}" cy="${y}" rx="1.7" ry="3.4" transform="rotate(${side * (35 - k * 8)} ${x} ${y})" fill="${g}"/>`;
    }).join('');
    back += leaves(-1) + leaves(1);
  }
  if (rank >= 3) {
    // まわりのきらめき（格が上がるほど多く）
    back += sparkle(7, 9, 3) + sparkle(42, 29, 2.4, 0.9);
    if (rank >= 4) back += sparkle(41, 7, 2.2, 0.85) + sparkle(6, 31, 1.8, 0.8);
    // 杯の紋章：プラチナは星、ダイヤモンド以上は宝石
    front += rank >= 4
      ? `<path d="M20 13h8l3 3-7 8.5-7-8.5z" fill="#fff" opacity="0.92"/><path d="M17 16h14M22 13l-1.5 3 3.5 8.5M26 13l1.5 3-3.5 8.5" fill="none" stroke="${tier.stops[2]}" stroke-width="0.7" opacity="0.8"/>`
      : `<path d="M24 11.2l1.4 3 3.2.3-2.4 2.1.7 3.2-2.9-1.7-2.9 1.7.7-3.2-2.4-2.1 3.2-.3z" fill="#fff" opacity="0.9"/>`;
    // 台座の帯
    front += `<path d="M14 37.5h20" stroke="#fff" stroke-width="1" opacity="0.6"/>`;
  }
  return raw(`<svg class="trophy-svg" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${tier.stops[0]}"/><stop offset="0.55" stop-color="${tier.stops[1]}"/><stop offset="1" stop-color="${tier.stops[2]}"/></linearGradient></defs>${back}<path d="M14 8h20v9a10 10 0 0 1-20 0z" fill="${g}"/><path d="M14 11H8a6 6 0 0 0 7 8M34 11h6a6 6 0 0 1-7 8" fill="none" stroke="${g}" stroke-width="3" stroke-linecap="round"/><path d="M22 27h4v7h-4z" fill="${g}"/><path d="M15 34h18l2 6H13z" fill="${g}"/><path d="M19 11c0 5 1 9 4 11" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.6" stroke-linecap="round"/>${front}</svg>`);
};

// ---------- 骨組み ----------

export function mountShuttle(root, context) {
  ctx = context;
  SH.rules = core.shuttleRules();
  setHtml(root, html`
    <div class="sh-veil" id="shVeil"></div>
    <div class="sh-top">
      <div class="sh-name"><b>シャトルラン</b><span id="shLayout"></span></div>
      <div class="row">
        <button class="btn btn-s" data-act="shuttle.pauseBtn" id="shPauseBtn">${icon.pause}<span>一時停止</span></button>
        <button class="btn btn-s" data-act="shuttle.close">終了</button>
      </div>
    </div>
    <div class="sh-hud" id="shHud">
      <div class="sh-level"><i>レベル</i><b class="num" id="shLevel">1</b><span id="shStageName">ステージ 1</span></div>
      <div class="sh-time">
        <div class="sh-time-head"><i>残り時間</i><span class="sh-time-state" id="shTimeState" hidden>無敵</span><b class="num"><span id="shTimeNum">–</span><small>秒</small></b></div>
        <div class="sh-bar"><div id="shTimeFill"></div></div>
        <div class="sh-time-foot"><span>必要なペース <b class="num" id="shPace">48</b> 打/分</span><span id="shCarry">持ち越しなし</span></div>
      </div>
      <div class="sh-side">
        <div class="sh-combo" title="ノーミスで 20 打続けると +0.5 秒">
          <svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="19" class="track"/><circle cx="22" cy="22" r="19" class="fill" id="shComboRing" pathLength="1"/></svg>
          <b class="num" id="shCombo">0</b>
        </div>
        <div class="sh-shields" id="shShields">
          <div class="sh-shield-row"><span class="sh-shield-ico">${icon.shield}</span><span class="sh-shield-ico">${icon.shield}</span><span id="shShieldText">シールド 0/2</span></div>
          <div class="sh-streak" id="shStreak" title="ノーミスのレベルを 3 つ続けるとシールドを 1 つ獲得"><i></i><i></i><i></i></div>
        </div>
      </div>
    </div>
    <div class="sh-stage" id="shStage">
      <div class="sh-freeze" id="shFreeze" hidden></div>
      <div class="sh-banner" id="shBanner" hidden></div>
      <div class="sh-prompt" id="shPrompt">
        <div class="sh-kana" id="shKana"></div>
        <div class="sh-kanji" id="shKanji"></div>
        <div class="sh-romaji mono" id="shRomaji"></div>
        <svg class="sh-cracks" id="shCracks" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"></svg>
      </div>
      <div class="sh-next" id="shNext"></div>
      <div class="sh-popups" id="shPopups"></div>
      <div class="sh-count num" id="shCount" hidden>3</div>
    </div>
    <div class="sh-slot" id="shSlot" aria-hidden="true"></div>
    <div class="sh-panel glass" id="shPanel" hidden></div>`);

  act({
    'shuttle.open': () => openShuttle(),
    'shuttle.close': () => closeShuttle(),
    'shuttle.start': () => countdown(),
    'shuttle.pauseBtn': () => { if (SH.phase === 'run') pause(); else if (SH.phase === 'paused') resume(); },
    'shuttle.resume': () => resume(),
    'shuttle.quit': () => quitRun(),
    'shuttle.levels': () => openLevelTable(),
  });
}

// ---------- 開く・閉じる ----------

export function openShuttle() {
  if (SH.open) return;
  if (ctx.practiceBusy()) ctx.resetPractice();
  SH.open = true;
  $('#shuttle').hidden = false;
  document.body.dataset.shuttle = '1';
  document.body.dataset.depth = 'front';
  document.body.dataset.focus = '0';
  $('#shLayout').textContent = S.layout.name + ' ・ ' + (S.romajiStyle === 'hepburn' ? 'ヘボン式' : '日本式');
  const st = ctx.stage;
  st.setMood('shuttle', 1.2);
  st.setPose('shuttle', 1.2);
  st.setTargets([]);
  st.setHeat({});
  st.setUrgency(0);
  showIntro();
  ctx.syncSlot();
}

export function closeShuttle() {
  if (!SH.open) return;
  stopLoop();
  clearInterval(SH.timer);
  disposeGame();
  SH.open = false;
  SH.phase = 'closed';
  $('#shuttle').hidden = true;
  document.body.dataset.shuttle = '0';
  ctx.stage.setUrgency(0);
  ctx.stage.setTargets([]);
  ctx.applyStage();
  ctx.refreshPractice();
}

export function shuttleSlot() {
  const r = $('#shSlot').getBoundingClientRect();
  return r.width > 10 && r.height > 10 ? r : null;
}

function disposeGame() {
  if (SH.game) { try { SH.game.free(); } catch { /* すでに解放済み */ } }
  SH.game = null;
}

function setPhase(phase) {
  SH.phase = phase;
  $('#shuttle').dataset.phase = phase;
  const pauseBtn = $('#shPauseBtn');
  pauseBtn.disabled = !(phase === 'run' || phase === 'paused');
  setHtml(pauseBtn, phase === 'paused' ? html`${icon.play}<span>再開</span>` : html`${icon.pause}<span>一時停止</span>`);
}

function panel(content) {
  const p = $('#shPanel');
  if (!content) { p.hidden = true; return; }
  setHtml(p, content);
  p.hidden = false;
  p.scrollTop = 0;
}

// ---------- 待機 ----------

function historyRaw() { return lsRead(K.shuttle); }
function trophyStore() { return core.loadTrophies(rawGet(K.trophies), historyRaw(), Date.now()); }

function showIntro(warning) {
  setPhase('intro');
  resetStageLook();
  const r = SH.rules;
  const best = core.shuttleBestFor(S.layout.name, historyRaw());
  const table = core.trophyTable();
  const got = table.filter((t) => trophyStore().got[t.id]).length;
  resetHud();
  panel(html`
    <p class="sh-lead">文を打ち終えると次のレベルに進み、レベルが上がるほど文は長く、制限時間は短くなります<br>どこまで行けるか挑戦しましょう</p>
    ${warning ? html`<p class="sh-warn">${warning}</p>` : ''}
    <dl class="sh-rules">
      <div><dt>+${r.comboBonus.toFixed(1)}秒</dt><dd>ノーミスで ${r.comboEvery} 打続けたとき</dd></div>
      <div><dt class="is-minus">−${r.missPenalty.toFixed(1)}秒</dt><dd>ミスをしたとき（同じレベルで ${r.heavyAfter + 1} 回目以降は −${r.missPenaltyHeavy.toFixed(1)}秒）</dd></div>
      <div><dt>持ち越し</dt><dd>残り時間の ${Math.round(r.carryRate * 100)}% を次のレベルに持ち越せます（最大 ${r.carryMax} 秒）</dd></div>
      <div><dt>シールド</dt><dd>ノーミスで ${r.shieldStreak} レベル続けると獲得でき、時間切れを 1 回防ぎます</dd></div>
      <div><dt>文を分けて表示</dt><dd>レベル ${r.twoPartsFrom} から 2 つ、${r.threePartsFrom} から 3 つに分けて表示します</dd></div>
      <div><dt class="is-gold">無敵</dt><dd>シールド発動後の ${r.invincibleSec} 秒間は時間が減りません</dd></div>
    </dl>
    <p class="sh-meta">${best ? html`この配列の最高記録　<b>レベル ${best.level}</b>（${best.cleared} レベルクリア・${formatDate(best.timestamp, false)}）` : 'この配列の記録はまだありません'}
      　・　トロフィー <b class="is-gold">${got} / ${table.length}</b>　・　<button class="btn-link" data-act="shuttle.levels">レベル一覧</button></p>
    <div class="row wrap sh-actions">
      <button class="btn btn-l sh-go" data-act="shuttle.start"><kbd>Space</kbd>スタート</button>
      <button class="btn btn-l btn-ghost" data-act="shuttle.close"><kbd>Esc</kbd>通常の練習に戻る</button>
    </div>`);
}

function resetHud() {
  $('#shLevel').textContent = '1';
  $('#shStageName').textContent = 'ステージ 1';
  $('#shPace').textContent = String(Math.round(core.shuttleLevelInfo(1).kps * 60));
  $('#shCombo').textContent = '0';
  $('#shComboRing').style.strokeDashoffset = '1';
  $('#shTimeNum').textContent = '–';
  $('#shTimeFill').style.width = '100%';
  $('#shCarry').textContent = '持ち越しなし';
  renderShields(0, 0);
  SH.hudKey = '';
}

function resetStageLook() {
  const stage = $('#shStage');
  stage.classList.remove('is-shatter', 'is-inv');
  $('#shuttle').dataset.band = 'ok';
  $('#shKana').textContent = '';
  $('#shKanji').textContent = '';
  $('#shRomaji').textContent = '';
  $('#shNext').textContent = '';
  $('#shCracks').innerHTML = '';
  $('#shFreeze').hidden = true;
  $('#shTimeState').hidden = true;
  $('#shVeil').style.opacity = '0';
  SH.band = ''; SH.dq = -1; SH.wordKey = ''; SH.freezeKind = '';
  if (ctx) ctx.stage.setUrgency(0);
}

/** レベル一覧の表（ヘルプにも出す）。reached：今回とどいたレベル、best：この配列の最高記録。 */
export function levelTableHtml(reached = 0, best = null) {
  const r = SH.rules || core.shuttleRules();
  const rows = [];
  for (let lv = 1; lv <= 45; lv++) {
    const info = core.shuttleLevelInfo(lv);
    const stageStart = lv > 1 && (lv - 1) % r.levelsPerStage === 0;
    rows.push(html`<tr class="${stageStart ? 'is-stage' : ''} ${lv === reached ? 'is-reached' : ''} ${best && lv === best.level ? 'is-best' : ''}">
      <td class="r num">${lv}</td><td class="r num">${info.stage}</td><td class="r num">${Math.round(info.kps * 60)}</td><td class="r num">約 ${Math.round(info.targetKeys)}</td>
      <td class="r num">${info.baseLimit.toFixed(1)}</td><td>${info.parts > 1 ? info.parts + ' つに分ける' : ''}</td>
      <td>${lv === reached ? html`<span class="chip chip-accent">今回</span>` : best && lv === best.level ? html`<span class="chip">最高記録</span>` : ''}</td></tr>`);
  }
  return html`<table class="table sh-level-table"><thead><tr><th class="r">レベル</th><th class="r">ステージ</th><th class="r">必要なペース（打/分）</th><th class="r">文の長さ（打鍵）</th><th class="r">制限時間の目安（秒）</th><th>文の分け方</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function openLevelTable() {
  openModal({
    title: 'シャトルランのレベル一覧', size: 'l',
    body: levelTableHtml(SH.rec ? SH.rec.level : 0, core.shuttleBestFor(S.layout.name, historyRaw())),
  });
}

// ---------- 始める ----------

function countdown() {
  if (SH.phase !== 'intro' && SH.phase !== 'over') return;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  disposeGame();
  SH.rec = null;
  panel(null);
  resetStageLook();
  resetHud();
  setPhase('count');
  ctx.stage.setPose('shuttle', 0.9);
  ctx.stage.setMood('shuttle', 0.6);
  const node = $('#shCount');
  node.hidden = false;
  let n = 3;
  const tick = () => {
    node.textContent = String(n);
    node.classList.remove('is-pop'); void node.offsetWidth; node.classList.add('is-pop');
    playSound('count');
    ctx.stage.wave({ color: SHUTTLE, from: 'center', strength: 0.6, speed: 1.6 });
  };
  tick();
  clearInterval(SH.timer);
  SH.timer = setInterval(() => {
    n--;
    if (n > 0) tick();
    else { clearInterval(SH.timer); node.hidden = true; begin(); }
  }, 650);
}

function begin() {
  const now = performance.now();
  SH.game = new ShuttleGame(S.layout, S.kind, S.romajiStyle, now, Math.floor(Math.random() * 2 ** 32));
  SH.virtualShift = {};
  SH.lastBeat = 0;
  const events = SH.game.takeEvents();
  if (events.some((e) => e.kind === 'untypeable') || SH.game.state().phase !== 'run') { abortUntypeable(); return; }
  setPhase('run');
  handleEvents(events);
  renderAll(true);
  startLoop();
}

function abortUntypeable() {
  stopLoop();
  disposeGame();
  showIntro('この配列では文を入力できないため、配列エディタで A〜Z と「ー」があるか確認してください');
}

// ---------- 1 コマ ----------

function startLoop() {
  if (SH.raf) return;
  const frame = () => {
    SH.raf = 0;
    if (SH.phase !== 'run' || !SH.game) return;
    const now = performance.now();
    SH.game.tick(now);
    const events = SH.game.takeEvents();
    if (events.length) handleEvents(events);
    if (SH.phase !== 'run') return;
    renderHud(now);
    SH.raf = requestAnimationFrame(frame);
  };
  SH.raf = requestAnimationFrame(frame);
}

function stopLoop() {
  if (SH.raf) cancelAnimationFrame(SH.raf);
  SH.raf = 0;
}

function handleEvents(events) {
  const r = SH.rules;
  const st = ctx.stage;
  let redraw = false;
  for (const e of events) {
    switch (e.kind) {
      case 'stage':
        banner('ステージ ' + e.stage, '必要なペースが上がります');
        playSound('shStage');
        st.wave({ color: '#ffffff', from: 'center', strength: 0.9, speed: 1.1 });
        break;
      case 'comboBonus':
        popup('連続' + r.comboEvery + '打　+' + r.comboBonus.toFixed(1) + '秒', 'bonus');
        playSound('shBonus');
        break;
      case 'missPenalty':
        popup('−' + e.sec.toFixed(1) + '秒', 'miss');
        break;
      case 'guard':
        popup('ガード', 'guard');
        break;
      case 'shieldGot':
        popup('シールド獲得（' + e.shields + '/' + r.shieldMax + '）', 'shield');
        playSound('shShield');
        st.wave({ color: GOLD, from: 'center', strength: 0.8 });
        break;
      case 'levelCleared':
        popup((e.perfect ? 'ノーミス　' : '') + '+' + e.carry.toFixed(1) + '秒 持ち越し', e.perfect ? 'perfect' : 'clear');
        playSound('shClear');
        st.wave({ color: e.perfect ? GOLD : SHUTTLE, from: 'left', strength: 0.85, speed: 1.5 });
        redraw = true;
        break;
      case 'partCleared':
        playSound('wordDone');
        redraw = true;
        break;
      case 'shieldUsed':
        popup('シールドで持ちこたえた！', 'shield');
        banner('シールド発動', '時間を回復し、' + r.invincibleSec + '秒間は無敵（時間が減らず、ミスも数えません）');
        playSound('shShield');
        st.wave({ color: GOLD, from: 'center', strength: 1 });
        SH.wordKey = '';
        redraw = true;
        break;
      case 'timeUp':
        timeUp();
        return;
      case 'untypeable':
        abortUntypeable();
        return;
      default: break;
    }
  }
  if (redraw) renderAll(true);
}

// ---------- 表示 ----------

function renderAll(fresh) {
  if (!SH.game) return;
  const s = SH.game.state();
  SH.game.cached = s;   // 毎コマの表示（renderHud）は、これを使う（状態は、打ったときと出来事のときにしか変わらない）
  renderPrompt(s, fresh);
  renderHud(performance.now(), s);
}

function charSpans(text, cls) {
  return [...text].map((c) => html`<span class="sh-ch ${cls}">${c}</span>`);
}

function renderPrompt(s, fresh) {
  const se = s.session;
  const word = s.word;
  let typed = '', cur = '', rest = '', kDone = '', kNow = '', kRest = '';
  se.chunks.forEach((c, i) => {
    const primary = c.options[0] || '';
    if (i < se.chunkIndex) { typed += c.typed; kDone += c.kana; }
    else if (i === se.chunkIndex) { typed += c.typed; const r = primary.slice(c.typed.length); cur = r[0] || ''; rest += r.slice(1); kNow += c.kana; }
    else { rest += primary; kRest += c.kana; }
  });
  setHtml('#shRomaji', html`${charSpans(typed, 't-done')}${charSpans(cur, 't-now')}${charSpans(rest, '')}`);
  $('#shRomaji').hidden = !S.settings.showRomaji;
  setHtml('#shKana', html`${charSpans(kDone, 't-done')}${charSpans(kNow, 't-now')}${charSpans(kRest, '')}`);
  const kanji = word ? word.kanji : '';
  $('#shKana').hidden = !S.settings.showKana || core.normalizeReading(kanji) === (word ? word.kana : '');
  const total = se.chunks.length || 1;
  const joined = se.chunks.map((c) => c.kana).join('');
  let split;
  if (core.normalizeReading(kanji) === joined && kanji.length === joined.length) split = se.chunks.slice(0, se.chunkIndex).reduce((n, c) => n + c.kana.length, 0);
  else split = Math.floor(kanji.length * (se.chunkIndex / total));
  setHtml('#shKanji', html`${charSpans(kanji.slice(0, split), 't-done')}${charSpans(kanji.slice(split), '')}`);
  const key = s.level + ':' + se.wordIndex;
  if (key !== SH.wordKey || fresh) {
    if (key !== SH.wordKey) {
      SH.wordKey = key;
      buildCracks(s.level * 31 + se.wordIndex * 7);
      const p = $('#shPrompt');
      p.classList.remove('is-in'); void p.offsetWidth; p.classList.add('is-in');
    }
    const next = s.nextWord;
    setHtml('#shNext', s.part && s.part[1] > 1
      ? html`<span class="sh-part num">${s.part[0] + 1} / ${s.part[1]}</span>${next ? html`<span class="sh-next-text">${next.kanji}</span>` : ''}`
      : '');
  }
  // 次のキー
  if (S.settings.showKeyGuide && SH.phase === 'run') {
    const g = guideFor(se.nextChar);
    ctx.stage.setTargets(g ? [{ code: g.code }, ...(g.shiftCode ? [{ code: g.shiftCode, role: 'shift' }] : [])] : []);
  } else ctx.stage.setTargets([]);
}

// 文に入るひび（残り時間が減るほど伸びる）
// ひび 1 本を短い線の集まりにして、残り時間が減るにつれ、根元から 1 本ずつ現れるようにする（途中で枝分かれもする）。
// data-from：その線が現れる「経過の割合」（0〜1）。残り時間の半分を切ったころから始まる
function buildCracks(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const segs = [];
  const seg = (x0, y0, x1, y1, from, w) => segs.push(`<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} L${x1.toFixed(1)} ${y1.toFixed(1)}" data-from="${from.toFixed(3)}" style="stroke-width:${w.toFixed(2)}"/>`);
  const CRACKS = 7;
  for (let i = 0; i < CRACKS; i++) {
    let x = 8 + rnd() * 84, y = rnd() < 0.5 ? 0 : 40;
    const dir = y === 0 ? 1 : -1;
    const start = 0.48 + (i / CRACKS) * 0.34;          // 1 本目は 48%、最後は 82% 経過したころから
    const steps = 4 + Math.floor(rnd() * 4);
    const stepGap = 0.035;                              // 次の線が現れるまでの間隔（経過の割合）
    for (let k = 0; k < steps; k++) {
      const nx = x + (rnd() - 0.5) * 16, ny = y + dir * (4 + rnd() * 7);
      const from = start + k * stepGap;
      seg(x, y, nx, ny, from, 1.9 - k * 0.18);           // 根元ほど太く、先ほど細い
      if (k === 1 || (k === 3 && rnd() < 0.6)) {          // 枝分かれ
        const bx = nx + (rnd() < 0.5 ? -1 : 1) * (4 + rnd() * 6), by = ny + dir * (2 + rnd() * 4);
        seg(nx, ny, bx, by, from + stepGap * 1.5, 1.1);
      }
      x = nx; y = ny;
    }
  }
  $('#shCracks').innerHTML = segs.join('');
  SH.dq = -1;
}

function renderShields(n, streak) {
  const box = $('#shShields');
  box.classList.toggle('is-on', n > 0);
  $$('.sh-shield-ico', box).forEach((node, i) => node.classList.toggle('is-on', i < n));
  $('#shShieldText').textContent = 'シールド ' + n + '/' + SH.rules.shieldMax;
  $$('#shStreak i').forEach((node, i) => node.classList.toggle('is-on', i < streak));
}

function renderHud(now, state) {
  const g = SH.game;
  if (!g) return;
  // 状態の JSON は打つほど長くなるので、毎コマは取り直さない（打ったとき・出来事のときに renderAll が取り直す）
  const s = state || g.cached || (g.cached = g.state());
  const rem = g.timeLeft(now);
  const ratio = Math.max(0, Math.min(1, rem / Math.max(0.001, s.limit)));
  const d = 1 - ratio;
  const dq = Math.round(d * 50) / 50;
  if (dq !== SH.dq) {
    SH.dq = dq;
    const stage = $('#shStage');
    stage.style.setProperty('--amp', (dq < 0.45 ? 0 : Math.pow((dq - 0.45) / 0.55, 2) * 3.2).toFixed(2));
    $('#shVeil').style.opacity = dq < 0.6 ? '0' : ((dq - 0.6) / 0.4).toFixed(2);
    for (const p of $$('#shCracks path')) p.classList.toggle('is-on', dq >= parseFloat(p.dataset.from));
    ctx.stage.setUrgency(Math.max(0, (dq - 0.45) / 0.55));
  }
  const band = ratio > 0.5 ? 'ok' : ratio > 0.25 ? 'warn' : 'crit';
  if (band !== SH.band) { SH.band = band; $('#shuttle').dataset.band = band; }
  $('#shTimeFill').style.width = (ratio * 100).toFixed(1) + '%';
  const num = Math.max(0, rem).toFixed(1);
  if (num !== SH.timeNum) { SH.timeNum = num; $('#shTimeNum').textContent = num; }   // 0.1 秒ごとにしか変わらない

  // 無敵
  const f = s.freezes.find((x) => now >= x[0] && now < x[1]);
  const kind = f && f[2] === 'inv' ? 'inv' : '';
  if (kind !== SH.freezeKind) {
    SH.freezeKind = kind;
    $('#shStage').classList.toggle('is-inv', kind === 'inv');
    $('#shuttle').dataset.freeze = kind;
    $('#shTimeState').hidden = !kind;
    const pill = $('#shFreeze');
    pill.hidden = !kind;
    if (kind) setHtml(pill, html`${icon.shield}<span>無敵</span><small>時間が減らず、ミスも数えません</small><b class="num" id="shFreezeNum"></b><i id="shFreezeBar"></i>`);
  }
  if (kind) {
    const left = Math.max(0, (f[1] - now) / 1000);
    const num = $('#shFreezeNum');
    if (num) num.textContent = left.toFixed(1);
    const bar = $('#shFreezeBar');
    if (bar) bar.style.transform = 'scaleX(' + Math.min(1, (left * 1000) / Math.max(1, f[1] - f[0])).toFixed(3) + ')';
  }

  // 心臓の音
  if (ratio < 0.3 && !kind && now - SH.lastBeat > (ratio < 0.15 ? 430 : 680)) { SH.lastBeat = now; playSound('shBeat'); }

  const hud = [s.level, s.comboCount, s.shields, s.perfectStreak, s.carryIn].join('|');
  if (hud !== SH.hudKey) {
    SH.hudKey = hud;
    $('#shLevel').textContent = String(s.level);
    $('#shStageName').textContent = 'ステージ ' + s.stage;
    $('#shPace').textContent = String(Math.round(core.shuttleLevelInfo(s.level).kps * 60));
    $('#shCombo').textContent = String(s.comboCount);
    $('#shComboRing').style.strokeDashoffset = (1 - s.comboCount / SH.rules.comboEvery).toFixed(3);
    renderShields(s.shields, s.perfectStreak);
    $('#shCarry').textContent = s.carryIn > 0 ? '+' + s.carryIn.toFixed(1) + '秒 持ち越し' : '持ち越しなし';
  }
}

function popup(text, kind) {
  const box = $('#shPopups');
  const node = document.createElement('div');
  node.className = 'sh-popup is-' + kind;
  node.textContent = text;
  node.style.setProperty('--x', ((Math.random() - 0.5) * 120).toFixed(0) + 'px');
  box.appendChild(node);
  while (box.children.length > 5) box.firstChild.remove();
  setTimeout(() => node.remove(), 1300);
}

function banner(title, sub) {
  const b = $('#shBanner');
  setHtml(b, html`<b>${title}</b><span>${sub}</span>`);
  b.hidden = false;
  b.classList.remove('is-show'); void b.offsetWidth; b.classList.add('is-show');
  clearTimeout(banner.t);
  banner.t = setTimeout(() => { b.hidden = true; }, 2300);
}

// ---------- 止める・終わる ----------

export function pause() {
  if (SH.phase !== 'run' || !SH.game) return;
  stopLoop();
  SH.game.pause(performance.now());
  setPhase('paused');
  ctx.stage.setTargets([]);
  panel(html`
    <p class="eyebrow">PAUSED</p>
    <p class="sh-over-title">一時停止中</p>
    <p class="sh-meta">一時停止中は時間が進みません</p>
    <div class="row wrap sh-actions">
      <button class="btn btn-l sh-go" data-act="shuttle.resume"><kbd>Space</kbd>再開する</button>
      <button class="btn btn-l btn-ghost" data-act="shuttle.quit"><kbd>Esc</kbd>やめる</button>
    </div>`);
}

function resume() {
  if (SH.phase !== 'paused' || !SH.game) return;
  SH.game.resume(performance.now());
  panel(null);
  setPhase('run');
  renderAll(true);
  startLoop();
}

function quitRun() {
  stopLoop();
  clearInterval(SH.timer);
  $('#shCount').hidden = true;
  disposeGame();
  showIntro();
}

function timeUp() {
  stopLoop();
  const now = performance.now();
  const g = SH.game;
  setPhase('over');
  const st = ctx.stage;
  st.setTargets([]);
  renderHud(now);
  // 文が砕け散る
  for (const node of $$('#shStage .sh-ch')) {
    const a = Math.random() * Math.PI * 2, r = 120 + Math.random() * 380;
    node.style.setProperty('--fx', (Math.cos(a) * r).toFixed(0) + 'px');
    node.style.setProperty('--fy', (Math.sin(a) * r * 0.6 + 160).toFixed(0) + 'px');
    node.style.setProperty('--fr', ((Math.random() - 0.5) * 720).toFixed(0) + 'deg');
  }
  $('#shStage').classList.add('is-shatter');
  playSound('shBreak');
  st.wave({ color: DANGER, from: 'center', strength: 1.2, speed: 1.3 });

  const raw0 = historyRaw();
  const prevBest = core.shuttleBestFor(S.layout.name, raw0);
  const rec = g.record(newId('s_'), Date.now(), now, S.layout.name);
  const list = core.pushShuttleRecord(raw0, rec);
  lsWrite(K.shuttle, JSON.stringify(list));
  const hadStore = (() => { try { const p = JSON.parse(rawGet(K.trophies) || 'null'); return Boolean(p) && typeof p === 'object' && !Array.isArray(p); } catch { return false; } })();
  const upd = core.updateTrophies(hadStore ? rawGet(K.trophies) : null, JSON.stringify(list), rec, Date.now());
  lsWrite(K.trophies, JSON.stringify(upd.store));
  markDataChanged();
  SH.rec = rec;
  disposeGame();
  setTimeout(() => {
    if (SH.phase !== 'over' || !SH.open) return;
    st.setPose('over', 1.6);
    st.setUrgency(0);
    showOver(rec, prevBest, upd.fresh || []);
    ctx.maybeBackupReminder(1400, 'shuttle');
  }, 1100);
}

function duration(sec) {
  const s = Math.round(sec);
  return s >= 60 ? Math.floor(s / 60) + '分' + (s % 60) + '秒' : s + '秒';
}

/** レベルごとの「使った時間 / 制限時間」の棒グラフ。 */
export function levelChart(levels) {
  if (!levels || !levels.length) return raw('');
  const W = 560, H = 120, pad = 18;
  const max = Math.max(...levels.map((l) => Math.max(l.limit, l.used)), 1);
  const bw = Math.min(26, (W - pad) / levels.length);
  const bars = levels.map((l, i) => {
    const x = pad + i * bw;
    const hl = (l.limit / max) * (H - 22), hu = (Math.min(l.used, l.limit) / max) * (H - 22);
    const label = i % 5 === 0 || i === levels.length - 1;
    return html`<g><title>レベル ${l.lv}：制限 ${l.limit.toFixed(1)}秒 / ${l.fail ? '時間切れ' : l.used.toFixed(1) + '秒でクリア'}${l.miss ? '・ミス ' + l.miss : ''}</title>
      <rect x="${(x + 1).toFixed(1)}" y="${(H - 14 - hl).toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${hl.toFixed(1)}" rx="2" class="lim"/>
      <rect x="${(x + 1).toFixed(1)}" y="${(H - 14 - hu).toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${hu.toFixed(1)}" rx="2" class="${l.fail ? 'fail' : l.miss ? 'used' : 'perfect'}"/>
      ${label ? html`<text x="${(x + bw / 2).toFixed(1)}" y="${H - 2}">${l.lv}</text>` : ''}</g>`;
  });
  return html`<svg viewBox="0 0 ${W} ${H}" class="sh-chart" role="img" aria-label="レベルごとの使った時間と制限時間">${bars}</svg>
    <div class="sh-chart-legend"><span><i class="lim"></i>制限時間</span><span><i class="perfect"></i>ノーミスでクリア</span><span><i class="used"></i>ミスありでクリア</span><span><i class="fail"></i>時間切れ</span></div>`;
}

function showOver(rec, prevBest, freshIds) {
  const isNew = !prevBest || rec.cleared > prevBest.cleared;
  const table = core.trophyTable(), tiers = core.trophyTiers();
  const fresh = table.filter((t) => freshIds.includes(t.id));
  const stats = [
    ['正しく打った数', rec.keys.toLocaleString() + ' 打'],
    ['正確率', rec.accuracy.toFixed(1) + '%'],
    ['平均の速さ', rec.kpm + ' 打/分'],
    ['最大連続', rec.maxCombo + ' 打'],
    ['最後に必要だったペース', Math.round(core.shuttleLevelInfo(rec.level).kps * 60) + ' 打/分'],
    ['プレイ時間', duration(rec.durationSec)],
  ];
  panel(html`
    <div class="sh-over-head">
      <div class="sh-over-lv"><p class="eyebrow">到達レベル</p><div class="sh-over-level3d" id="shLevel3d" aria-hidden="true"></div><div class="sh-over-level num">${rec.level}</div></div>
      <div class="sh-over-sub">
        <p class="sh-over-title">${rec.cleared ? rec.cleared + ' レベルクリア' : '最初のレベルで時間切れ'}</p>
        ${isNew && rec.cleared > 0 ? html`<span class="chip chip-accent">${prevBest ? '自己ベスト更新（前回まで レベル ' + prevBest.level + '）' : '初めての記録'}</span>` : ''}
        ${isNew ? '' : html`<p class="sh-meta">この配列の最高記録はレベル ${prevBest.level}</p>`}
      </div>
    </div>
    ${fresh.length ? html`<div class="sh-new-trophies"><p class="sh-new-title">トロフィー獲得！</p>${fresh.map((t, i) => html`
      <div class="sh-new-trophy" data-i="${i}" data-tier="${t.tier}">${trophySvg(t, tiers, true)}<div><b>${t.name}</b><span>${(tiers.find((x) => x.id === t.tier) || {}).label}・${t.desc}</span></div></div>`)}</div>` : ''}
    <div class="sh-stats">${stats.map(([k, v]) => html`<div><span>${k}</span><b class="num">${v}</b></div>`)}</div>
    <div class="sh-chart-box">${levelChart(rec.levels)}</div>
    <div class="row wrap sh-actions">
      <button class="btn btn-l sh-go" data-act="shuttle.start"><kbd>Space</kbd>もう一度</button>
      <button class="btn btn-l btn-ghost" data-act="shuttle.close"><kbd>Esc</kbd>通常の練習に戻る</button>
      <button class="btn btn-l btn-ghost" data-act="shuttle.levels">レベル一覧</button>
    </div>`);
  $$('.sh-new-trophy').forEach((node) => node.style.setProperty('--delay', (0.15 + Number(node.dataset.i) * 0.12).toFixed(2) + 's'));
  if (fresh.length) ctx.stage.wave({ rainbow: true, from: 'left', strength: 1, speed: 0.9 });
  // 到達レベルを立体にして回す（描けない環境では、ふつうの文字）
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const host = $('#shLevel3d');
  if (host && showText3d(host, { text: String(rec.level), color: '#2fe0c8', reducedMotion: reduced, low: S.settings.lowQuality })) host.parentElement.classList.add('is-3d');
}

// ---------- キー ----------

/** @returns {boolean} シャトルランが受け取ったか */
export function shuttleKeyDown(e) {
  if (!SH.open) return false;
  const inField = e.target instanceof Element && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (inField || e.ctrlKey || e.metaKey || e.altKey) return true;
  const reader = S.reader;
  const esc = e.key === 'Escape' && !reader.isCalibratedCharKey(e);
  const go = e.code === 'Space' || e.key === 'Enter';
  if (!e.repeat && (go || e.key === 'Shift' || e.key === 'Escape' || e.key === 'Backspace' || e.key === 'Tab')) ctx.press(e, e.code, 'neutral');
  if (SH.phase === 'intro') {
    if (go) { e.preventDefault(); if (!e.repeat) countdown(); } else if (esc) { e.preventDefault(); closeShuttle(); }
    return true;
  }
  if (SH.phase === 'count') {
    if (esc) { e.preventDefault(); quitRun(); } else if (go) e.preventDefault();
    return true;
  }
  if (SH.phase === 'paused') {
    e.preventDefault();
    if (!e.repeat) { if (go) resume(); else if (esc) quitRun(); }
    return true;
  }
  if (SH.phase === 'over') {
    e.preventDefault();
    if (e.repeat || $('#shPanel').hidden) return true;
    if (go) countdown(); else if (esc) closeShuttle();
    return true;
  }
  if (SH.phase !== 'run' || !SH.game) return true;
  if (esc) { e.preventDefault(); pause(); return true; }

  const reading = reader.reading(e);
  if (reading && reading.code === '@shift') {
    e.preventDefault();
    SH.virtualShift[core.keySignalOf(e.code || '', e.key || '', Boolean(e.shiftKey), false)] = true;
    if (!e.repeat) ctx.press(e, 'ShiftLeft', 'neutral');
    return true;
  }
  if (e.key === 'Shift' || ['Control', 'Alt', 'Meta', 'Tab', 'CapsLock'].includes(e.key)) return true;
  if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); return true; }
  const resolved = reader.resolve(e, Object.keys(SH.virtualShift).length > 0);
  if (!resolved || !resolved.char) { if (e.key === 'Enter') e.preventDefault(); return true; }
  e.preventDefault();
  const g = SH.game;
  // Shift あり・なしの 2 つの文字のうち、正解になる方を使う
  const ch = g.chooseInputChar(resolved.char, resolved.altChar);
  const now = performance.now();
  const out = g.input(ch, resolved.code, now);
  if (out.kind === 'correct') {
    ctx.press(e, resolved.code, 'correct');
    playSound('key');
  } else if (out.kind === 'mistake' || out.kind === 'guarded') {
    ctx.press(e, resolved.code, 'miss');
    if (out.kind === 'mistake') playSound('error');
    const p = $('#shPrompt');
    p.classList.remove('is-miss'); void p.offsetWidth; p.classList.add('is-miss');
  }
  const events = g.takeEvents();
  if (events.length) handleEvents(events);
  if (SH.phase === 'run' && SH.game) renderAll(false);
  return true;
}

export function shuttleKeyUp(e) {
  const sig = core.keySignalOf(e.code || '', e.key || '', Boolean(e.shiftKey), false);
  if (SH.virtualShift[sig]) delete SH.virtualShift[sig];
}

export function shuttlePause() { if (SH.open && SH.phase === 'run') pause(); }
export { toast };
