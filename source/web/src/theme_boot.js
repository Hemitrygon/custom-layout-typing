// 起動の画面を、保存したテーマの色で出す（main.js より先に、すぐ読む小さなスクリプト）。
// 設定は main.js が読み直して、きちんと反映する。ここは「最初の一瞬」の色だけ。
try {
  const s = JSON.parse(localStorage.getItem('custom_typing_settings_v1') || 'null');
  const t = s && s.theme;
  const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (t === 'light' || (t === 'auto' && !dark)) document.documentElement.dataset.theme = 'light';
} catch { /* 読めなければダーク */ }
