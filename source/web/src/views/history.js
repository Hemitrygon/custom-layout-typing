// 「記録」の画面：通常の練習（スコアの推移・練習文ごとの得意不得意・配列別・一覧）と、シャトルラン（トロフィー・記録）。
// 数の整え方は Rust。絞り込み・難易度補正・グラフの描画はここ。
import { core } from '../core.js';
import { S, bus, loadHistory, saveHistory } from '../model.js';
import { K, lsRead, lsWrite, lsRemove, rawGet, storageAvailable } from '../store.js';
import { $, html, raw, setHtml, act, formatDate, esc } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast, confirmDialog } from '../ui/overlay.js';
import { LAYOUT_COLOR_FIXED, LAYOUT_COLOR_EXTRA, LAYOUT_COLOR_OVERFLOW, layoutColorAll } from '../theme.js';
import { trophySvg, levelChart } from './shuttle.js';

const H = {
  kind: 'normal',          // 'normal' | 'shuttle'
  layout: 'all',
  course: 'all',
  range: '20',
  metric: 'score',
  correction: true,
  allMode: 'split',        // 'split'（配列ごと）| 'combined'（まとめて 1 本）
  dateAxis: true,
  factors: {},
  active: false,
};
let resizeTimer = 0;

const METRICS = {
  score: { label: 'スコア', unit: '', get: (r) => r.score, fmt: (v) => Math.round(v).toLocaleString(), zeroBase: true },
  wpm: { label: 'WPM', unit: ' WPM', get: (r) => r.wpm, fmt: (v) => String(Math.round(v)), zeroBase: true },
  cpm: { label: '文字/分', unit: ' 文字/分', get: (r) => r.cpm, fmt: (v) => String(Math.round(v)), zeroBase: true },
  accuracy: { label: '正確率', unit: '%', get: (r) => r.accuracy, fmt: (v) => Number(v).toFixed(1), zeroBase: false },
  rhythm: { label: 'リズム', unit: '%', get: (r) => r.rhythm, fmt: (v) => Number(v).toFixed(1), zeroBase: false },
};
const CORRECTABLE = ['score', 'wpm', 'cpm'];   // 速さに関わる数だけ、練習文の難しさで補正する

