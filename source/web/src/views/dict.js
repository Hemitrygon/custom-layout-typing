// 変換辞書のダイアログ：漢字かな変換でうまく読めなかった言葉と、正しいよみを登録する。
// 辞書の中身と当てはめ方は Rust（UserDictionary）。ここは画面の流れだけ。
import { core } from '../core.js';
import { S, saveDict } from '../model.js';
import { $, html, setHtml } from '../ui/dom.js';
import { openModal } from '../ui/overlay.js';

// Rust の dict.rs と同じ上限
const DICT_MAX = 2000, WORD_MAX = 32, READING_MAX = 64;

/** 登録してあるよみ（なければ null）。 */
export const dictReadingOf = (word) => { const e = S.dict.entries().find((x) => x[0] === word); return e ? e[1] : null; };

/**
 * @param {{word?: string, reading?: string, log?: (text: string, kind: string) => void, sentencesWith?: (word: string) => number[],
 *   apply?: (indices: number[]) => void, onChange?: () => void}} o
 *   word・reading：最初から入れておく候補。sentencesWith：今のプリセットでその言葉を含む文の番号。apply：その文を変換し直す。
 */
export function openDictDialog(o = {}) {
  const log = o.log || (() => {});
  const clip = (s, n) => { const t = [...String(s || '')]; return t.length > n ? t.slice(0, n).join('') + '…' : t.join(''); };
  let editing = null;      // 「直す」で開いている言葉
  let applyWord = '';

  const m = openModal({
    title: '変換辞書（漢字かな変換）',
    size: 'l',
    id: 'dict',
    body: html`
      <p>正しく読めなかった言葉と正しい読みを登録すると、次回から<strong>最優先で</strong>使用します<br>よみがなを手動で修正すると、その行にも「辞書に登録」が表示されます</p>
      <div class="ud-form">
        <label>言葉（問題文での書き方）<input class="field" id="udWord" type="text" maxlength="${WORD_MAX}" spellcheck="false" autocomplete="off" placeholder="例：生憎"></label>
        <label>読み（ひらがな）<input class="field" id="udReading" type="text" maxlength="${READING_MAX}" spellcheck="false" autocomplete="off" placeholder="例：あいにく"></label>
        <div class="ud-actions"><button class="btn btn-primary" data-d="add" id="udAdd">登録</button><button class="btn btn-ghost" data-d="cancel" id="udCancel" hidden>キャンセル</button></div>
      </div>
      <p class="ud-msg" id="udMsg" role="status" aria-live="polite"></p>
      <div class="ud-apply" id="udApply" hidden><span id="udApplyText"></span><button class="btn btn-s btn-primary" data-d="apply">当てはめる</button></div>
      <div class="ud-list-head"><b>登録した言葉</b><span class="num muted" id="udCount">0 語</span></div>
      <div class="ud-list" id="udList"></div>
      <details class="ud-spec">
        <summary>詳しい仕様</summary>
        <ul>
          <li><strong>照合</strong>：登録した言葉と<strong>一字一句同じ部分</strong>を探します（送り仮名も比較します）</li>
          <li><strong>活用形</strong>：送り仮名付きで登録すると（憚る → はばかる）、「憚らない」のような活用形も読めます</li>
          <li><strong>漢字のみ</strong>で登録すると（雨 → あま）、その漢字を含む全ての文で使用します</li>
          <li><strong>優先順位</strong>：変換辞書、内蔵辞書、形態素解析の順に使用し、重なる場合は長い言葉を優先します</li>
          <li><strong>読み</strong>：カタカナで入力してもひらがなに変換し、漢字は登録できません</li>
          <li><strong>反映</strong>：登録後に変換した文から適用され、既存の文は「当てはめる」で変換し直せます</li>
          <li>「修正」で開いた登録は「更新」で置き換わります</li>
        </ul>
      </details>`,
    foot: html`<button class="btn" data-modal-close>閉じる</button>`,
    onKey: (e) => {
      if (e.key === 'Escape' && editing !== null) { e.preventDefault(); cancelEdit(); return true; }
      if (e.key === 'Enter' && e.target instanceof Element && (e.target.id === 'udWord' || e.target.id === 'udReading')) {
        e.preventDefault();
        if (e.target.id === 'udWord' && !readingEl.value.trim()) readingEl.focus();
        else add();
        return true;
      }
      return false;
    },
  });
  const wordEl = $('#udWord', m.root), readingEl = $('#udReading', m.root);

  const message = (text, isError = false) => { const n = $('#udMsg', m.root); n.textContent = text; n.classList.toggle('is-err', isError); };
  const setEditing = (word) => {
    editing = word;
    $('#udAdd', m.root).textContent = word === null ? '登録' : '更新';
    $('#udCancel', m.root).hidden = word === null;
    for (const row of m.root.querySelectorAll('.ud-row')) row.classList.toggle('is-editing', row.dataset.word === word);
  };
  const renderList = () => {
    const entries = S.dict.entries();
    $('#udCount', m.root).textContent = entries.length + ' 語';
    setHtml($('#udList', m.root), entries.length
      ? entries.map(([word, reading], i) => html`<div class="ud-row ${word === editing ? 'is-editing' : ''}" data-word="${word}">
          <span class="ud-word">${word}</span><span class="ud-arrow">→</span><span class="ud-reading">${reading}</span>
          <button class="btn btn-s" data-d="edit" data-w="${word}">修正</button><button class="btn btn-s btn-danger" data-d="delete" data-w="${word}">削除</button></div>`)
      : html`<div class="ud-empty">まだ登録した言葉はありません</div>`);
  };
  const hideApply = () => { $('#udApply', m.root).hidden = true; };
  const showApply = (word) => {
    const n = o.sentencesWith ? o.sentencesWith(word).length : 0;
    applyWord = word;
    $('#udApply', m.root).hidden = !n;
    $('#udApplyText', m.root).textContent = '現在のプリセットに「' + word + '」を含む文が ' + n + ' 文あり、「当てはめる」で読みを変換し直せます（「一つ前に戻る」で取り消し可能）';
  };
  const commit = (entries) => { S.dict.setEntries(entries); saveDict(); if (o.onChange) o.onChange(); };

  function cancelEdit() {
    setEditing(null);
    wordEl.value = '';
    readingEl.value = '';
    message('');
    wordEl.focus();
  }

  function add() {
    const word = core.cleanDictWord(wordEl.value);
    if (!word) {
      message(wordEl.value.trim() ? '言葉は ' + WORD_MAX + ' 文字以内で、| とタブは使用できません' : '言葉を入力してください', true);
      wordEl.focus();
      return;
    }
    const reading = core.cleanDictReading(readingEl.value);
    if (!reading) {
      const rawReading = core.normalizeReading(readingEl.value);
      message(!rawReading ? '読みを入力してください'
        : core.hasUnconvertedKanji(rawReading) ? '読みはひらがな（またはカタカナ）で入力してください'
          : rawReading.length > READING_MAX ? '読みは ' + READING_MAX + ' 文字以内です'
            : '読みに入力できない文字が含まれています（ひらがなで入力してください）', true);
      readingEl.focus();
      return;
    }
    const entries = S.dict.entries();
    const existed = dictReadingOf(word);
    // 「直す」：その登録の場所のまま置き換える（言葉そのものを変えたときも）
    const target = editing !== null && entries.some((e) => e[0] === editing) ? editing : null;
    if (target === null && existed === null && entries.length >= DICT_MAX) {
      message('登録できるのは ' + DICT_MAX + ' 語までのため、使わない言葉を削除してください', true);
      return;
    }
    let text;
    if (target !== null) {
      commit(entries.filter((e) => e[0] !== word || e[0] === target).map((e) => (e[0] === target ? [word, reading] : e)));
      text = target === word
        ? '「' + word + '」の読みを「' + reading + '」に修正しました'
        : '「' + target + '」を「' + word + '」→「' + reading + '」に修正しました' + (existed !== null ? '（既存の「' + word + '」はこれに置き換えました）' : '');
    } else {
      commit([[word, reading]].concat(entries.filter((e) => e[0] !== word)));
      text = existed !== null ? '「' + word + '」の読みを「' + reading + '」に修正しました' : '「' + word + '」→「' + reading + '」を登録しました';
    }
    wordEl.value = '';
    readingEl.value = '';
    setEditing(null);
    renderList();
    message(text + ([...word].length === 1 ? '（1 文字の言葉は、その文字を含む全ての文で使用されます）' : ''));
    log('$ dict ' + (target !== null || existed !== null ? 'update' : 'add') + ' "' + clip(word, 16) + '" → "' + clip(reading, 24) + '"', 'cmd');
    showApply(word);
    wordEl.focus();
  }

  m.root.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-d]') : null;
    if (!b) return;
    const kind = b.dataset.d;
    // 一覧の番号ではなく言葉で引く（別のウィンドウで辞書が変わっていても、押した言葉に当たる）
    const entries = S.dict.entries();
    const at = b.dataset.w === undefined ? -1 : entries.findIndex((e) => e[0] === b.dataset.w);
    const entry = at >= 0 ? entries[at] : null;
    if ((kind === 'edit' || kind === 'delete') && !entry) { renderList(); message('この言葉は、別のウィンドウで変更されたため一覧を更新しました', true); return; }
    if (kind === 'add') add();
    else if (kind === 'cancel') cancelEdit();
    else if (kind === 'apply') {
      const indices = o.sentencesWith ? o.sentencesWith(applyWord) : [];
      hideApply();
      if (indices.length && o.apply) {
        o.apply(indices);
        message('「' + applyWord + '」を含む ' + indices.length + ' 文の読みを変換し直しました（結果は変換ログに表示されます）');
      }
    } else if (kind === 'edit' && entry) {
      wordEl.value = entry[0];
      readingEl.value = entry[1];
      setEditing(entry[0]);
      readingEl.focus();
      readingEl.select();
      hideApply();
      message('「' + entry[0] + '」を修正中です（言葉や読みを修正して「更新」を押すと、この登録が置き換わります）');
    } else if (kind === 'delete' && entry) {
      if (entry[0] === editing) { setEditing(null); wordEl.value = ''; readingEl.value = ''; }
      commit(entries.filter((_, j) => j !== at));
      renderList();
      hideApply();
      message('「' + entry[0] + '」を辞書から削除しました');
      log('$ dict remove "' + clip(entry[0], 16) + '"', 'cmd');
    }
  });

  wordEl.value = typeof o.word === 'string' ? o.word : '';
  readingEl.value = typeof o.reading === 'string' ? o.reading : '';
  renderList();
  (o.word ? $('#udAdd', m.root) : wordEl).focus();
  return m;
}
