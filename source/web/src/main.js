// 画面の入口：Rust（WASM）を読み込む → 保存データを読む → 画面を組み立てる → 3D のキーボードを読み込む。
import './styles/base.css';
import './styles/practice.css';
import './styles/shuttle.css';
import './styles/history.css';
import './styles/words.css';
import './styles/editor.css';
import './styles/dialogs.css';
import { initCore } from './core.js';
import { Stage } from './scene/stage.js';
import { A, VERSION_LABEL, buildShell, wireApp, initData, mountViews, registerView, applySettings, applyStage, syncSlot, syncLegends, switchTab, currentTheme } from './app.js';
import * as model from './model.js';
const { S } = model;
import { loadWebFonts } from './fonts.js';
import { banner } from './ui/overlay.js';
import { historyView } from './views/history.js';
import { wordsView } from './views/words.js';
import { editorView } from './views/editor.js';
import { practiceScreen } from './views/practice.js';
import { wireData, maybeBackupReminder } from './views/data.js';
import { wireHelp, openGuide } from './views/help.js';
import { wireCalib, openCalibration, suggestCalibration } from './views/calib.js';
import { wireTutorial, openTutorial, shouldAutoStartTutorial } from './views/tutorial.js';

const core = await initCore();
const params = new URLSearchParams(location.search);
const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

buildShell();
initData();
document.documentElement.dataset.theme = currentTheme();   // 最初に描く前に（ここまでは同じ流れの中なので、ちらつかない）
A.stage = new Stage(document.getElementById('stage'), { theme: currentTheme(), quality: params.get('q') || (S.settings.lowQuality ? 'low' : undefined), reducedMotion: reduced });
wireApp();
// 上の帯から開くダイアログ：データ・ヘルプ・キーボード調整・追加のキー・チュートリアル
const shuttlePhase = () => (A.hooks.shuttleActive && A.hooks.shuttleActive() ? document.getElementById('shuttle').dataset.phase : '');
wireData({
  tab: () => A.tab,
  // バックアップのおすすめを出してよい場面か（'result'：練習の結果、'shuttle'：シャトルランの結果）
  screen: () => { const ph = shuttlePhase(); return ph ? (ph === 'over' ? 'shuttle' : 'shuttle-' + ph) : A.tab === 'practice' ? practiceScreen() : A.tab; },
  dirty: () => S.layoutDirty || S.wordsDirty,
});
wireCalib();
wireHelp({ openTutorial });
wireTutorial({ switchTab, openCalibration, openPrivacy: () => openGuide('privacy'), wave: () => { if (A.stage) A.stage.wave({ from: 'center', strength: 0.5, speed: 1.4 }); } });
Object.assign(A.hooks, { maybeBackupReminder, suggestCalibration });
registerView('words', wordsView);
registerView('editor', editorView);
registerView('history', historyView);
mountViews();
applySettings();
syncSlot(true);
applyStage();
loadWebFonts({
  onReady: () => A.stage.refreshLegends(),
  onProblem: (what) => banner('外部から読み込んだ「' + what + '」が想定と異なるため使用せず、端末のフォントで表示しています'),
});

document.title = 'カスタム配列タイピング ' + VERSION_LABEL;
window.__app = { ready: false, A, S, core, model };   // 開発・テスト用（画面の外から状態を見る）
document.documentElement.dataset.core = core.version();

let keys = 0;
try {
  keys = await A.stage.load(import.meta.env.BASE_URL);
  syncLegends();
} catch (e) {
  console.error(e);
  banner('3D キーボードを読み込めませんでしたが、練習はそのまま行えます');
}
document.documentElement.dataset.keys = String(keys);
document.getElementById('boot').classList.add('is-done');
window.__app.ready = true;
// 初めて開いた人には、案内を出す（?tutorial=0 で出さない：自動の確認用）
if (params.get('tutorial') !== '0' && shouldAutoStartTutorial()) openTutorial();