const courseKeyOf = (r) => r.courseKey || 'name:' + (r.presetName || '');
const courseNameOf = (r) => r.courseName || r.presetName || '練習文';
const factorKey = (r) => (r.layoutName || '') + '\n' + courseKeyOf(r);
const metricValue = (r, m) => { const v = METRICS[m].get(r); return typeof v === 'number' && Number.isFinite(v) ? v : null; };
const median = (arr) => { const s = arr.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------- 配列ごとの色 ----------

let colorCache = { src: null, len: -1, map: null };
function layoutColor(name) {
  const hist = S.history;
  if (colorCache.src !== hist || colorCache.len !== hist.length) {
    const map = new Map();
    let next = 0;
    for (const r of hist) {
      const n = r.layoutName || '不明';
      if (map.has(n)) continue;
      if (Object.prototype.hasOwnProperty.call(LAYOUT_COLOR_FIXED, n)) map.set(n, LAYOUT_COLOR_FIXED[n]);
      else map.set(n, next < LAYOUT_COLOR_EXTRA.length ? LAYOUT_COLOR_EXTRA[next++] : LAYOUT_COLOR_OVERFLOW);
    }
    colorCache = { src: hist, len: hist.length, map };
  }
  const key = name || '不明';
  return colorCache.map.get(key) || (Object.prototype.hasOwnProperty.call(LAYOUT_COLOR_FIXED, key) && LAYOUT_COLOR_FIXED[key]) || LAYOUT_COLOR_OVERFLOW;
}

// ---------- 難易度補正（旧版（v5）の computeCourseFactors と同じ） ----------
// 練習文（コース）ごと・配列ごとに「その頃の自分の実力に比べて、どれだけ点が出やすいか」の係数を出す。
// 実力は、同じ配列で前後に打った「ほかの練習文」の結果から見積もる。回数が少ないうちは 1 に寄せる。
const WINDOW = 15, SIDE = 3, TREND = 6;
function computeCourseFactors(records, metric) {
  const rows = [];
  for (const r of records) { const v = metricValue(r, metric); if (v !== null && v > 0) rows.push({ c: factorKey(r), l: r.layoutName || '', v }); }
  const courses = [...new Set(rows.map((x) => x.c))];
  const f = Object.create(null);
  for (const c of courses) f[c] = 1;
  if (courses.length < 2) return f;
  const layoutOf = Object.create(null);
  for (const x of rows) layoutOf[x.c] = x.l;
  const sideOf = (k, dir, max) => {
    const out = [];
    for (let d = 1; d <= WINDOW && out.length < max; d++) {
      const j = k + dir * d;
      if (j < 0 || j >= rows.length) break;
      if (rows[j].c !== rows[k].c && rows[j].l === rows[k].l) out.push({ v: Math.log(rows[j].v / f[rows[j].c]), t: dir * d });
    }
    return out;
  };
  const mean = (arr, key) => arr.reduce((a, o) => a + o[key], 0) / arr.length;
  for (let iter = 0; iter < 40; iter++) {
    const logs = Object.create(null);
    for (const c of courses) logs[c] = [];
    rows.forEach((x, k) => {
      const before = sideOf(k, -1, SIDE), after = sideOf(k, 1, SIDE);
      let level;
      if (before.length && after.length) {
        const db = -mean(before, 't'), da = mean(after, 't');
        level = (mean(before, 'v') * da + mean(after, 'v') * db) / (da + db);
      } else {
        const side = sideOf(k, before.length ? -1 : 1, TREND);
        if (side.length < 3) return;
        const mt = mean(side, 't'), mv = mean(side, 'v');
        let sxy = 0, sxx = 0;
        for (const o of side) { sxy += (o.t - mt) * (o.v - mv); sxx += (o.t - mt) * (o.t - mt); }
        level = mv - (sxx ? sxy / sxx : 0) * mt;
      }
      logs[x.c].push(Math.log(x.v) - level);
    });
    const nf = Object.create(null);
    for (const c of courses) { const L = logs[c]; nf[c] = L.length ? Math.exp(median(L) * (L.length / (L.length + 3))) : 1; }
    const sum = Object.create(null), cnt = Object.create(null);
    for (const x of rows) { sum[x.l] = (sum[x.l] || 0) + Math.log(nf[x.c]); cnt[x.l] = (cnt[x.l] || 0) + 1; }
    let maxDelta = 0;
    for (const c of courses) {
      const l = layoutOf[c];
      const next = nf[c] / Math.exp(sum[l] / cnt[l]);
      maxDelta = Math.max(maxDelta, Math.abs(next - f[c]));
      f[c] = next;
    }
    if (maxDelta < 0.0005) break;
  }
  return f;
}

const correctionActive = (records) => H.correction && H.course === 'all' && new Set(records.map(courseKeyOf)).size >= 2;
function valueOf(r, metric, corrected) {
  const v = metricValue(r, metric);
  if (v === null || !corrected || !CORRECTABLE.includes(metric)) return v;
  return v / ((H.factors[metric] || {})[factorKey(r)] || 1);
}

// ---------- 骨組み ----------

export const historyView = {
  mount(root) {
    H.dateAxis = rawGet(K.dateAxis) !== '0';
    setHtml(root, html`
      <div class="panel glass">
        <div class="panel-head">
          <h1 class="panel-title">記録</h1>
          <div class="seg seg-accent" role="group" aria-label="記録の種類">
            <button data-act="hist.kind" data-arg="normal" aria-pressed="true">通常の練習</button>
            <button data-act="hist.kind" data-arg="shuttle" aria-pressed="false">シャトルラン</button>
          </div>
          <span class="panel-sub grow" id="histLead"></span>
          <button class="btn btn-s btn-ghost" data-act="nav" data-arg="practice">練習画面へ戻る</button>
        </div>
        <div class="panel-body" id="histBody"></div>
      </div>`);
    act({
      'hist.kind': (v) => { H.kind = v === 'shuttle' ? 'shuttle' : 'normal'; render(); $('#histBody').scrollTop = 0; },
      'hist.layout': (v) => { H.layout = v || 'all'; render(); },
      'hist.course': (v) => { H.course = v || 'all'; render(); },
      'hist.range': (v) => { H.range = v; render(); },
      'hist.metric': (v) => { if (METRICS[v]) { H.metric = v; render(); } },
      'hist.mode': (v) => { H.allMode = v === 'combined' ? 'combined' : 'split'; render(); },
      'hist.correction': (v) => { H.correction = v === 'true'; render(); },
      'hist.dateAxis': (v) => { H.dateAxis = v === 'true'; lsWrite(K.dateAxis, H.dateAxis ? '1' : '0'); render(); },
      'hist.delete': (id) => deleteRecord(id),
      'hist.clear': () => clearAll(),
      'hist.clearShuttle': () => clearShuttle(),
    });
    bus.on('history', () => { if (H.active) render(); });
    // 別のウィンドウで記録が増えた・消えたときは、読み直してから描く
    bus.on('storage', (key) => {
      if (key === null || key === K.history) loadHistory();
      if (H.active && (key === null || key === K.history || key === K.shuttle || key === K.trophies)) render();
    });
    // グラフは枠の幅に合わせて描くので、幅が変わったら描き直す
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (H.active && H.kind === 'normal') render(); }, 160);
    });
  },
  enter() { H.active = true; render(); },
  leave() { H.active = false; },
};

function render() {
  for (const b of document.querySelectorAll('[data-act="hist.kind"]')) b.setAttribute('aria-pressed', String(b.dataset.arg === H.kind));
  $('#histLead').textContent = H.kind === 'shuttle'
    ? 'トロフィーは配列に関係なく獲得でき、記録を削除しても残ります'
    : '最後まで打ち終えた回のみ記録されます';
  if (H.kind === 'shuttle') renderShuttle(); else renderNormal();
}

