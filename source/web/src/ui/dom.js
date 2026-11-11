// 画面づくりの小さな部品。
//   html`...`  値を必ず文字として入れるテンプレート（読み込んだファイルや保存データの文字がプログラムとして動かない）
//   raw(...)   すでに安全な HTML をそのまま入れる（html`` の結果・アイコンなど）
//   act(...)   ボタンなどの data-act="名前" と、動かす関数を結びつける（HTML に onclick を書かない）

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const raw = (s) => new Raw(String(s ?? ''));

function put(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(put).join('');
  return esc(v);
}

/** 値をエスケープして組み立てる。結果は raw と同じく、ほかの html`` にそのまま入れられる。 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += put(values[i]) + strings[i + 1];
  return new Raw(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 要素の中身を入れ替える。 */
export function setHtml(target, content) {
  const node = typeof target === 'string' ? $(target) : target;
  if (node) node.innerHTML = content instanceof Raw ? content.s : put(content);
  return node;
}

export function el(tag, attrs = {}, content) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  if (content !== undefined) setHtml(node, content);
  return node;
}

// ---------- 動作（data-act） ----------

const actions = new Map();

/** 動作を登録する。 fn(引数の文字列, 要素, 事件) */
export function act(name, fn) {
  if (typeof name === 'object') { for (const [k, f] of Object.entries(name)) actions.set(k, f); return; }
  actions.set(name, fn);
}

export function runAct(name, arg, node, event) {
  const fn = actions.get(name);
  if (fn) return fn(arg, node, event);
  console.warn('知らない動作：' + name);
  return undefined;
}

/** 画面全体で 1 回だけ呼ぶ：クリック・入力・変更を data-act / data-input / data-change に流す。 */
export function wireActions(root = document) {
  root.addEventListener('click', (e) => {
    const node = e.target instanceof Element ? e.target.closest('[data-act]') : null;
    if (!node || node.disabled || node.getAttribute('aria-disabled') === 'true') return;
    // マウスで押したボタンにフォーカスが残ると、Space・Enter でもう一度押されてしまう
    if (node.tagName === 'BUTTON' && e.detail > 0) node.blur();
    runAct(node.dataset.act, node.dataset.arg, node, e);
  });
  root.addEventListener('input', (e) => {
    const node = e.target instanceof Element ? e.target.closest('[data-input]') : null;
    if (node) runAct(node.dataset.input, node.value, node, e);
  });
  root.addEventListener('change', (e) => {
    const node = e.target instanceof Element ? e.target.closest('[data-change]') : null;
    if (node) runAct(node.dataset.change, node.type === 'checkbox' ? String(node.checked) : node.value, node, e);
  });
}

/** 数をなめらかに数え上げる。 */
export function countUp(node, to, { ms = 900, format = (v) => Math.round(v).toLocaleString() } = {}) {
  if (!node) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { node.textContent = format(to); return; }
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / ms);
    const k = 1 - Math.pow(1 - t, 3);
    node.textContent = format(to * k);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 2026/11/10 21:05 の形。 */
export function formatDate(ts, withTime = true) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + (withTime ? ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) : '');
}

/** ファイルとして保存させる。 */
export function downloadText(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
