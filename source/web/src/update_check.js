// 古いキャッシュが残っていても、新しい版に入れ替える。
//   ビルドのときに version.json（今の版番号）を一緒に置く（vite.config.js）。開いたときに、それをキャッシュを使わずに読み、
//   動いている版と違えば、ページ（index.html）をキャッシュを使わずに取り直してから読み込み直す。
//   - URL は変えない（ページの URL も、保存データの場所＝localStorage も同じまま）
//   - 同じ版へのやり直しは 1 回だけ（sessionStorage の印）。サーバー側が古いままなどで、読み込み直しを繰り返さない
//   - 通信できない・開発サーバー（version.json がない）ときは何もしない
/* global __APP_VERSION__ */

const MARK = 'clt-update-reload';   // sessionStorage（タブを閉じると消える。保存データとは別）

/** 開いたときに 1 回呼ぶ。待たなくてよい（失敗しても何もしない）。 */
export async function checkForUpdate() {
  if (import.meta.env.DEV) return;
  try {
    const res = await fetch('./version.json', { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return;
    const latest = String((await res.json()).version || '');
    if (!latest || latest === __APP_VERSION__) {
      try { sessionStorage.removeItem(MARK); } catch { /* 使えない環境 */ }
      return;
    }
    let tried = null;
    try { tried = sessionStorage.getItem(MARK); } catch { /* 使えない環境 */ }
    if (tried === latest) return;   // もうやり直した（それでも古いなら、繰り返さない）
    try { sessionStorage.setItem(MARK, latest); } catch { return; }   // 印を残せないなら、繰り返しを防げないのでやめる
    // ページ本体のキャッシュを新しくする（cache: 'reload' はキャッシュを使わずに取り、取ったものでキャッシュを置き換える）
    const page = location.href.split('#')[0];
    await Promise.all([page, new URL('./', location.href).href, new URL('./index.html', location.href).href]
      .filter((u, i, a) => a.indexOf(u) === i)
      .map((u) => fetch(u, { cache: 'reload', credentials: 'same-origin' }).catch(() => null)));
    location.reload();
  } catch { /* 通信できないときなどは、今の版のまま使う */ }
}