// ---------- 通常の練習 ----------

function renderNormal() {
  const all = S.history;
  const layoutNames = [];
  for (const r of all) if (r.layoutName && !layoutNames.includes(r.layoutName)) layoutNames.push(r.layoutName);
  if (H.layout !== 'all' && !layoutNames.includes(H.layout)) H.layout = 'all';
  const courseNames = new Map();
  for (const r of all) courseNames.set(courseKeyOf(r), courseNameOf(r));
  if (H.course !== 'all' && !courseNames.has(H.course)) H.course = 'all';

  H.factors = Object.create(null);
  for (const m of CORRECTABLE) H.factors[m] = computeCourseFactors(all, m);
  const filtered = all.filter((r) => (H.layout === 'all' || r.layoutName === H.layout) && (H.course === 'all' || courseKeyOf(r) === H.course));
  const corrected = correctionActive(filtered);
  const canCorrect = H.course === 'all' && new Set(filtered.map(courseKeyOf)).size >= 2;
  const corrNote = !canCorrect
    ? (H.course !== 'all' ? '1 つの練習文のみ表示中（補正なしでそのまま比較できます）' : '')
    : corrected && Object.values(H.factors.score || {}).every((v) => Math.abs(v - 1) < 0.001)
      ? '記録が少ないため、まだ補正していません'
      : corrected ? (CORRECTABLE.includes(H.metric) ? '練習文ごとの「スコアの出やすさ」で割って揃えています' : '正確率とリズムは割合のため補正していません')
        : '補正なし（練習文によって有利・不利があります）';

  // まとめの数字
  const scored = filtered.filter((r) => typeof r.score === 'number');
  const best = scored.reduce((m, r) => (!m || r.score > m.score ? r : m), null);
  const avgScore = scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : 0;
  const latest = filtered[filtered.length - 1];
  const bestWpm = filtered.reduce((m, r) => Math.max(m, r.wpm || 0), 0);
  const avgWpm = filtered.length ? Math.round(filtered.reduce((s, r) => s + (r.wpm || 0), 0) / filtered.length) : 0;
  const avgAcc = filtered.length ? (filtered.reduce((s, r) => s + (r.accuracy || 0), 0) / filtered.length).toFixed(1) : '0.0';
  const totalKana = filtered.reduce((s, r) => s + (r.completedKana || 0), 0);
  const bestRank = best ? core.scoreRank(best.score).rank : null;
  const metric = METRICS[H.metric];
  const canSplit = H.layout === 'all' && new Set(filtered.map((r) => r.layoutName || '不明')).size >= 2;

  const option = (value, label, cur) => html`<option value="${value}" ${cur === value ? raw('selected') : ''}>${label}</option>`;
  setHtml('#histBody', html`
    <div class="hist-filters">
      <label>配列<select class="field" data-change="hist.layout">${option('all', '全ての配列', H.layout)}${layoutNames.map((n) => option(n, n, H.layout))}</select></label>
      <label>練習文<select class="field" data-change="hist.course">${option('all', '全ての練習文', H.course)}${[...courseNames.entries()].map(([k, n]) => option(k, n, H.course))}</select></label>
      <label>期間<select class="field" data-change="hist.range">${[['20', '直近20回'], ['50', '直近50回'], ['100', '直近100回'], ['all', '全て']].map(([v, l]) => option(v, l, H.range))}</select></label>
      <span class="grow"></span>
      <button class="btn btn-s btn-danger" data-act="hist.clear" ${all.length ? '' : raw('disabled')}>${icon.trash}履歴を全削除</button>
    </div>

    <div class="hist-stats">
      <div class="hist-stat is-hero">
        <i>最高スコア</i>
        <div class="hist-stat-main">${bestRank ? html`<span class="rank-pill" data-c="${bestRank.color}">${bestRank.rank}</span>` : ''}<b class="num">${best ? best.score.toLocaleString() : '0'}</b></div>
        <small>${best ? best.layoutName + '・' + formatDate(best.timestamp) : '記録なし'}</small>
      </div>
      <div class="hist-stat"><i>平均スコア</i><div class="hist-stat-main"><b class="num">${avgScore.toLocaleString()}</b></div>
        <small>直近: ${latest && typeof latest.score === 'number' ? latest.score.toLocaleString() + '（' + core.scoreRank(latest.score).rank.rank + '）' : '-'}</small></div>
      <div class="hist-stat"><i>最高 WPM</i><div class="hist-stat-main"><b class="num">${bestWpm}</b><em>WPM</em></div><small>平均 ${filtered.length ? avgWpm : '-'} WPM</small></div>
      <div class="hist-stat"><i>平均正確率</i><div class="hist-stat-main"><b class="num">${avgAcc}</b><em>%</em></div><small>完走 ${filtered.length} 回${filtered.length ? '・計 ' + totalKana.toLocaleString() + ' 文字' : ''}</small></div>
    </div>

    <section class="card hist-card">
      <div class="hist-card-head">
        <h2 class="section-title">${metric.label}の推移${corrected && CORRECTABLE.includes(H.metric) ? '（難易度補正）' : ''}</h2>
        <span class="grow"></span>
        ${canSplit ? html`<div class="seg" role="group" aria-label="線の分け方">${[['split', '配列ごと'], ['combined', 'まとめて1本']].map(([k, l]) => html`<button data-act="hist.mode" data-arg="${k}" aria-pressed="${String(H.allMode === k)}">${l}</button>`)}</div>` : ''}
        <div class="seg" role="group" aria-label="見る数">${Object.entries(METRICS).map(([k, m]) => html`<button data-act="hist.metric" data-arg="${k}" aria-pressed="${String(H.metric === k)}">${m.label}</button>`)}</div>
      </div>
      <div class="hist-chart" id="histChart"></div>
      <div class="hist-chart-foot">
        <label class="check"><input type="checkbox" data-change="hist.dateAxis" ${H.dateAxis ? raw('checked') : ''}>横軸に日付を表示</label>
        ${canCorrect ? html`<label class="check"><input type="checkbox" data-change="hist.correction" ${H.correction ? raw('checked') : ''}>難易度補正</label>` : ''}
        <span class="section-note">${corrNote}</span>
      </div>
    </section>

    <div class="hist-two">
      <section class="card hist-card">
        <h2 class="section-title">練習文ごとの得意・不得意</h2>
        <p class="section-note">同じ配列で、近い時期に他の練習文で出したスコアと比べた「スコアの出やすさ」です</p>
        <div class="hist-list" id="histCourses"></div>
      </section>
      <section class="card hist-card">
        <h2 class="section-title">配列別の${metric.label}</h2>
        <p class="section-note" id="histLayoutNote"></p>
        <div class="hist-list" id="histLayouts"></div>
      </section>
    </div>

    <section class="card hist-card">
      <h2 class="section-title">完走の一覧</h2>
      <div class="hist-records" id="histRecords"></div>
    </section>`);
  for (const p of document.querySelectorAll('#histBody .hist-stats .rank-pill')) p.style.setProperty('--rank', p.dataset.c);
  renderChart(filtered, corrected);
  renderCourses();
  renderLayoutBars();
  renderRecords(filtered);
}

