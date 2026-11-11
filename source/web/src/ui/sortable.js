// 縦に並んだものの並べ替え：つまみを押したまま動かす。マウスでも指でも同じように動く（pointer events）。
// 動かしている間は、入る場所の行に drop-before / drop-after が付く（線は CSS で描く）。つまみには touch-action: none を付けておく。

/**
 * @param {HTMLElement} container 並びの入れ物（中身を描き直しても、付け直さなくてよい）
 * @param {{item: string, handle: string, onMove: (from: number, to: number) => void}} o
 *   item・handle は CSS セレクタ。onMove(from, to)：from の行を抜き、to の位置に入れる（Array の splice と同じ数え方）
 */
export function sortable(container, o) {
  container.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const handle = e.target instanceof Element ? e.target.closest(o.handle) : null;
    if (!handle || !container.contains(handle)) return;
    const row = handle.closest(o.item);
    const items = [...container.querySelectorAll(o.item)];
    const from = items.indexOf(row);
    if (from < 0) return;
    const startX = e.clientX, startY = e.clientY;
    let to = from, moved = false;
    let scroller = container;
    while (scroller && scroller !== document.body && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const clear = () => { for (const n of items) n.classList.remove('drop-before', 'drop-after'); };
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      if (!moved) {
        moved = true;
        row.classList.add('is-dragging');
        document.body.classList.add('is-sorting');
        try { handle.setPointerCapture(e.pointerId); } catch { /* なくても動く */ }
      }
      ev.preventDefault();
      let pos = items.length;   // 入る場所（0 〜 個数）
      for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { pos = i; break; }
      }
      clear();
      to = pos > from ? pos - 1 : pos;
      if (to !== from) {
        if (pos < items.length) items[pos].classList.add('drop-before');
        else items[items.length - 1].classList.add('drop-after');
      }
      if (scroller && scroller !== document.body) {
        const r = scroller.getBoundingClientRect();
        if (ev.clientY < r.top + 48) scroller.scrollTop -= 14;
        else if (ev.clientY > r.bottom - 48) scroller.scrollTop += 14;
      }
    };
    const end = (commit) => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      clear();
      row.classList.remove('is-dragging');
      document.body.classList.remove('is-sorting');
      if (!moved) return;
      // 動かしたあとの「クリック」で、行が選ばれたりしないようにする
      const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener('click', stop, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', stop, true), 0);
      if (commit && to !== from) o.onMove(from, to);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
  });
}

/** 配列の from の要素を to の位置へ動かす（その場で書き換える）。 */
export function moveItem(arr, from, to) {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return false;
  const [x] = arr.splice(from, 1);
  arr.splice(to, 0, x);
  return true;
}
