// 平らなキーボードの絵（HTML）。配列エディタで使う。JIS だけにあるキー（¥・ろ）も出せる。
// 位置はキー 1 個分を 1 とした数（旧版（v5）の KEYBOARD_GEOMETRY と同じ。本物の JIS / US キーボードの並び）。
//   文字列＝キーの code、{ d }＝目印として描くだけのキー（Tab・Enter など）、{ gap }＝すき間（JIS の Enter の下の部分）
import { html } from './dom.js';

const LETTERS_Q = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'];
const LETTERS_A = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'];
const LETTERS_Z = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'];
const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
const GEOMETRY = {
  jis: [
    [{ d: '半角/全角', w: 1 }, ...DIGITS, 'Minus', 'Equal', 'IntlYen', { d: 'Back space', w: 1 }],
    [{ d: 'Tab', w: 1.5 }, ...LETTERS_Q, 'BracketLeft', 'BracketRight', { d: 'Enter', w: 1.5, enterL: true }],
    [{ d: 'Caps Lock', w: 1.75 }, ...LETTERS_A, 'Semicolon', 'Quote', 'Backslash', { gap: 1.25 }],
    [{ code: 'ShiftLeft', w: 2.25 }, ...LETTERS_Z, 'IntlRo', { code: 'ShiftRight', w: 1.75 }],
    [{ d: 'Ctrl', w: 1.25 }, { d: 'Win', w: 1 }, { d: 'Alt', w: 1.25 }, { d: '無変換', w: 1.25 }, { code: 'Space', w: 4.25 },
      { d: '変換', w: 1.25 }, { d: 'かな', w: 1.25 }, { d: 'Alt', w: 1.25 }, { d: 'Menu', w: 1 }, { d: 'Ctrl', w: 1.25 }],
  ],
  us: [
    ['Backquote', ...DIGITS, 'Minus', 'Equal', { d: 'Backspace', w: 2 }],
    [{ d: 'Tab', w: 1.5 }, ...LETTERS_Q, 'BracketLeft', 'BracketRight', { code: 'Backslash', w: 1.5 }],
    [{ d: 'Caps Lock', w: 1.75 }, ...LETTERS_A, 'Semicolon', 'Quote', { d: 'Enter', w: 2.25 }],
    [{ code: 'ShiftLeft', w: 2.25 }, ...LETTERS_Z, { code: 'ShiftRight', w: 2.75 }],
    [{ d: 'Ctrl', w: 1.25 }, { d: 'Win', w: 1.25 }, { d: 'Alt', w: 1.25 }, { code: 'Space', w: 6.25 },
      { d: 'Alt', w: 1.25 }, { d: 'Win', w: 1.25 }, { d: 'Menu', w: 1.25 }, { d: 'Ctrl', w: 1.25 }],
  ],
};

/** キーの並び：[{code | null, deco | null, x, y, w, enterL}]（キー 1 個分を 1 とした位置）。 */
export function keyboardItems(kind) {
  const items = [];
  (GEOMETRY[kind] || GEOMETRY.jis).forEach((row, y) => {
    let x = 0;
    for (const item of row) {
      const it = typeof item === 'string' ? { code: item, w: 1 } : item;
      if (it.gap) { x += it.gap; continue; }
      items.push({ code: it.code || null, deco: it.d || null, x, y, w: it.w, enterL: Boolean(it.enterL) });
      x += it.w;
    }
  });
  return items;
}

/**
 * キーボードの HTML。大きさは CSS の --u（キー 1 個分）と --g（すき間）で決まる。
 * @param {'jis'|'us'} kind
 * @param {(code: string) => ({cls?: string, body: any, title?: string, style?: string, disabled?: boolean} | null)} face キーの中身（null なら描かない）
 * @param {{rows?: number}} [o] rows：上から何段まで描くか（既定は 5 段すべて。4 にすると、スペースの段を描かない）
 */
export function flatKeyboard(kind, face, o = {}) {
  const rows = o.rows || 5;
  const pos = (it) => '--x:' + it.x + ';--y:' + it.y + ';--w:' + it.w;
  return html`<div class="fk-board" data-kind="${kind}" style="--rows:${rows}">${keyboardItems(kind).filter((it) => it.y < rows).map((it) => {
    if (it.deco) {
      return it.enterL
        ? html`<div class="fk-key fk-deco fk-enter" style="${pos(it)}" aria-hidden="true"><span>${it.deco}</span></div>`
        : html`<div class="fk-key fk-deco" style="${pos(it)}" aria-hidden="true">${it.deco}</div>`;
    }
    const f = face(it.code);
    if (!f) return '';
    return html`<button class="fk-key ${f.cls || ''}" style="${pos(it)}${f.style ? ';' + f.style : ''}" data-code="${it.code}" title="${f.title || ''}" ${f.disabled ? html`tabindex="-1" aria-disabled="true"` : ''}>${f.body}</button>`;
  })}</div>`;
}