function niceCeil(v) {
  if (!(v > 0)) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (v <= m * pow) return m * pow;
  return 10 * pow;
}

/** スコアの推移の折れ線グラフ（線の上をなぞると、その回の数が出る）。 */
function renderChart(records, correctedView) {
  const host = $('#histChart');
  const mk = H.metric, metric = METRICS[mk];
  const corrected = correctedView && CORRECTABLE.includes(mk);
  const valid = [];
  records.forEach((r, i) => { const v = valueOf(r, mk, corrected); if (v !== null) valid.push({ r, v, rawV: metricValue(r, mk), n: i + 1 }); });
  const limit = H.range === 'all' ? Infinity : parseInt(H.range, 10) || 20;
  const pts = valid.slice(-limit);
  if (!pts.length) {
    setHtml(host, html`<div class="hist-empty"><b>表示できる完走記録がありません</b><span>練習文を最後まで打ち終えて結果画面まで進むと、ここに推移が表示されます</span></div>`);
    return;
  }
  const filterAll = H.layout === 'all';
  const names = [];
  for (const p of pts) { const n = p.r.layoutName || '不明'; if (!names.includes(n)) names.push(n); }
  const firstSeen = new Map();
  S.history.forEach((r, k) => { const n = r.layoutName || '不明'; if (!firstSeen.has(n)) firstSeen.set(n, k); });
  names.sort((a, b) => (firstSeen.get(a) || 0) - (firstSeen.get(b) || 0));
  const split = filterAll && names.length >= 2 && H.allMode === 'split';

  const W = Math.max(360, Math.round(host.clientWidth) || 1000), HH = 300, padL = 52, padR = 74, padT = 14, padB = H.dateAxis ? 44 : 28;
  const vals = pts.map((p) => p.v);
  let lo = metric.zeroBase ? 0 : Math.min(...vals), hi = Math.max(...vals);
  if (metric.zeroBase) hi = niceCeil(hi * 1.08);
  else { const pad = Math.max(1, (hi - lo) * 0.2); lo = Math.max(0, Math.floor(lo - pad)); hi = Math.min(100, Math.ceil(hi + pad)); if (hi - lo < 2) { lo = Math.max(0, lo - 1); hi = Math.min(100, hi + 1); } }
  const x = (i) => padL + (pts.length === 1 ? (W - padL - padR) / 2 : (i / (pts.length - 1)) * (W - padL - padR));
  const y = (v) => padT + (1 - (v - lo) / (hi - lo || 1)) * (HH - padT - padB);

  const grid = [];
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    grid.push(`<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="ytick" x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}">${esc(metric.fmt(v))}</text>`);
  }
  // 横軸：回の番号と、日付（同じ日が続くときは最初の 1 つだけ。年をまたぐときは年も）
  const xt = [];
  const every = Math.max(1, Math.ceil(pts.length / 12));
  let prevDay = '', prevYear = null;
  pts.forEach((p, i) => {
    const d = new Date(p.r.timestamp);
    const day = d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
    const newDay = day !== prevDay;
    if (i % every === 0 || i === pts.length - 1) xt.push(`<text class="xtick" x="${x(i).toFixed(1)}" y="${HH - padB + 16}">#${p.n}</text>`);
    if (H.dateAxis && newDay) {
      if (i > 0) xt.push(`<line class="day" x1="${(x(i) - (x(1) - x(0)) / 2).toFixed(1)}" x2="${(x(i) - (x(1) - x(0)) / 2).toFixed(1)}" y1="${padT}" y2="${HH - padB}"/>`);
      const label = (prevYear !== null && d.getFullYear() !== prevYear ? d.getFullYear() + '/' : '') + (d.getMonth() + 1) + '/' + d.getDate();
      xt.push(`<text class="xdate" x="${x(i).toFixed(1)}" y="${HH - padB + 32}">${label}</text>`);
    }
    prevDay = day; prevYear = d.getFullYear();
  });

  const series = split ? names.map((n) => ({ name: n, color: layoutColor(n), idx: pts.map((p, i) => ((p.r.layoutName || '不明') === n ? i : -1)).filter((i) => i >= 0) }))
    : [{ name: filterAll ? '全ての配列' : H.layout, color: filterAll ? layoutColorAll() : layoutColor(H.layout), idx: pts.map((_, i) => i) }];
  const marks = series.map((s) => {
    const line = s.idx.map((i, k) => (k ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(pts[i].v).toFixed(1)).join(' ');
    const dots = pts.length <= 60 ? s.idx.map((i) => `<circle class="pt" cx="${x(i).toFixed(1)}" cy="${y(pts[i].v).toFixed(1)}" r="4" fill="${s.color}"/>`).join('') : '';
    return `<path class="line" d="${line}" stroke="${s.color}"/>${dots}`;
  }).join('');
  // まとめて 1 本のときは、5 回移動平均も重ねる
  let avgLine = '';
  if (!split && filterAll && pts.length >= 5) {
    const d = pts.map((_, i) => { const from = Math.max(0, i - 4); const seg = pts.slice(from, i + 1); return seg.reduce((a, p) => a + p.v, 0) / seg.length; })
      .map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
    avgLine = `<path class="avg" d="${d}"/>`;
  }
  // 期間内の最高：横の点線と、右端の値（旧版（v5）と同じ）
  const best = Math.max(...vals);
  const bestY = y(best).toFixed(1);
  const bestLine = `<line class="best" x1="${padL}" x2="${W - padR}" y1="${bestY}" y2="${bestY}"/><text class="best-label" x="${W - padR + 8}" y="${(Number(bestY) + 4).toFixed(1)}">最高 ${esc(metric.fmt(best))}</text>`;
  const bestKey = html`<span><i class="is-best"></i>期間内の最高</span>`;
  const legend = series.length >= 2
    ? html`<div class="hist-legend">${series.map((s) => html`<span><i data-c="${s.color}"></i>${s.name}</span>`)}${bestKey}</div>`
    : html`<div class="hist-legend"><span><i data-c="${series[0].color}"></i>各回</span>${avgLine ? html`<span><i class="is-dash"></i>5回移動平均</span>` : ''}${bestKey}</div>`;

  setHtml(host, html`${legend}
    <div class="hist-plot">
      <svg viewBox="0 0 ${W} ${HH}" width="${W}" height="${HH}" role="img" aria-label="${metric.label}の推移（${pts.length}回分）">${raw(grid.join('') + xt.join('') + bestLine + avgLine + marks)}<line class="cross" id="histCross" y1="${padT}" y2="${HH - padB}" x1="0" x2="0" visibility="hidden"/></svg>
      <div class="hist-tip" id="histTip" hidden></div>
    </div>
    <div class="hist-count num">${pts.length} 回分</div>`);
  for (const i of host.querySelectorAll('.hist-legend i[data-c]')) i.style.background = i.dataset.c;

  // なぞったときの表示
  const svg = host.querySelector('svg'), tip = $('#histTip'), cross = $('#histCross');
  const move = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let bestI = 0, bestD = Infinity;
    pts.forEach((_, i) => { const d = Math.abs(x(i) - px); if (d < bestD) { bestD = d; bestI = i; } });
    const p = pts[bestI];
    cross.setAttribute('x1', x(bestI).toFixed(1)); cross.setAttribute('x2', x(bestI).toFixed(1)); cross.setAttribute('visibility', 'visible');
    setHtml(tip, html`<b class="num">${metric.fmt(p.v)}${metric.unit}</b>${corrected && p.rawV !== null ? html`<small>補正前 ${metric.fmt(p.rawV)}</small>` : ''}
      <span><i class="dot" data-c="${layoutColor(p.r.layoutName)}"></i>${p.r.layoutName || '不明'}・${courseNameOf(p.r)}</span><span class="faint">#${p.n}・${formatDate(p.r.timestamp)}</span>`);
    const dot = tip.querySelector('.dot'); if (dot) dot.style.color = dot.dataset.c;
    tip.hidden = false;
    const left = (x(bestI) / W) * r.width;
    tip.style.left = Math.max(70, Math.min(r.width - 70, left)) + 'px';
    tip.style.top = Math.max(0, (y(p.v) / HH) * r.height - 12) + 'px';
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
}

