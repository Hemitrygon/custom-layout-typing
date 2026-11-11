// 色と名前の決まり（3D の舞台と HTML の画面の両方で使う）。
// 指は 0〜9：0 左小指 … 4 左親指、5 右親指 … 9 右小指（配列の finger と同じ番号）。

export const FINGERS = [
  { name: '左小指', short: '左小', color: '#ff6f91' },
  { name: '左薬指', short: '左薬', color: '#ffb23e' },
  { name: '左中指', short: '左中', color: '#57d69b' },
  { name: '左人差指', short: '左人', color: '#4db8ff' },
  { name: '左親指', short: '左親', color: '#aab3c2' },
  { name: '右親指', short: '右親', color: '#aab3c2' },
  { name: '右人差指', short: '右人', color: '#8490ff' },
  { name: '右中指', short: '右中', color: '#35d6c9' },
  { name: '右薬指', short: '右薬', color: '#bb8cff' },
  { name: '右小指', short: '右小', color: '#f283e4' },
];

export const ACCENT = '#ff6a2b';      // 3D の差し色（練習タブのオレンジ。キーボードの右上のキーと同じ）
export const DANGER = '#ff4d5e';
export const SHUTTLE = '#2fe0c8';     // シャトルランの色
export const GOLD = '#ffcc4d';

// 過去のスコアのグラフ：配列ごとの色（旧版（v5）と同じ考え方。決まった 4 つ → 追加の 4 つ → 灰色）。
// 暗い背景での明るさ・彩度・色覚の違いでの見分けやすさを、dataviz の検査で確かめた 8 色（並びも決まり）。
export const LAYOUT_COLOR_FIXED = { '大西配列': '#e8662c', 'QWERTY': '#3d8fe6', 'Dvorak': '#2ea86e', 'Colemak': '#9a78f0' };
export const LAYOUT_COLOR_EXTRA = ['#dc6096', '#b38d1c', '#0f9080', '#e04848'];
export const LAYOUT_COLOR_OVERFLOW = '#8a8f99';
export const LAYOUT_COLOR_ALL = '#d9d6cf';
/** 「すべての配列」の線の色（ライトでは濃い灰色にして、明るい背景でも見えるように）。 */
export const layoutColorAll = () => (document.documentElement.dataset.theme === 'light' ? '#4a4b52' : LAYOUT_COLOR_ALL);

/** '#rrggbb' を黒（t<0）か白（t>0）に寄せる。 */
export function shade(hex, t) {
  const n = parseInt(hex.slice(1), 16);
  const to = t < 0 ? 0 : 255, k = Math.abs(t);
  const ch = (v) => Math.round(v + (to - v) * k);
  const r = ch(n >> 16 & 255), g = ch(n >> 8 & 255), b = ch(n & 255);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
