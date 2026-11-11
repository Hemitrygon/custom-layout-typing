// KeyboardEvent.code → 3D キーボード（public/models/keyboard.glb）のキーの物体の名前。
// 3D のキーボードは US 配列の 75%（ファンクションキー・矢印つき）。JIS だけにあるキー（IntlYen ¥・IntlRo \）は 3D にない（null）。
// JIS の「]」のキーは Backslash の code を出すので、3D では US の \ の位置のキーが沈む。
// 名前がすべて 3D の中にあることは scripts/check_model_keys.mjs が確かめる（check.sh から）。
const letters = Object.fromEntries('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => ['Key' + c, 'Key_' + c]));
const digits = Object.fromEntries('0123456789'.split('').map(d => ['Digit' + d, 'Key_' + d]));
const fkeys = Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['F' + (i + 1), 'Key_F' + (i + 1)]));

export const MODEL_KEY_BY_CODE = {
  ...letters, ...digits, ...fkeys,
  Backquote: 'Key_`', Minus: 'Key_MINUS', Equal: 'Key_EQUAL', IntlYen: null,
  BracketLeft: 'Key_LBRACKET', BracketRight: 'Key_RBRACKET', Backslash: 'Key_BACKSLASH',
  Semicolon: 'Key_SEMICOLON', Quote: 'Key_QUOTE', Comma: 'Key_COMMA', Period: 'Key_PERIOD', Slash: 'Key_SLASH', IntlRo: null,
  Space: 'Key_SPACE', ShiftLeft: 'Key_LSHIFT', ShiftRight: 'Key_RSHIFT',
  Backspace: 'Key_BACKSPACE', Enter: 'Key_ENTER', Tab: 'Key_TAB', CapsLock: 'Key_CAPS', Escape: 'Key_ESC',
  ControlLeft: 'Key_LCTRL', AltLeft: 'Key_LALT', AltRight: 'Key_RALT', MetaLeft: 'Key_CMD',
  ArrowUp: 'Key_UP', ArrowDown: 'Key_DOWN', ArrowLeft: 'Key_LEFT', ArrowRight: 'Key_RIGHT',
  Home: 'Key_HOME', End: 'Key_END', PageUp: 'Key_PGUP', PageDown: 'Key_PGDN',
};