function renderCourses() {
  const pool = S.history.filter((r) => H.layout === 'all' || r.layoutName === H.layout);
  const layouts = new Map();
  for (const r of pool) {
    if (typeof r.score !== 'number') continue;
    const ln = r.layoutName || '';
    if (!layouts.has(ln)) layouts.set(ln, new Map());
    const groups = layouts.get(ln);
    const k = factorKey(r);
    if (!groups.has(k)) groups.set(k, { key: k, name: courseNameOf(r), n: 0, sum: 0, best: 0 });
    const g = groups.get(k);
    g.name = courseNameOf(r); g.n++; g.sum += r.score; g.best = Math.max(g.best, r.score);
  }
  if (!layouts.size) { setHtml('#histCourses', html`<p class="hist-none">完走データがありません</p>`); return; }
  const factors = H.factors.score || {};
  const sections = [...layouts.entries()].map(([ln, groups]) => {
    const list = [...groups.values()];
    for (const g of list) g.f = factors[g.key] || 1;
    list.sort((a, b) => b.f - a.f);
    return { ln, list };
  });
  if (sections.every((s) => s.list.length < 2)) {
    setHtml('#histCourses', html`<p class="hist-none">${sections.length > 1 ? 'どの配列も練習した練習文が 1 種類のみのため、まだ比較できません' : '練習した練習文が 1 種類のみのため、まだ比較できません'}<br>ほかのプリセットやグループでも練習すると、得意・不得意が見えてきます</p>`);
    return;
  }
  const row = (g) => {
    const pct = Math.round((g.f - 1) * 100);
    const tag = g.f >= 1.05 ? html`<span class="tag is-up">得点が出やすい（+${pct}%）</span>` : g.f <= 0.95 ? html`<span class="tag is-down">得点が出にくい（${pct}%）</span>` : html`<span class="tag">標準（${pct >= 0 ? '+' : ''}${pct}%）</span>`;
    return html`<div class="hist-row"><div class="hist-row-head"><b>${g.name}</b>${tag}</div>
      <div class="diverge"><i class="mid"></i><i class="knob" data-pos="${Math.max(0, Math.min(100, 50 + (g.f - 1) * 250)).toFixed(1)}"></i></div>
      <small class="num">${g.n} 回・平均 ${Math.round(g.sum / g.n).toLocaleString()}・最高 ${g.best.toLocaleString()}</small></div>`;
  };
  setHtml('#histCourses', html`${sections.map((s) => html`
    ${sections.length > 1 ? html`<div class="hist-sub"><i class="dot" data-c="${layoutColor(s.ln)}"></i>${s.ln || '（配列名なし）'}</div>` : ''}
    ${s.list.length < 2 ? html`<p class="hist-none is-left">${s.list[0].name}（${s.list[0].n} 回）のみのため、まだ比較できません</p>` : s.list.map(row)}`)}
    <p class="section-note">練習文の難易度と得意・不得意が表れます（配列ごとに計算）</p>`);
  for (const k of document.querySelectorAll('#histCourses .knob')) k.style.left = k.dataset.pos + '%';
  for (const d of document.querySelectorAll('#histCourses .dot')) d.style.color = d.dataset.c;
}

