// 壊れた入力で Rust（WASM）が止まらないかの確かめ（ファジング）。
// WASM の口をすべて、壊れた JSON・変な数・巨大な値・__proto__ などで何千回も呼び、
// Rust のパニック（WebAssembly の RuntimeError：unreachable など）が起きないことを確かめる。
// 正しい答えかどうかは見ない（それは api_test と正解データの仕事）。JS 側の型の誤り（TypeError など）は数えない。
//     node fuzz_test.mjs [回数=4000] [種=1]      （web/ の中で。先に core/ で wasm-pack build が要る）
// 失敗したら、関数の名前と入力を出して止まる（同じ種で再現できる）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '../core/pkg');
const ROUNDS = Number(process.argv[2] || 4000);
let seed = Number(process.argv[3] || 1) >>> 0;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

async function load() {
  const m = await import(resolve(PKG, 'typing_core.js') + '?' + Math.random());
  await m.default({ module_or_path: readFileSync(resolve(PKG, 'typing_core_bg.wasm')) });
  return m;
}
let w = await load();

// ---------- 入力の材料 ----------
const WEIRD_STR = ['', ' ', 'null', 'true', '0', '-1', '[]', '{}', '"x"', '[[[[[[[[[[]]]]]]]]]]', '{"__proto__":{"a":1}}', '{"constructor":{"prototype":{}}}',
  '\u0000', '\ud800', '😀👍🏽', 'あいうえおかきくけこ', 'ｱｲｳ', 'ー', 'ん', 'っ', 'n', 'nn', 'x'.repeat(5000), '{"a":' + '1'.repeat(400) + '}',
  'jis', 'us', 'nihon', 'hepburn', 'ja', 'en', 'Space', 'KeyA', 'ShiftLeft', 'Digit1+Shift', '@shift', 'oonishi', 'qwerty', 'custom1', '1e309', 'NaN', '-0'];
const WEIRD_NUM = [0, -0, 1, -1, 0.5, 1e9, -1e9, 1e308, -1e308, NaN, Infinity, -Infinity, 2 ** 32, 2 ** 53, 4294967295, 0.1 + 0.2, Date.now()];
const WEIRD_VAL = [null, true, false, 0, -1, 1e308, -1e308, '', 'x', [], {}, [null], [[]], { '': null }, { __proto__: null }, '😀', 'ー'.repeat(300)];
const pool = [];   // 呼んだ結果の JSON（正しい形の入力の種）

function mutate(v, depth = 0) {
  if (depth > 6) return pick(WEIRD_VAL);
  const r = rnd();
  if (r < 0.12) return pick(WEIRD_VAL);
  if (Array.isArray(v)) {
    const a = v.map((x) => (rnd() < 0.25 ? mutate(x, depth + 1) : x));
    if (rnd() < 0.1) a.push(pick(WEIRD_VAL));
    if (rnd() < 0.1) a.splice(Math.floor(rnd() * a.length), 1);
    return a;
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (rnd() < 0.06) continue;                       // 項目を抜く
      o[k] = rnd() < 0.25 ? mutate(x, depth + 1) : x;
    }
    if (rnd() < 0.08) o[pick(['__proto__', 'constructor', 'toString', '', 'x', '0'])] = pick(WEIRD_VAL);
    return o;
  }
  if (typeof v === 'string') return rnd() < 0.5 ? pick(WEIRD_STR) : v + pick(WEIRD_STR).slice(0, 20);
  if (typeof v === 'number') return pick(WEIRD_NUM);
  return pick(WEIRD_VAL);
}

function argStr() {
  const r = rnd();
  if (pool.length && r < 0.55) {
    const base = pick(pool);
    if (rnd() < 0.2) return JSON.stringify(base);
    const out = JSON.stringify(mutate(base));
    if (rnd() < 0.05) return out.slice(0, Math.floor(rnd() * out.length));   // 途中で切れた JSON
    return out;
  }
  if (r < 0.8) return pick(WEIRD_STR);
  return JSON.stringify(pick(WEIRD_VAL));
}
const argAny = () => { const r = rnd(); return r < 0.6 ? argStr() : r < 0.85 ? pick(WEIRD_NUM) : r < 0.92 ? undefined : pick([true, false]); };

function remember(out) {
  if (typeof out !== 'string' || out.length > 20000) return;
  try { const v = JSON.parse(out); if (v && typeof v === 'object' && pool.length < 400) pool.push(v); } catch { /* JSON でない */ }
}

