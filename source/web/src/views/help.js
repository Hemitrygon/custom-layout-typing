// ヘルプ：右上の「ヘルプ」の一覧・操作ガイド（各機能の説明・ランクの基準・シャトルランのレベル一覧・
// プライバシーポリシー・このツールについて）・ローマ字の比較表。
// 文は旧版（v5.4.5）の操作ガイドをもとに、v6 の画面（設定の引き出し・3D のキーボードなど）に合わせてある。
// 数字（ランク・シャトルランのルール・トロフィーの数）は Rust（core）から取るので、ルールと説明がずれない。
import { core } from '../core.js';
import { $, html, act } from '../ui/dom.js';
import { openModal, openPop } from '../ui/overlay.js';
import { levelTableHtml } from './shuttle.js';

const SOURCE_URL = 'https://github.com/Hemitrygon/custom-layout-typing';
// 「はやさの目安」：正確率 96%・リズム 90% で打ったときに、そのスコアに届く速さ（旧版（v5）の RANK_GUIDE_FACTOR）
const RANK_GUIDE_FACTOR = 10 * Math.pow(0.96, 3) * 0.9;

const SECTIONS = [
  ['keys', '練習の操作'],
  ['input', '入力の仕組み'],
  ['words', '練習文'],
  ['editor', '配列エディタ'],
  ['analyze', '配列分析'],
  ['shuttle', 'シャトルラン'],
  ['score', 'スコアとランク'],
  ['history', '記録'],
  ['privacy', 'プライバシーポリシー'],
  ['about', 'このツールについて'],
];

let hooks = { openTutorial: () => {} };
let guide = null;   // 開いている操作ガイド

// ---------- 表 ----------

