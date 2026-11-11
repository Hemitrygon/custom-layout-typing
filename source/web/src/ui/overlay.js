// 画面の上に重ねるもの：お知らせ（トースト）・ダイアログ・選ぶ一覧（ポップオーバー）・上に出す赤い帯。
import { $, el, html, raw, setHtml, esc } from './dom.js';
import { icon } from './icons.js';

// ---------- お知らせ ----------

let lastToast = '';
let lastToastAt = 0;

export function toast(text, ms = 3200) {
  const box = $('#toasts');
  if (!box || !text) return;
  const now = performance.now();
  if (text === lastToast && now - lastToastAt < 800) return;
  lastToast = text; lastToastAt = now;
  const node = el('div', { class: 'toast', role: 'status', text });
  box.appendChild(node);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { node.classList.add('is-out'); setTimeout(() => node.remove(), 320); }, ms);
}

/**
 * 画面の上に、消すまで残る帯を出す。
 * @param {string} text
 * @param {{tone?: 'alert'|'hint', action?: {label: string, act: string}}} [o]
 *   tone：'alert'（赤。保存できない・外部ファイルの異常など）か 'hint'（黄。おすすめ）。action：帯に出すボタン（data-act の名前）
 */
export function banner(text, o = {}) {
  const tone = o.tone === 'hint' ? 'hint' : 'alert';
  let node = $('#banner');
  if (node && tone === 'hint' && node.dataset.tone === 'alert') return;   // 大事な注意を、おすすめで隠さない
  if (!node) {
    node = el('div', { id: 'banner', role: 'alert' });
    $('#app').appendChild(node);
  }
  node.dataset.tone = tone;
  setHtml(node, html`${tone === 'hint' ? icon.info : icon.warn}<span>${text}</span>
    ${o.action ? html`<button class="btn btn-s" data-act="${o.action.act}">${o.action.label}</button>` : ''}<button class="btn btn-s btn-ghost" data-act="banner.close">閉じる</button>`);
}
/** 帯を消す。tone を渡すと、その種類の帯だけを消す。 */
export function closeBanner(tone) { const n = $('#banner'); if (n && (!tone || n.dataset.tone === tone)) n.remove(); }

// ---------- ダイアログ ----------

const stack = [];   // 開いているダイアログ（最後がいちばん上）

/**
 * ダイアログを開く。
 * @param {{title: string, body: any, foot?: any, size?: ''|'l'|'xl', danger?: boolean, onClose?: Function, onKey?: (e: KeyboardEvent) => boolean|void,
 *   dismissable?: boolean, id?: string}} o  onKey が true を返したら、そのキーは処理済み
 * @returns {{root: HTMLElement, close: Function, body: HTMLElement}}
 */
export function openModal(o) {
  const wrap = el('div', { class: 'modal-wrap', 'data-modal': o.id || '' });
  const box = el('div', { class: 'modal glass' + (o.size ? ' modal-' + o.size : '') + (o.danger ? ' modal-danger' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title });
  setHtml(box, html`
    <div class="modal-head">
      <h2 class="modal-title">${o.title}</h2>
      ${o.dismissable === false ? '' : html`<button class="icon-btn" data-modal-close aria-label="閉じる">${icon.close}</button>`}
    </div>
    <div class="modal-body">${o.body}</div>
    ${o.foot ? html`<div class="modal-foot">${o.foot}</div>` : ''}`);
  wrap.appendChild(box);
  $('#modals').appendChild(wrap);
  const prevFocus = document.activeElement;
  const entry = {
    root: wrap, body: $('.modal-body', box), onKey: o.onKey, dismissable: o.dismissable !== false, id: o.id || '',
    close: () => {
      const i = stack.indexOf(entry);
      if (i < 0) return;
      stack.splice(i, 1);
      wrap.remove();
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) { try { prevFocus.focus({ preventScroll: true }); } catch { /* 戻せなくてもよい */ } }
      if (o.onClose) o.onClose();
    },
  };
  wrap.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-modal-close]')) entry.close();
    else if (e.target === wrap && entry.dismissable && !o.keepOnBackdrop) entry.close();
  });
  stack.push(entry);
  const first = box.querySelector('[autofocus]') || box.querySelector('.modal-foot .btn-primary') || box.querySelector('button');
  if (first) { try { first.focus({ preventScroll: true }); } catch { /* なくてもよい */ } }
  return entry;
}

export const modalOpen = () => stack.length > 0;
export const topModal = () => stack[stack.length - 1] || null;
export function closeAllModals() { while (stack.length) stack[stack.length - 1].close(); }

/** ダイアログが開いているときのキー。 @returns {boolean} ダイアログが受け取ったか（開いていれば常に true） */
export function modalKeyDown(e) {
  const top = topModal();
  if (!top) return false;
  if (top.onKey && top.onKey(e) === true) return true;
  if (e.key === 'Escape' && top.dismissable) { e.preventDefault(); top.close(); }
  return true;
}

/**
 * 確かめるダイアログ。 @returns {Promise<boolean>}
 * @param {{title: string, text: any, ok?: string, cancel?: string, danger?: boolean}} o
 */