// ---------- 引数の型（typing_core.d.ts から読む）----------
// 型どおりの値を渡す（文字列の口に数を渡すと、wasm-bindgen の受け渡しの部分が壊れるが、それは JS の呼び方の誤りで、画面はしない）
const DTS = readFileSync(resolve(PKG, 'typing_core.d.ts'), 'utf8');
const parseParams = (list) => (list.trim() ? list.split(/,\s*(?![^()]*\))/).map((p) => p.replace(/^[\w$]+\??:\s*/, '').trim()) : []);
const SIG = { fn: {}, cls: {} };
{
  let cur = null;
  for (const line of DTS.split('\n')) {
    let m;
    if ((m = line.match(/^export function (\w+)\((.*)\):/))) SIG.fn[m[1]] = parseParams(m[2]);
    else if ((m = line.match(/^export class (\w+)/))) { cur = { ctor: [], methods: {} }; SIG.cls[m[1]] = cur; }
    else if (cur && (m = line.match(/^\s+constructor\((.*)\);/))) cur.ctor = parseParams(m[1]);
    else if (cur && (m = line.match(/^\s+(\w+)\((.*)\):/))) cur.methods[m[1]] = parseParams(m[2]);
    else if (/^}/.test(line)) cur = null;
  }
}
function argOf(type) {
  const opt = /null|undefined/.test(type) && rnd() < 0.15;
  if (opt) return rnd() < 0.5 ? null : undefined;
  if (/string/.test(type)) return argStr();
  if (/number/.test(type)) return rnd() < 0.7 ? pick(WEIRD_NUM) : Math.floor(rnd() * 200) - 20;
  if (/boolean/.test(type)) return rnd() < 0.5;
  // any：形態素解析のオブジェクト（tokenizeJson が変な文字列を返す。例外は投げない：画面の包みが例外を止めるため）
  return { tokenizeJson: () => argStr() };
}
const argsFor = (types) => (types ? types.map(argOf) : [argAny()]);

// ---------- 呼ぶ ----------
const fns = Object.entries(w).filter(([n, f]) => typeof f === 'function' && n !== 'default' && n !== 'initSync' && !/^[A-Z]/.test(n));
const classes = Object.entries(w).filter(([n, f]) => typeof f === 'function' && /^[A-Z]/.test(n));

const isPanic = (e) => e instanceof WebAssembly.RuntimeError || /unreachable|RuntimeError|recursive use|already borrowed|memory access out of bounds/i.test(String(e && (e.message || e)));
// 正しい形の種をいくつか入れておく（組み込みの配列・キーボードの行など）
for (const [n, f] of fns) {
  for (const args of [['oonishi', 'jis'], ['qwerty', 'us'], ['jis'], ['us'], []]) {
    if (SIG.fn[n] && SIG.fn[n].length !== args.length) continue;
    try { remember(f(...args)); } catch (e) { if (isPanic(e)) { console.log('✗ パニック（種を作る途中）：' + n + ' ' + JSON.stringify(args)); process.exit(1); } }
  }
}

let calls = 0, panics = 0;
function fail(what, args, e) {
  panics++;
  console.log('✗ パニック：' + what);
  console.log('  入力：' + JSON.stringify(args).slice(0, 600));
  console.log('  ' + String(e && (e.stack || e)).split('\n').slice(0, 3).join('\n  '));
}

for (let round = 0; round < ROUNDS && panics === 0; round++) {
  // 関数
  const [name, f] = pick(fns);
  const args = argsFor(SIG.fn[name]);
  try { calls++; remember(f(...args)); } catch (e) { if (isPanic(e)) { fail(name, args, e); break; } }

  // クラス：作って、メソッドをいくつか呼んで、解放する
  if (rnd() < 0.35) {
    const [cname, C] = pick(classes);
    const csig = SIG.cls[cname] || { ctor: null, methods: {} };
    const cargs = argsFor(csig.ctor);
    let obj = null;
    try { calls++; obj = new C(...cargs); } catch (e) { if (isPanic(e)) { fail('new ' + cname, cargs, e); break; } }
    if (obj) {
      const methods = Object.getOwnPropertyNames(C.prototype).filter((m) => m !== 'constructor' && m !== 'free' && typeof obj[m] === 'function');
      for (let k = 0; k < 12 && methods.length; k++) {
        const m = pick(methods);
        const margs = argsFor(csig.methods[m]);
        try { calls++; remember(obj[m](...margs)); } catch (e) { if (isPanic(e)) { fail(cname + '.' + m, { ctor: cargs, args: margs }, e); break; } }
      }
      try { obj.free(); } catch { /* 解放済み */ }
    }
  }
}

if (panics) { console.log('== 失敗（種 ' + process.argv[3] + '）'); process.exit(1); }
console.log('ok   WASM の口 ' + fns.length + ' 個・クラス ' + classes.length + ' 個を ' + calls + ' 回呼んで、パニックなし（種 ' + (process.argv[3] || 1) + '）');
