// 漢字のよみを付ける形態素解析（kuromoji 0.1.2）。使うときにだけ CDN から読み込む（プログラム約 300KB ＋ 辞書 12 ファイル 約 17MB）。
// どのファイルも「データ」として受け取り、SHA-256 が決めた値と一致したときだけ使う（旧版（v5）と同じ確かめ方）。
// 改ざんされた・こわれた CDN のプログラムがここで動いたり、こわれた辞書が使われたりすることはない。
import { cdnStatus } from './fonts.js';

const SOURCES = [
  { name: 'jsDelivr', base: 'https://cdn.jsdelivr.net/gh/takuyaa/kuromoji.js@0.1.2/' },
  { name: 'jsDelivr', base: 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/' },
  { name: 'unpkg', base: 'https://unpkg.com/kuromoji@0.1.2/' },
];
const SHA256 = {
  'build/kuromoji.js': 'ab0ac10f1c4a9b5e246e63e57b04ba14d3a6148cd7e8d62cb97a960d4f85a3e6',
  'dict/base.dat.gz': '0803327762e1c93ca731e4319ab8343340f2806bb84941207782cde9d2d5a8eb',
  'dict/cc.dat.gz': '02b7631be0d4de3a1a75cd9f9cc51536e4f94c9e6b389b813e06ba0f6e7de765',
  'dict/check.dat.gz': '193ae0035fff6fe812b58d9ee730e7a7d7ee601d918481ce51075c58114f6cc9',
  'dict/tid.dat.gz': 'd43d831cb6fb0f0a411739cd287a6d5e998e121a8daca614df14a81a0dcac586',
  'dict/tid_map.dat.gz': '33efd5ffd87a70f669add093fa39dee44341d58f940844ef107c8fd98bb795b2',
  'dict/tid_pos.dat.gz': '60dbfc99a6ab993f30c5dab648bec6ad7f9aaefa5c14e1843837d95e509f8895',
  'dict/unk.dat.gz': 'f7f991cdeb9bfd3e9c0e4577cc50ee0815a11c508cccd444a9d3ab3c81521100',
  'dict/unk_char.dat.gz': '9a8e86fd9aff32d323fbb59f5a7006f05927a11f8173c90712cc56293aeb3225',
  'dict/unk_compat.dat.gz': '50f60aa29bc2e86c2903ab8c825bb6fa604d2b294d96941c1d3924259791899d',
  'dict/unk_invoke.dat.gz': '6b210889548457c3006913afd12c8b525562255f2709e404604be9614a25e94c',
  'dict/unk_map.dat.gz': '6df12460e5477230bb6fd9641def918b699fc0a8868016b6c9f794488630509b',
  'dict/unk_pos.dat.gz': '5b183a29f281acc7e0542beca47b83f7985047c0a2d27e78a66f32276be5ad11',
};

let log = () => {};          // (文, 種類) 変換ログに出す
let onProblem = () => {};    // (文) 画面の上の帯で知らせる
let scriptPromise = null;
let tokenizer = null;
let loading = null;
let guarded = false;
const verifiedDict = new Set();   // 中身を確かめた辞書のファイル
const DICT_FILES = Object.keys(SHA256).filter((f) => f.startsWith('dict/'));
cdnStatus.problems = cdnStatus.problems || [];

/** 変換ログへの出し方と、異常を知らせる先を決める。 */
export function setKuromojiHooks(hooks) {
  if (hooks.log) log = hooks.log;
  if (hooks.onProblem) onProblem = hooks.onProblem;
}

/** 読み込み済みの tokenizer（まだなら null）。 */
export const kuromojiTokenizer = () => tokenizer;

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fileFromUrl(url) {
  for (const src of SOURCES) if (typeof url === 'string' && url.startsWith(src.base)) return { src, file: url.slice(src.base.length) };
  return null;
}

// CDN から届いたものが決めた内容と違った：使わず、利用者に知らせる
let tampered = false;   // kuromoji のファイルの中身が合わなかった（改ざん・配信の異常）
function reportProblem(host, what) {
  tampered = true;
  const msg = host + ' から届いた' + what + 'が本来の内容と一致せず、改ざんや配信異常の可能性があるため使用していません';
  if (!cdnStatus.problems.includes(msg)) cdnStatus.problems.push(msg);
  onProblem(cdnStatus.problems.join('　') + '（入力した文字や記録には影響ありません）');
}

async function fetchVerified(src, file) {
  const res = await fetch(src.base + file, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const hex = await sha256Hex(bytes);
  const ok = hex === SHA256[file];
  log('  fetch ' + src.name + ' ' + file + '  ' + Math.round(bytes.length / 1024) + 'KB  sha256 ' + hex.slice(0, 12) + '… ' + (ok ? 'ok' : 'NG'), ok ? 'out' : 'err');
  if (!ok) {
    reportProblem(src.name, '漢字変換のプログラム');
    const err = new Error('integrity');
    err.integrity = true;
    throw err;
  }
  return bytes;
}

// 辞書は kuromoji 自身が XMLHttpRequest で読む。kuromoji が受け取る前に、ここで 1 ファイルずつ確かめる。
function guardDictionaryRequests() {
  if (guarded) return;
  guarded = true;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    // kuromoji は辞書の場所をつなぐときに「https://」を「https:/」にしてしまうので、元に戻す
    if (typeof url === 'string') url = url.replace(/^(https?:)\/(?!\/)/, '$1//');
    // 辞書のファイルを使う前に確かめられるよう、読み込み先を覚えておく
    this.__ctpUrl = typeof url === 'string' ? url : '';
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const hit = fileFromUrl(this.__ctpUrl || '');
    if (hit) {
      const xhr = this;
      const onload = xhr.onload;
      const onerror = xhr.onerror;
      const fail = (err) => { if (typeof onerror === 'function') onerror.call(xhr, err); };
      xhr.onload = function (ev) {
        // HTTP のエラーは kuromoji が自分で扱う
        if (xhr.status > 0 && xhr.status !== 200) { if (typeof onload === 'function') onload.call(xhr, ev); return; }
        const expected = Object.prototype.hasOwnProperty.call(SHA256, hit.file) ? SHA256[hit.file] : null;
        const data = xhr.response instanceof ArrayBuffer ? new Uint8Array(xhr.response) : null;
        if (!expected || !data) { reportProblem(hit.src.name, '漢字変換の辞書'); fail(new Error('integrity')); return; }
        sha256Hex(data).then((hex) => {
          const ok = hex === expected;
          log('  dict ' + hit.file.replace('dict/', '') + '  ' + Math.round(data.length / 1024) + 'KB  sha256 ' + hex.slice(0, 12) + '… ' + (ok ? 'ok' : 'NG'), ok ? 'out' : 'err');
          if (ok) { verifiedDict.add(hit.file); if (typeof onload === 'function') onload.call(xhr, ev); }
          else { reportProblem(hit.src.name, '漢字変換の辞書'); fail(new Error('integrity')); }
        }, () => fail(new Error('integrity')));
      };
    }
    return origSend.apply(this, args);
  };
}

// 確かめたプログラムを、このページの中の一時的な場所（blob:）から動かす
function runScript(bytes) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
    const node = document.createElement('script');
    const done = (ok) => { URL.revokeObjectURL(url); if (!ok) node.remove(); resolve(ok && typeof window.kuromoji !== 'undefined'); };
    node.onload = () => done(true);
    node.onerror = () => done(false);
    node.src = url;
    document.head.appendChild(node);
  });
}