function rankTableHtml() {
  const ranks = core.scoreRanks();
  const rows = ranks.map((r, i) => {
    const upper = i === 0 ? null : ranks[i - 1].min - 1;
    const range = upper === null ? r.min.toLocaleString() + ' 〜' : r.min.toLocaleString() + ' 〜 ' + upper.toLocaleString();
    const cpm = Math.round(r.min / RANK_GUIDE_FACTOR);
    const firstOfTier = i === 0 || ranks[i - 1].tier !== r.tier;
    return html`<tr class="${firstOfTier && i > 0 ? 'is-tier' : ''}">
      <td><span class="rank-pill" style="--rank:${r.color}">${r.rank}</span></td>
      <td class="num">${range}</td>
      <td class="num r">${r.min === 0 ? '-' : cpm + ' 〜'}</td>
      <td class="num r">${r.min === 0 ? '-' : ((cpm * 1.7) / 60).toFixed(1) + ' 〜'}</td>
      <td class="muted">${firstOfTier ? r.label : ''}</td></tr>`;
  });
  return html`<table class="table help-ranks"><thead><tr><th>ランク</th><th>スコア</th><th class="r">はやさの目安（文字/分）</th><th class="r">打鍵の目安（打/秒・ローマ字）</th><th>レベル</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const ROMAJI_ROWS = [
  ['し', 'shi', 'si'], ['しゃ、しゅ、しょ', 'sha, shu, sho', 'sya, syu, syo'], ['じ', 'ji', 'zi'], ['じゃ、じゅ、じょ', 'ja, ju, jo', 'zya, zyu, zyo'],
  ['ち', 'chi', 'ti'], ['ちゃ、ちゅ、ちょ', 'cha, chu, cho', 'tya, tyu, tyo'], ['ぢ', 'ji', 'di'], ['ぢゃ、ぢゅ、ぢょ', 'ja, ju, jo', 'dya, dyu, dyo'],
  ['つ', 'tsu', 'tu'], ['づ', 'zu', 'du'], ['ふ', 'fu', 'hu'], ['を', 'o', 'wo'], ['ん', 'n か m（b、m、p の前は m）', 'n'],
];

export function openRomajiTable() {
  openModal({
    title: '日本式とヘボン式の比較表',
    id: 'romaji',
    body: html`
      <p>「設定」の「ローマ字方式」で選択した方式で、ガイドと配列分析を計算します</p>
      <table class="table help-romaji"><thead><tr><th>かな</th><th>ヘボン式</th><th>日本式</th></tr></thead>
        <tbody>${ROMAJI_ROWS.map(([kana, hep, nihon]) => html`<tr><td><b>${kana}</b></td><td class="mono">${hep}</td><td class="mono help-nihon">${nihon}</td></tr>`)}</tbody></table>
      <p class="help-note">どちらの綴りで打っても正解になり、途中で綴りを変えても問題ありません</p>`,
    foot: html`<button class="btn btn-primary" data-modal-close>閉じる</button>`,
  });
}

// ---------- 操作ガイド ----------

function shuttleText() {
  const r = core.shuttleRules();
  const pct = (v) => Math.round((v - 1) * 100);
  return html`
    <ul>
      <li>練習画面の「シャトルランに挑戦」から始め、文を打ち終えるとすぐ次のレベルに進みます</li>
      <li>レベル 1 は 1 分あたり約 ${Math.round(r.startKps * 60)} 打のペースで、レベルが上がるごとにペースが ${pct(r.growth)}% ずつ上がります（レベル ${r.lateFrom} 以降は ${pct(r.growthLate)}% ずつ）</li>
      <li>ノーミスで ${r.comboEvery} 打続けると ${r.comboBonus} 秒増え、ミスをすると ${r.missPenalty} 秒減ります（同じレベルで ${r.heavyAfter + 1} 回目以降は ${r.missPenaltyHeavy} 秒）</li>
      <li>残り時間の ${Math.round(r.carryRate * 100)}% は次のレベルに持ち越せ（最大 ${r.carryMax} 秒）、ノーミスならさらに ${r.perfectBonus} 秒増えます</li>
      <li>ノーミスのレベルを ${r.shieldStreak} つ続けるとシールドを 1 つ獲得でき（最大 ${r.shieldMax} つ）、時間切れを 1 回防ぎます</li>
      <li>シールド発動後の ${r.invincibleSec} 秒間は、時間が減らずミスも数えません</li>
      <li>レベル ${r.twoPartsFrom} からは長い文を 2 つに、レベル ${r.threePartsFrom} からは 3 つに分けて表示します</li>
      <li>条件を満たすとトロフィーを獲得でき（全 ${core.trophyTable().length} 個）、記録を削除してもトロフィーは残ります</li>
      <li><kbd>Esc</kbd> で一時停止でき、別のウィンドウに移ったときも自動で停止します</li>
    </ul>
    <h4 id="help-levels">レベル一覧</h4>
    <p class="help-note">制限時間は、必要なペースでちょうど打ち終えられる時間です（持ち越しやボーナスは含みません）</p>
    <div class="help-table-wrap">${levelTableHtml()}</div>`;
}

function guideHtml() {
  const sec = (id, title, body) => html`<section class="help-sec" id="help-${id}"><h3>${title}</h3>${body}</section>`;
  return html`
    <nav class="help-nav" aria-label="目次">${SECTIONS.map(([id, label]) => html`<button class="chip" data-h="${id}">${label}</button>`)}</nav>

    ${sec('keys', '練習の操作', html`
      <ul class="help-keys">
        <li><span><kbd>Space</kbd></span>開始する</li>
        <li><span><kbd>Esc</kbd></span>一時停止する</li>
        <li><span><kbd>Space</kbd></span>一時停止中に再開する</li>
        <li><span><kbd>Esc</kbd></span>一時停止中に最初からやり直す</li>
        <li><span><kbd>Space</kbd> <kbd>Enter</kbd></span>結果からもう一度（グループなら次へ）</li>
        <li><span><kbd>Esc</kbd></span>結果から待機画面に戻る</li>
      </ul>
      <ul>
        <li>押したキーは 3D キーボードでも沈み、次に押すキーと使う指も光ります</li>
        <li>3D キーボードは US 配列の形のため、¥ と ろ のキーを表示したい場合は「設定」で「練習のキーボード」を「平面」にします</li>
        <li>「設定」で、テーマ、運指の色分け、よみがなやローマ字の表示などを変更できます</li>
      </ul>`)}

    ${sec('input', '入力の仕組み', html`
      <ul>
        <li>押したキーの<strong>位置</strong>を選択した配列の文字に読み替えて判定するため、今のキーボードのまま他の配列を練習できます</li>
        <li>キーボード本体や AutoHotkey で配列を変更している場合は、「設定」の「キーボード調整」を行ってください（全てのキーを 1 回ずつ押すだけです）</li>
        <li>! や ? などの記号は Shift と一緒に入力し、光らせる Shift は「設定」で変更できます</li>
        <li>数字や記号をレイヤーから入力している場合は、「設定」の「追加のキー」で登録します</li>
      </ul>`)}

    ${sec('words', '練習文', html`
      <ul>
        <li>変更は「保存する」で確定し、<kbd>Ctrl</kbd>+<kbd>Z</kbd> で 1 つずつ取り消せます</li>
        <li>文章を貼り付けると 1 行 1 文で登録でき、漢字は自動でよみがなとローマ字に変換します（誤ることがあるため確認してください）</li>
        <li>「自動改行」で長い文を短・中・長（6・12・18 文字）ごとに分割でき、記号を削除する場合は先に「記号を削除」を使ってください</li>
        <li>正しく読めない言葉は「変換辞書」に読みを登録すると、次回から正しく変換します</li>
        <li>「グループ」で複数のプリセットをまとめて続けて練習でき、順番どおり・シャッフル・全シャッフルから選択できます</li>
        <li>プリセットごとに「英文」にも設定でき、英文ではスペースも 1 文字として入力します</li>
        <li>左端のつまみをドラッグすると並べ替えられます</li>
      </ul>`)}

    ${sec('editor', '配列エディタ', html`
      <ul>
        <li>キーを選択して下の一覧から文字を選ぶと割り当てられ（VIAL と同じ要領）、実際のキーを押して選択することもできます</li>
        <li>「Shift と一緒」に切り替えると、Shift と一緒に押したときの文字を設定できます</li>
        <li>「使用中の文字は入れ替える」がオンなら、同じ文字が 2 か所に重複しません</li>
        <li>キー同士をドラッグすると入れ替わり、<kbd>Ctrl</kbd>+<kbd>Z</kbd> で取り消せます</li>
        <li>大西配列などのプリセットは上書きされず、変更内容は保存枠に保存されます</li>
        <li>.json と .ahk（AutoHotkey）の読み込みと書き出しができます</li>
      </ul>`)}

    ${sec('analyze', '配列分析', html`
      <ul>
        <li>「配列」タブ上部の「配列分析」ボタンで分析欄に移動します（文字の一覧の下にあります）</li>
        <li><strong>理論値</strong>は、選択した練習文をガイドどおりに打った場合の計算値です</li>
        <li><strong>実測</strong>は、直前の練習で正しく打ったキーのみを集計します</li>
        <li>ホーム段の割合が高いほど、指の移動が少なくなります</li>
        <li>左右交互の割合が高く、同じ指の連続が少ないほど打ちやすくなります</li>
      </ul>`)}

    ${sec('shuttle', 'シャトルラン', shuttleText())}

    ${sec('score', 'スコアとランク', html`
      <p class="help-formula">スコア ＝ <strong>はやさ</strong> × <strong>せいかくさ</strong> × <strong>リズム</strong></p>
      <ul>
        <li><strong>はやさ</strong>は、標準のローマ字で何打になるかを数えて文字/分に換算するため、どの方式で打っても同じ基準で測れます</li>
        <li><strong>せいかくさ</strong>は正確率の 3 乗で、ミスが多いと大きく下がります（95% で 0.857 倍）</li>
        <li><strong>リズム</strong>は、途中で止まった打鍵が少ないほど高くなります（0.7〜1.0 倍）</li>
      </ul>
      <h4 id="help-ranks">ランクの基準（全 ${core.scoreRanks().length} 段階）</h4>
      <p class="help-note">ランクはスコアのみで決まり、目安は正確率 96%、リズム 90% で打った場合の速さです</p>
      <div class="help-table-wrap">${rankTableHtml()}</div>`)}

    ${sec('history', '記録', html`
      <ul>
        <li>最後まで打ち終えた回のみ記録します</li>
        <li>グラフでは、スコアの推移と期間内の最高値を確認できます</li>
        <li>「難易度補正」をオンにすると、練習文ごとの得点の出やすさを揃えて比較できます</li>
        <li>記録はこのブラウザ内にのみ保存され、右上の「データ」から書き出せます</li>
      </ul>`)}

    ${sec('privacy', 'プライバシーポリシー', html`
      <ul>
        <li>個人情報は収集せず、アカウント・アクセス解析・広告もありません</li>
        <li>入力した文字や記録はこのブラウザ内にのみ保存し、誰にも送信しません</li>
        <li>外部との通信は 2 種類のみで、画面のフォントを Google Fonts から、漢字変換の辞書を jsDelivr か unpkg から読み込みます（辞書は使用時のみ）</li>
        <li>その際、IP アドレスなどが各サービスに送信されます</li>
        <li>プログラムと 3D キーボードは、このページと同じ場所から読み込みます</li>
        <li>バックアップは、ご自身で選択した場所に保存されます</li>
        <li>右上の「データ」から、保存したデータを全て削除できます</li>
        <li>このポリシーを変更する際は、ここでお知らせします（2026年10月20日　Hemitrygon）</li>
      </ul>`)}

    ${sec('about', 'このツールについて', html`
      <p>© 2026 Hemitrygon<br>GPL-3.0 で公開しているフリーソフトウェアで、誰でも使用・複製・改変・再配布ができます<br>改変したものを配布する場合は、そのソースコードも GPL-3.0 で公開してください<br>本ソフトウェアは無保証で、Hemitrygon の名前とロゴは GPL-3.0 の対象外です</p>
      <p>ソースコード：<a href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer">${SOURCE_URL.replace('https://', '')}</a><br>開発には AI（Anthropic Claude Code）を使用しています</p>
      <p class="help-note">使用しているもの：three.js（MIT）、Draco（Apache 2.0）、Vite（MIT）、Rust の標準ライブラリ・wasm-bindgen・serde_json など（MIT か Apache 2.0 ほか）、kuromoji.js（Apache 2.0）、Zen Kaku Gothic New、Sora、JetBrains Mono（SIL OFL）<br>ライセンスの全文：<a href="${SOURCE_URL}/blob/main/THIRD_PARTY_NOTICES.md" target="_blank" rel="noopener noreferrer">THIRD_PARTY_NOTICES.md</a></p>`)}`;
}

/** 操作ガイドを開く。section：'ranks'・'levels'・'privacy' など、開いたときに見せる場所。 */
export function openGuide(section) {
  if (!guide) {
    guide = openModal({
      title: '操作ガイド',
      size: 'xl',
      id: 'help',
      body: guideHtml(),
      foot: html`<button class="btn" data-h="tutorial">チュートリアルを見る</button><span class="grow"></span><button class="btn btn-primary" data-modal-close>閉じる</button>`,
      onClose: () => { guide = null; },
    });
    guide.root.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest('[data-h]') : null;
      if (!b) return;
      if (b.dataset.h === 'tutorial') { guide.close(); hooks.openTutorial(); } else scrollGuide(b.dataset.h);
    });
  }
  if (section) scrollGuide(section);
}

function scrollGuide(section) {
  const node = guide ? $('#help-' + section, guide.root) : null;
  if (node) node.scrollIntoView({ block: 'start', behavior: 'auto' });   // 長い文書なので、なめらかに動かさず、すぐ見せる
}

function openHelpMenu(anchor) {
  openPop(anchor, [
    { text: '操作ガイド', link: true, onPick: () => openGuide() },
    { text: 'チュートリアルを見る', link: true, onPick: () => hooks.openTutorial() },
    { sep: true },
    { text: 'ローマ字の比較表', link: true, onPick: () => openRomajiTable() },
    { text: 'スコアとランクの基準', link: true, onPick: () => openGuide('score') },
    { text: 'シャトルランのルール', link: true, onPick: () => openGuide('shuttle') },
    { sep: true },
    { text: 'プライバシーポリシー', link: true, onPick: () => openGuide('privacy') },
    { text: 'このツールについて', link: true, onPick: () => openGuide('about') },
  ], { align: 'right' });
}

/** 起動のときに 1 回：ボタンをつなぐ。 @param {{openTutorial: Function}} h */
export function wireHelp(h) {
  hooks = { ...hooks, ...h };
  act({
    'help.menu': (_, node) => openHelpMenu(node),
    'help.romaji': () => openRomajiTable(),
    'help.ranks': () => openGuide('ranks'),
  });
}