function renderLayoutBars() {
  const mk = H.metric, metric = METRICS[mk];
  const pool = S.history.filter((r) => H.course === 'all' || courseKeyOf(r) === H.course);
  const corrected = correctionActive(pool) && CORRECTABLE.includes(mk);
  $('#histLayoutNote').textContent = '濃い棒＝平均、薄い棒＝最高（全期間）' + (corrected ? '・難易度補正あり' : '');
  const groups = Object.create(null);
  for (const r of pool) {
    const v = valueOf(r, mk, corrected);
    if (v === null) continue;
    const key = r.layoutName || '不明';
    if (!groups[key]) groups[key] = { name: key, count: 0, sum: 0, max: -Infinity };
    groups[key].count++; groups[key].sum += v; if (v > groups[key].max) groups[key].max = v;
  }
  const list = Object.values(groups).sort((a, b) => b.max - a.max);
  if (!list.length) { setHtml('#histLayouts', html`<p class="hist-none">完走データがありません</p>`); return; }
  const top = Math.max(...list.map((g) => g.max), 1);
  setHtml('#histLayouts', list.map((g) => {
    const avg = g.sum / g.count;
    return html`<div class="hist-row"><div class="hist-row-head"><b><i class="dot" data-c="${layoutColor(g.name)}"></i>${g.name}</b><span class="num muted">最高 <strong>${metric.fmt(g.max)}</strong> / 平均 <strong>${metric.fmt(avg)}</strong></span></div>
      <div class="bar2" data-c="${layoutColor(g.name)}"><i class="max" data-w="${Math.max(2, Math.round((g.max / top) * 100))}"></i><i class="avg" data-w="${Math.max(2, Math.round((avg / top) * 100))}"></i></div>
      <small class="num">完走 ${g.count} 回</small></div>`;
  }));
  for (const d of document.querySelectorAll('#histLayouts .dot')) d.style.color = d.dataset.c;
  for (const b of document.querySelectorAll('#histLayouts .bar2')) { b.style.setProperty('--c', b.dataset.c); for (const i of b.children) i.style.width = i.dataset.w + '%'; }
}