function ensureScript() {
  if (typeof window.kuromoji !== 'undefined') return Promise.resolve(true);
  if (!scriptPromise) {
    scriptPromise = (async () => {
      if (!(window.crypto && crypto.subtle)) {
        log('  ✗ この画面では読み込むファイルの内容を確認できません（https か localhost で開いてください）', 'err');
        cdnStatus.kuromoji = 'unreachable';
        scriptPromise = null;
        return false;
      }
      for (const src of SOURCES) {
        let bytes;
        try { bytes = await fetchVerified(src, 'build/kuromoji.js'); } catch { continue; }
        if (await runScript(bytes)) {
          log('  kuromoji を起動し、辞書（12 ファイル）を確認しながら読み込みます', 'out');
          cdnStatus.kuromoji = 'ok';
          return true;
        }
        // 中身は合っているのに動かない（ページの制限など）：ほかの配布元も同じファイルなので、試しても変わらない
        log('  ✗ kuromoji を起動できませんでした', 'err');
        break;
      }
      cdnStatus.kuromoji = cdnStatus.problems.length ? 'blocked' : 'unreachable';
      scriptPromise = null;
      return false;
    })();
  }
  return scriptPromise;
}

/** tokenizer を用意する（初回だけ数秒かかる）。使えなければ null。 */
export async function getKuromojiTokenizer() {
  if (tokenizer) return tokenizer;
  // 改ざん（中身の不一致）を見つけたら、ページを開き直すまで取りにいかない（変換のたびに約 17MB を取り直さない）
  if (tampered) return null;
  if (loading) return loading;
  guardDictionaryRequests();
  if (!(await ensureScript()) || typeof window.kuromoji === 'undefined') return null;
  if (loading) return loading;
  const dicUrls = SOURCES.map((src) => src.base + 'dict/');
  const tryBuild = (idx) => {
    if (idx >= dicUrls.length) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const next = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(tryBuild(idx + 1)); };
      // 返事をしなくなった配布元のせいで、変換がいつまでも待たされないようにする
      const timer = setTimeout(next, 120000);
      verifiedDict.clear();
      try {
        window.kuromoji.builder({ dicPath: dicUrls[idx] }).build((err, tok) => {
          if (settled) return;
          if (err || !tok) { next(); return; }
          // 念のため：12 ファイルすべてを確かめられたときだけ使う（確かめをすり抜けた辞書は使わない）
          if (!DICT_FILES.every((f) => verifiedDict.has(f))) {
            log('  ✗ 辞書の内容を確認できなかったため使用しません', 'err');
            cdnStatus.kuromoji = 'blocked';
            settled = true;
            clearTimeout(timer);
            resolve(null);
            return;
          }
          settled = true;
          clearTimeout(timer);
          tokenizer = tok;
          resolve(tok);
        });
      } catch { next(); }
    });
  };
  loading = tryBuild(0).then((tok) => { if (!tok) loading = null; return tok; });
  return loading;
}

/** 外部の辞書に異常があったか（知らせの文を変える）。 */
export const kuromojiHadProblem = () => cdnStatus.problems.length > 0;
