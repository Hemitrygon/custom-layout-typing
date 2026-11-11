// 対応表（src/keyboard_keys.js）の名前が、3D キーボード（public/models/keyboard.glb）の中にすべてあるか確かめる。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MODEL_KEY_BY_CODE } from '../src/keyboard_keys.js';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const glb = readFileSync(resolve(WEB, 'public/models/keyboard.glb'));
const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
const names = new Set(json.nodes.map(n => n.name));
const missing = Object.entries(MODEL_KEY_BY_CODE).filter(([, n]) => n !== null && !names.has(n));
const unmapped = [...names].filter(n => /^Key_/.test(n) && !Object.values(MODEL_KEY_BY_CODE).includes(n));
if (missing.length) { console.log('FAIL 3D にないキー：' + missing.map(m => m.join('→')).join(' ')); process.exit(1); }
console.log('ok   3D のキーの対応表：' + Object.values(MODEL_KEY_BY_CODE).filter(Boolean).length + ' 個すべてある' + (unmapped.length ? '（対応表にない 3D のキー：' + unmapped.join(' ') + '）' : ''));