function renderRecords(records) {
  if (!records.length) { setHtml('#histRecords', html`<p class="hist-none">表示できる完走履歴がありません</p>`); return; }
  const list = [...records].reverse().slice(0, 300);
  setHtml('#histRecords', html`${list.map((r) => {
    const type = r.lang === 'en' ? '英文' : r.romajiStyle === 'hepburn' ? 'ヘボン式' : '日本式';
    const rank = typeof r.score === 'number' ? core.scoreRank(r.score).rank : null;
    return html`<div class="rec">
      <div class="rec-score">${rank ? html`<span class="rank-pill" data-c="${rank.color}">${rank.rank}</span>` : ''}<b class="num">${typeof r.score === 'number' ? r.score.toLocaleString() : '-'}</b></div>
      <div class="rec-what"><div class="rec-tags"><span class="chip"><i class="dot" data-c="${layoutColor(r.layoutName)}"></i>${r.layoutName || '配列'}</span><span class="chip chip-accent">${courseNameOf(r)}</span>${r.groupName ? html`<span class="faint">▶ ${r.groupName}</span>` : ''}<span class="faint">${type}</span></div>
        <small class="num faint">${formatDate(r.timestamp)}</small></div>
      <div class="rec-nums num"><span><i>WPM</i><b>${r.wpm || 0}</b></span><span><i>文字/分</i><b>${r.cpm === null || r.cpm === undefined ? '-' : r.cpm}</b></span><span><i>正確率</i><b>${Number(r.accuracy || 0).toFixed(1)}%</b></span><span><i>リズム</i><b>${typeof r.rhythm === 'number' ? r.rhythm.toFixed(1) + '%' : '-'}</b></span></div>
      <button class="icon-btn" data-act="hist.delete" data-arg="${r.id}" aria-label="この記録を削除" title="この記録を削除">${icon.trash}</button>
    </div>`;
  })}${records.length > list.length ? html`<p class="hist-none">新しい順に ${list.length} 件を表示しています（全 ${records.length} 件）</p>` : ''}`);
  for (const d of document.querySelectorAll('#histRecords .dot')) d.style.color = d.dataset.c;
  for (const p of document.querySelectorAll('#histRecords .rank-pill')) p.style.setProperty('--rank', p.dataset.c);
}

async function deleteRecord(id) {
  const ok = await confirmDialog({ title: 'この記録を削除しますか？', text: '選択した 1 回分の記録を削除します（元に戻せません）', ok: '削除する', danger: true });
  if (!ok) return;
  if (storageAvailable()) loadHistory();
  S.history = S.history.filter((r) => r.id !== id);
  saveHistory();
  render();
  toast('記録を削除しました');
}

async function clearAll() {
  const ok = await confirmDialog({ title: '履歴を全て削除しますか？', text: '通常の練習の記録を全て削除し、シャトルランの記録は残ります（元に戻せません）', ok: '全削除する', danger: true });
  if (!ok) return;
  S.history = [];
  saveHistory();
  render();
  toast('スコアの履歴を削除しました');
}

// ---------- シャトルラン ----------

function trophiesHtml() {
  const histRaw = lsRead(K.shuttle);
  const store = core.loadTrophies(rawGet(K.trophies), histRaw, Date.now());
  const table = core.trophyTable(), tiers = core.trophyTiers();
  const got = table.filter((t) => store.got[t.id]);
  return html`<section class="card hist-card tr-cabinet">
    <div class="hist-card-head"><h2 class="section-title">トロフィー</h2><span class="num muted"><b class="tr-got">${got.length}</b> / ${table.length} 獲得</span><span class="tr-progress grow"><i data-w="${((got.length / table.length) * 100).toFixed(1)}"></i></span></div>
    <div class="tr-tiers">${tiers.map((tier) => { const all = table.filter((t) => t.tier === tier.id); return html`<span class="chip"><i class="dot" data-c="${tier.stops[1]}"></i>${tier.label} ${all.filter((t) => store.got[t.id]).length}/${all.length}</span>`; })}</div>
    <div class="tr-grid">${table.map((t) => {
      const ts = store.got[t.id];
      const tier = tiers.find((x) => x.id === t.tier) || tiers[0];
      return html`<div class="tr-card ${ts ? 'is-earned' : 'is-locked'}" data-tier="${t.tier}" data-c="${tier.stops[1]}" title="${tier.label}：${t.desc}${ts ? '（' + formatDate(ts) + ' に獲得）' : '（未獲得）'}">
        ${trophySvg(t, tiers)}<span class="tr-tier">${tier.label}</span><b>${t.name}</b><span class="tr-desc">${t.desc}</span><span class="tr-date num">${ts ? formatDate(ts, false) : '未獲得'}</span></div>`;
    })}</div></section>`;
}

