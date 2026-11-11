// 画面のフォント（Google Fonts）。外から読むのはこれと、漢字のよみの辞書（kuromoji）だけ。
// フォントの設定ファイルは、止めた状態（media="print"）で読み込み、中身が決めたフォントの @font-face だけで、
// 読み込み先が fonts.gstatic.com のときにだけ有効にする（旧版（v5）と同じ確かめ方）。
export const FONT_CSS_URL = 'https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;500;700&family=Sora:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap';
const FONT_FAMILIES = ['Zen Kaku Gothic New', 'Sora', 'JetBrains Mono'];

/** 外から読むファイルの状態（「データ」の画面に出す）。fonts：'loading' | 'ok' | 'blocked' | 'unverified' | 'unreachable' */
export const cdnStatus = { fonts: 'loading', kuromoji: 'idle' };

function sheetIsSafe(sheet) {
  let rules;
  try { rules = sheet.cssRules; } catch { return null; }
  if (!rules || !rules.length) return false;
  for (const rule of rules) {
    if (rule.type !== 5) return false; // CSSRule.FONT_FACE_RULE
    const family = rule.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '');
    if (!FONT_FAMILIES.includes(family)) return false;
    const src = rule.style.getPropertyValue('src');
    const urls = [...src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]);
    if (!urls.length || urls.some((u) => !u.startsWith('https://fonts.gstatic.com/'))) return false;
  }
  return true;
}

/**
 * フォントを読み込む。
 * @param {{onReady?: Function, onProblem?: (what: string) => void}} [o] onReady：フォントが使えるようになった（3D の刻印を描き直す）
 */
export function loadWebFonts(o = {}) {
  try {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = FONT_CSS_URL;
    link.crossOrigin = 'anonymous';
    link.media = 'print';
    link.onload = () => {
      const safe = sheetIsSafe(link.sheet);
      if (safe) {
        link.media = 'all';
        cdnStatus.fonts = 'ok';
        const ready = () => { if (o.onReady) o.onReady(); };
        // 刻印と数字に使う字形を先に読み込ませる
        Promise.all([
          document.fonts.load('600 40px "Sora"', 'A1'),
          document.fonts.load('500 20px "JetBrains Mono"', 'A1'),
          document.fonts.load('500 20px "Zen Kaku Gothic New"', 'あ'),
        ]).then(ready, ready);
      } else {
        link.remove();
        cdnStatus.fonts = safe === null ? 'unverified' : 'blocked';
        if (safe === false && o.onProblem) o.onProblem('フォントの設定');
      }
    };
    link.onerror = () => { link.remove(); cdnStatus.fonts = 'unreachable'; };
    document.head.appendChild(link);
  } catch {
    cdnStatus.fonts = 'unreachable';
  }
}
