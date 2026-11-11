// three に入っている Draco の展開器（WASM）を public/draco/ にコピーする（keyboard.glb を読むのに要る）。
// npm run dev / build の前に自動で動く（package.json の predev・prebuild）。public/draco/ は git に入れない。
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(WEB, 'node_modules/three/examples/jsm/libs/draco/gltf');
const to = resolve(WEB, 'public/draco');
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log('draco → public/draco/');