function duration(sec) { const s = Math.round(sec); return s >= 60 ? Math.floor(s / 60) + '分' + (s % 60) + '秒' : s + '秒'; }

function renderShuttle() {
  const list = core.loadShuttleHistory(lsRead(K.shuttle));
  if (!list.length) {
    setHtml('#histBody', html`${trophiesHtml()}<p class="hist-none">まだシャトルランの記録がありません（練習画面の「シャトルランに挑戦」から始められます）</p>`);
    paintShuttle();
    return;
  }
  const by = Object.create(null);
  for (const r of list) { const b = by[r.layoutName] || (by[r.layoutName] = { best: r, runs: 0 }); b.runs++; if (r.cleared > b.best.cleared) b.best = r; }
  const names = Object.keys(by).sort((a, b) => by[b].best.cleared - by[a].best.cleared);
  const recent = list.slice(-30);
  const maxLv = Math.max(...recent.map((r) => r.level), 5);
  const W = 640, HH = 140, bw = Math.min(28, (W - 30) / recent.length);
  const bars = recent.map((r, i) => {
    const h = (r.level / maxLv) * (HH - 38), x = 24 + i * bw;
    return html`<g><title>${formatDate(r.timestamp)}・${r.layoutName}・レベル ${r.level}</title><rect x="${(x + 2).toFixed(1)}" y="${(HH - 16 - h).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${h.toFixed(1)}" rx="3"/>
      ${bw > 16 || i % 3 === 0 ? html`<text x="${(x + bw / 2).toFixed(1)}" y="${(HH - 21 - h).toFixed(1)}">${r.level}</text>` : ''}</g>`;
  });
  const last = list[list.length - 1];
  setHtml('#histBody', html`
    ${trophiesHtml()}
    <div class="hist-two">
      <section class="card hist-card"><h2 class="section-title">配列ごとの最高記録</h2>
        <div class="hist-list">${names.map((n) => html`<div class="sh-best"><b>${n}</b><span class="num">レベル <strong>${by[n].best.level}</strong></span><small class="num">${by[n].best.cleared} レベルクリア・${formatDate(by[n].best.timestamp, false)}・${by[n].runs} 回挑戦</small></div>`)}</div></section>
      <section class="card hist-card"><h2 class="section-title">到達レベルの推移（直近 ${recent.length} 回）</h2>
        <svg viewBox="0 0 ${W} ${HH}" class="sh-hist-chart" role="img" aria-label="到達レベルの推移"><line x1="20" y1="${HH - 16}" x2="${W}" y2="${HH - 16}"/>${bars}</svg></section>
    </div>
    <section class="card hist-card"><h2 class="section-title">最新の回のレベルごとの時間</h2><div class="sh-chart-box">${levelChart(last.levels)}</div></section>
    <section class="card hist-card">
      <div class="hist-card-head"><h2 class="section-title">全ての記録</h2><span class="grow"></span><button class="btn btn-s btn-danger" data-act="hist.clearShuttle">${icon.trash}シャトルランの記録を削除</button></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>日時</th><th>配列</th><th class="r">到達レベル</th><th class="r">クリア</th><th class="r">正確率</th><th class="r">打/分</th><th class="r">最大連続</th><th class="r">時間</th></tr></thead>
        <tbody>${list.slice().reverse().map((r) => html`<tr><td class="num">${formatDate(r.timestamp)}</td><td>${r.layoutName}</td><td class="r num"><b>${r.level}</b></td><td class="r num">${r.cleared}</td><td class="r num">${r.accuracy.toFixed(1)}%</td><td class="r num">${r.kpm}</td><td class="r num">${r.maxCombo}</td><td class="r num">${duration(r.durationSec)}</td></tr>`)}</tbody></table></div>
    </section>`);
  paintShuttle();
}

function paintShuttle() {
  for (const d of document.querySelectorAll('#histBody .dot[data-c]')) d.style.color = d.dataset.c;
  for (const c of document.querySelectorAll('#histBody .tr-card')) c.style.setProperty('--c', c.dataset.c);
  const p = $('#histBody .tr-progress i'); if (p) p.style.width = p.dataset.w + '%';
}

async function clearShuttle() {
  const ok = await confirmDialog({ title: 'シャトルランの記録を削除', text: 'シャトルランの記録を全て削除し、トロフィーは残ります（元に戻せません）', ok: '削除する', danger: true });
  if (!ok) return;
  // トロフィーは記録から作り直せなくなるので、先に今の獲得状況を保存しておく
  const store = core.loadTrophies(rawGet(K.trophies), lsRead(K.shuttle), Date.now());
  lsWrite(K.trophies, JSON.stringify(store));
  lsRemove(K.shuttle);
  render();
  toast('シャトルランの記録を削除しました');
}