export function confirmDialog(o) {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal({
      title: o.title,
      danger: o.danger,
      body: typeof o.text === 'string' ? html`<p>${o.text}</p>` : o.text,
      foot: html`<button class="btn" data-answer="no">${o.cancel || 'キャンセル'}</button>
        <button class="btn ${o.danger ? 'btn-danger' : 'btn-primary'}" data-answer="yes" autofocus>${o.ok || 'はい'}</button>`,
      onClose: () => { if (!answered) resolve(false); },
      onKey: (e) => {
        if (e.key !== 'Enter') return false;
        // ボタンにフォーカスがあるときは、そのボタンを押す（Tab で「キャンセル」を選んで Enter → キャンセル）
        const f = document.activeElement;
        if (f instanceof HTMLButtonElement && m.root.contains(f)) return true;   // ブラウザが押す（preventDefault しない）
        e.preventDefault(); answered = true; m.close(); resolve(true); return true;
      },
    });
    m.root.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest('[data-answer]') : null;
      if (!b) return;
      answered = true;
      m.close();
      resolve(b.dataset.answer === 'yes');
    });
  });
}

/**
 * いくつかの答えから選ぶダイアログ。 @returns {Promise<string|null>} 選んだ key（閉じた・キャンセルなら null）
 * @param {{title: string, text: any, cancel?: string, choices: Array<{key: string, label: string, kind?: 'primary'|'danger'}>}} o
 */
export function choiceDialog(o) {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal({
      title: o.title,
      body: typeof o.text === 'string' ? html`<p>${o.text}</p>` : o.text,
      foot: html`<button class="btn" data-modal-close>${o.cancel || 'キャンセル'}</button>
        ${o.choices.map((c) => html`<button class="btn ${c.kind === 'primary' ? 'btn-primary' : c.kind === 'danger' ? 'btn-danger' : ''}" data-choice="${c.key}" ${c.kind === 'primary' ? raw('autofocus') : ''}>${c.label}</button>`)}`,
      onClose: () => { if (!answered) resolve(null); },
    });
    m.root.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest('[data-choice]') : null;
      if (!b) return;
      answered = true;
      m.close();
      resolve(b.dataset.choice);
    });
  });
}

/** 知らせるだけのダイアログ。 */
export function alertDialog(o) {
  return new Promise((resolve) => {
    const m = openModal({
      title: o.title, danger: o.danger, id: o.id,
      body: typeof o.text === 'string' ? html`<p>${o.text}</p>` : o.text,
      foot: html`<button class="btn btn-primary" data-modal-close autofocus>${o.ok || '閉じる'}</button>`,
      onClose: resolve,
      onKey: (e) => { if (e.key === 'Enter') { e.preventDefault(); m.close(); return true; } return false; },
    });
  });
}

// ---------- 選ぶ一覧 ----------

let pop = null;

export function closePop() {
  if (!pop) return;
  pop.node.remove();
  if (pop.anchor) pop.anchor.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', pop.onDown, true);
  pop = null;
}
export const popOpen = () => Boolean(pop);

/**
 * ボタンの下に一覧を出す。
 * @param {HTMLElement} anchor
 * @param {Array<{label?: string} | {sep: true} | {text: string, meta?: string, selected?: boolean, link?: boolean, onPick: Function}>} items
 * @param {{align?: 'left'|'center'|'right'}} [o]
 */
export function openPop(anchor, items, o = {}) {
  const same = pop && pop.anchor === anchor;
  closePop();
  if (same) return;
  const node = el('div', { class: 'pop', role: 'listbox' });
  const picks = [];
  setHtml(node, items.map((it) => {
    if (it.sep) return html`<div class="pop-sep"></div>`;
    if (it.label) return html`<div class="pop-label">${it.label}</div>`;
    picks.push(it.onPick);
    return html`<button class="pop-item ${it.link ? 'pop-link' : ''}" role="option" aria-selected="${it.selected ? 'true' : 'false'}" data-pick="${picks.length - 1}">
      ${it.link ? '' : html`<span class="pop-check">${it.selected ? icon.check : ''}</span>`}<span>${it.text}</span>${it.meta ? html`<span class="pop-meta">${it.meta}</span>` : ''}</button>`;
  }));
  document.body.appendChild(node);
  const r = anchor.getBoundingClientRect();
  const w = node.offsetWidth, h = node.offsetHeight;
  let left = o.align === 'left' ? r.left : o.align === 'right' ? r.right - w : r.left + r.width / 2 - w / 2;
  left = Math.max(12, Math.min(window.innerWidth - w - 12, left));
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 8);
  node.style.left = left + 'px';
  node.style.top = top + 'px';
  anchor.setAttribute('aria-expanded', 'true');
  node.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-pick]') : null;
    if (!b) return;
    const fn = picks[Number(b.dataset.pick)];
    closePop();
    if (fn) fn();
  });
  const onDown = (e) => { if (!node.contains(e.target) && !anchor.contains(e.target)) closePop(); };
  document.addEventListener('pointerdown', onDown, true);
  pop = { node, anchor, onDown };
  const sel = node.querySelector('[aria-selected="true"]') || node.querySelector('.pop-item');
  if (sel) { try { sel.focus({ preventScroll: true }); sel.scrollIntoView({ block: 'nearest' }); } catch { /* なくてもよい */ } }
}

/** 一覧が開いているときのキー（上下で動かす・Esc で閉じる）。 @returns {boolean} 受け取ったか */
export function popKeyDown(e) {
  if (!pop) return false;
  if (e.key === 'Escape') { e.preventDefault(); const a = pop.anchor; closePop(); if (a) a.blur(); return true; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const list = [...pop.node.querySelectorAll('.pop-item')];
    const i = list.indexOf(document.activeElement);
    const down = e.key === 'ArrowDown';
    const next = i < 0 ? list[down ? 0 : list.length - 1] : list[(i + (down ? 1 : list.length - 1)) % list.length];
    if (next) next.focus();
    return true;
  }
  if (e.key === 'Enter' || e.key === ' ') return true;   // フォーカスのある項目をブラウザが押す
  return true;
}

export { esc, raw };
