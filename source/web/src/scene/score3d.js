// 結果の画面で回る、立体の文字（練習のランク S・A など、シャトルランの到達レベル）。
// 文字を画面と同じ字体で描き、その輪郭をなぞって厚みを付ける（字体のファイルは要らない）。
// 出てくるときに回りながら近づき、そのあとは正面を向いてゆっくりゆれ、数秒ごとに 1 回転する。
// 動きを減らす設定のときは、正面で止まったまま。描けない環境では、呼び出し側が数字の文字を出す。
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const FONT_PX = 220;
const LEVEL = 0.5;          // 輪郭とみなす濃さ

// ---------- 文字 → 輪郭 ----------

/** 文字を描いた絵の濃さ（0〜1）。 */
function rasterize(text, font) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d', { willReadFrequently: true });
  g.font = font;
  const m = g.measureText(text);
  const pad = 8;
  const asc = Math.ceil(m.actualBoundingBoxAscent || FONT_PX * 0.8), desc = Math.ceil(m.actualBoundingBoxDescent || FONT_PX * 0.2);
  c.width = Math.ceil(m.width) + pad * 2;
  c.height = asc + desc + pad * 2;
  g.font = font;
  g.fillStyle = '#fff';
  g.textBaseline = 'alphabetic';
  g.fillText(text, pad, pad + asc);
  const { data } = g.getImageData(0, 0, c.width, c.height);
  const a = new Float32Array(c.width * c.height);
  for (let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3] / 255;
  return { a, w: c.width, h: c.height };
}

/** 濃さの格子から、閉じた輪郭（点の並び）を取り出す（マーチングスクエア。濃さで線の位置を補う）。 */
function contours({ a, w, h }) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : a[y * w + x]);
  const pts = new Map();                     // 辺の番号 → 点
  const links = new Map();                   // 辺の番号 → つながる辺の番号
  const lerpT = (va, vb) => (vb === va ? 0.5 : (LEVEL - va) / (vb - va));
  const edge = (kind, x, y) => {
    // kind：'T' 上・'B' 下・'L' 左・'R' 右（このセルから見て）
    if (kind === 'T') return ((y + 1) * (w + 2) + (x + 1)) * 2;
    if (kind === 'B') return ((y + 2) * (w + 2) + (x + 1)) * 2;
    if (kind === 'L') return ((y + 1) * (w + 2) + (x + 1)) * 2 + 1;
    return ((y + 1) * (w + 2) + (x + 2)) * 2 + 1;
  };
  const point = (kind, x, y, tl, tr, br, bl) => {
    const id = edge(kind, x, y);
    if (!pts.has(id)) {
      if (kind === 'T') pts.set(id, [x + lerpT(tl, tr), y]);
      else if (kind === 'B') pts.set(id, [x + lerpT(bl, br), y + 1]);
      else if (kind === 'L') pts.set(id, [x, y + lerpT(tl, bl)]);
      else pts.set(id, [x + 1, y + lerpT(tr, br)]);
    }
    return id;
  };
  const link = (p, q) => {
    if (!links.has(p)) links.set(p, []);
    if (!links.has(q)) links.set(q, []);
    links.get(p).push(q);
    links.get(q).push(p);
  };
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const tl = at(x, y), tr = at(x + 1, y), br = at(x + 1, y + 1), bl = at(x, y + 1);
      const k = (tl >= LEVEL ? 8 : 0) | (tr >= LEVEL ? 4 : 0) | (br >= LEVEL ? 2 : 0) | (bl >= LEVEL ? 1 : 0);
      if (k === 0 || k === 15) continue;
      const P = (kind) => point(kind, x, y, tl, tr, br, bl);
      const center = (tl + tr + br + bl) / 4 >= LEVEL;
      const segs = {
        1: [['L', 'B']], 2: [['B', 'R']], 3: [['L', 'R']], 4: [['T', 'R']],
        5: center ? [['T', 'L'], ['B', 'R']] : [['T', 'R'], ['L', 'B']],
        6: [['T', 'B']], 7: [['L', 'T']], 8: [['L', 'T']], 9: [['T', 'B']],
        10: center ? [['T', 'R'], ['L', 'B']] : [['L', 'T'], ['B', 'R']],
        11: [['T', 'R']], 12: [['L', 'R']], 13: [['B', 'R']], 14: [['L', 'B']],
      }[k];
      for (const [p, q] of segs) link(P(p), P(q));
    }
  }
  // つながりをたどって、閉じた輪にする
  const loops = [];
  const used = new Set();
  for (const start of links.keys()) {
    if (used.has(start)) continue;
    const loop = [];
    let prev = -1, cur = start;
    while (cur !== undefined && !used.has(cur)) {
      used.add(cur);
      loop.push(pts.get(cur));
      const next = links.get(cur).find((n) => n !== prev && !used.has(n));
      prev = cur;
      cur = next;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

/** ほぼまっすぐに並んだ点を省く（ダグラス・ポーカー）。 */
function simplify(loop, eps) {
  const keep = new Uint8Array(loop.length);
  const stack = [[0, loop.length - 1]];
  keep[0] = keep[loop.length - 1] = 1;
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, ay] = loop[i], [bx, by] = loop[j];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let far = -1, d = 0;
    for (let k = i + 1; k < j; k++) {
      const dist = Math.abs((bx - ax) * (ay - loop[k][1]) - (ax - loop[k][0]) * (by - ay)) / len;
      if (dist > d) { d = dist; far = k; }
    }
    if (far >= 0 && d > eps) { keep[far] = 1; stack.push([i, far], [far, j]); }
  }
  return loop.filter((_, k) => keep[k]);
}

const inside = (pt, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

/** 文字 → 厚みのある形（中心が原点・高さ 1 くらい）。 */
function textGeometry(text, font) {
  const r = rasterize(text, font);
  const loops = contours(r).map((l) => simplify(l, 0.35));
  // 何重に囲まれているかで、外側の形と穴を分ける（偶数：形、奇数：穴）
  const depth = loops.map((l, i) => loops.reduce((n, o, j) => n + (j !== i && inside(l[0], o) ? 1 : 0), 0));
  const S = 1 / FONT_PX;
  const toV = ([x, y]) => new THREE.Vector2(x * S, -y * S);
  const shapes = [];
  const owner = new Map();
  loops.forEach((l, i) => { if (depth[i] % 2 === 0) { const sh = new THREE.Shape(l.map(toV)); shapes.push(sh); owner.set(i, sh); } });
  loops.forEach((l, i) => {
    if (depth[i] % 2 === 0) return;
    // 自分を囲む形のうち、いちばん内側（深さが 1 つ浅い）のもの
    const parent = loops.findIndex((o, j) => j !== i && depth[j] === depth[i] - 1 && inside(l[0], o));
    if (parent >= 0 && owner.has(parent)) owner.get(parent).holes.push(new THREE.Path(l.map(toV)));
  });
  const geo = new THREE.ExtrudeGeometry(shapes, { depth: 0.2, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.022, bevelSegments: 4, curveSegments: 4 });
  geo.center();
  geo.computeVertexNormals();
  return geo;
}

// ---------- 光の絵 ----------

const canvasTex = (draw, size = 512) => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
};

/** 後ろから放射状に伸びる光の筋。 */
const raysTexture = () => canvasTex((g, N) => {
  const cx = N / 2;
  let seed = 3;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  g.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 28; k++) {
    const a = (k / 28) * Math.PI * 2 + rnd() * 0.12, w = 0.025 + rnd() * 0.06, len = cx * (0.55 + rnd() * 0.45);
    const grad = g.createRadialGradient(cx, cx, 0, cx, cx, len);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(cx, cx);
    g.arc(cx, cx, len, a - w, a + w);
    g.closePath();
    g.fill();
  }
});

/** 丸いにじみ（中心が明るい）。 */
const glowTexture = () => canvasTex((g, N) => {
  const grad = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, N, N);
}, 128);

/** 文字の形のにじみ（文字のまわりから光が漏れて見える）。 */
function glyphGlowTexture(text, font) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = font;
  const m = g.measureText(text);
  const pad = 90;
  const asc = Math.ceil(m.actualBoundingBoxAscent || FONT_PX * 0.8), desc = Math.ceil(m.actualBoundingBoxDescent || FONT_PX * 0.2);
  c.width = Math.ceil(m.width) + pad * 2;
  c.height = asc + desc + pad * 2;
  g.font = font;
  g.fillStyle = '#fff';
  g.textBaseline = 'alphabetic';
  for (const [blur, alpha] of [[70, 0.9], [34, 0.8], [14, 0.7]]) {
    g.shadowColor = `rgba(255,255,255,${alpha})`;
    g.shadowBlur = blur;
    g.fillText(text, pad, pad + asc);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  // 立体の文字は、字の形（インク）の中心が原点。にじみの絵も、字の形の中心に合わせる
  const inkL = pad - (m.actualBoundingBoxLeft || 0), inkR = pad + (m.actualBoundingBoxRight || m.width);
  const dx = (c.width / 2 - (inkL + inkR) / 2) / FONT_PX;
  const dy = -(c.height / 2 - (pad + (asc + desc) / 2)) / FONT_PX;
  return { tex: t, w: c.width / FONT_PX, h: c.height / FONT_PX, dx, dy };
}

/** デフォルメした王冠：まっすぐな線だけの 1 つの形（3 つの山）。玉・宝石などの飾りは付けない。高さ 1 くらい。 */
function makeCrown() {
  // 正面から強い光が当たるので、色は濃いめにして、白く飛ばないようにする
  const gold = new THREE.MeshStandardMaterial({ color: '#c9a000', metalness: 0.3, roughness: 0.45 });
  // 太い山を 3 つ。まん中を少し高くする
  const pts = [[-0.62, 0], [0.62, 0], [0.62, 0.78], [0.31, 0.42], [0, 0.9], [-0.31, 0.42], [-0.62, 0.78]];
  const sh = new THREE.Shape();
  pts.forEach(([x, y], i) => (i ? sh.lineTo(x, y) : sh.moveTo(x, y)));
  sh.closePath();
  // 縁は、丸めずに 1 段の面取り（平らな面）だけ
  const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.2, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.035, bevelSegments: 1 });
  geo.translate(0, 0, -0.1);
  const crown = new THREE.Group();
  crown.add(new THREE.Mesh(geo, gold));
  return crown;
}

// ---------- 描く ----------

let shared = null;   // 描く道具は 1 つだけ作り、結果の画面のたびに使い回す

function setup() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;   // ランクの色を、そのままあざやかに出す
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.7;
  const key = new THREE.DirectionalLight('#fff4e8', 2.0);
  key.position.set(-1.5, 2, 3);
  // 正面と上下からも光を当てて、文字の側面が暗く（縁取りのように）ならないようにする
  const front = new THREE.DirectionalLight('#ffffff', 1.2);
  front.position.set(0, 0, 5);
  const sky = new THREE.HemisphereLight('#ffffff', '#ffffff', 1.4);
  scene.add(key, front, sky);
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 50);
  // 文字：表も側面も同じ色で、内側から光っているように（縁取りに見えないように、側面を暗くしない）
  const letter = new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 0.1, roughness: 0.35, emissive: '#ffffff', emissiveIntensity: 0.75 });
  const add = (map, opacity) => new THREE.MeshBasicMaterial({ map, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const rays = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), add(raysTexture(), 0.75));
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), add(glowTexture(), 0.55));
  const glyphGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), add(null, 1));
  rays.renderOrder = 0; halo.renderOrder = 1; glyphGlow.renderOrder = 3;
  // こぼれ出る光の粒
  const N = 36;
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ map: glowTexture(), size: 0.09, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  const seeds = Array.from({ length: N }, () => ({ a: Math.random() * Math.PI * 2, sp: 0.25 + Math.random() * 0.5, ph: Math.random() }));
  const back = new THREE.Group();   // 文字の後ろの光（回転しない）
  back.add(rays, halo, sparks);
  back.position.z = -0.3;
  scene.add(back);
  const pivot = new THREE.Group();
  scene.add(pivot);
  return { renderer, scene, camera, letter, rays, halo, glyphGlow, sparks, seeds, back, pivot, mesh: null, crown: null, raf: 0, host: null };
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * 立体の文字を host の中に出して回す。描けなければ false を返す（呼び出し側が、ふつうの文字を出す）。
 * @param {HTMLElement} host
 * @param {{text: string, color: string, crown?: boolean, reducedMotion?: boolean, low?: boolean}} o crown：王冠をのせる（S 以上）。low：軽い表示（30 コマ/秒・解像度 1 倍）
 */
export function showText3d(host, o) {
  try {
    if (!shared) shared = setup();
  } catch { return false; }
  const s = shared;
  cancelAnimationFrame(s.raf);
  clearTimeout(s.idle);
  if (s.mesh) { s.pivot.remove(s.mesh); s.mesh.geometry.dispose(); s.mesh = null; }
  if (s.crown) {
    s.pivot.remove(s.crown);
    s.crown.traverse((n) => { if (n.isMesh) { n.geometry.dispose(); n.material.dispose(); } });
    s.crown = null;
  }
  s.pivot.remove(s.glyphGlow);
  const font = `800 ${FONT_PX}px Sora, "Zen Kaku Gothic New", system-ui, sans-serif`;
  const text = String(o.text || '');
  let geo;
  try { geo = textGeometry(text, font); } catch { return false; }
  const color = new THREE.Color(o.color || '#4a8dff');
  s.letter.color.copy(color);
  s.letter.emissive.copy(color).multiplyScalar(0.55);
  s.mesh = new THREE.Mesh(geo, s.letter);
  s.pivot.add(s.mesh);
  // 文字のまわりのにじみ（文字の少し後ろ。文字と一緒に回る）
  const gg = glyphGlowTexture(text, font);
  if (s.glyphGlow.material.map) s.glyphGlow.material.map.dispose();
  s.glyphGlow.material.map = gg.tex;
  s.glyphGlow.material.color.copy(color).lerp(new THREE.Color('#ffffff'), 0.35);
  s.glyphGlow.material.needsUpdate = true;
  s.glyphGlow.scale.set(gg.w, gg.h, 1);
  s.glyphGlow.position.set(gg.dx, gg.dy, -0.12);
  s.pivot.add(s.glyphGlow);
  for (const m of [s.rays, s.halo, s.sparks]) m.material.color.copy(color).lerp(new THREE.Color('#ffffff'), 0.3);
  geo.computeBoundingBox();
  const size = geo.boundingBox.getSize(new THREE.Vector3());
  const top = geo.boundingBox.max.y;
  if (o.crown) {
    s.crown = makeCrown();
    const k = size.y * 0.5;
    s.crown.scale.setScalar(k);
    s.crown.position.set(-size.x * 0.12, top + k * 0.05, 0.02);
    s.crown.rotation.z = 0.2;
    s.pivot.add(s.crown);
  }
  const R = Math.max(size.x, size.y) * 1.9;
  s.rays.scale.set(R, R, 1);
  s.halo.scale.set(R * 0.75, R * 0.75, 1);
  host.appendChild(s.renderer.domElement);
  s.host = host;

  // 大きさ：文字（と王冠）が枠に収まるように、カメラの距離を決める
  const box = new THREE.Box3().setFromObject(s.mesh);
  if (s.crown) box.union(new THREE.Box3().setFromObject(s.crown));
  const all = box.getSize(new THREE.Vector3());
  const midY = (box.max.y + box.min.y) / 2;
  let fitted = '';
  const fit = () => {
    const w = host.clientWidth, h = host.clientHeight;
    if (w < 10 || h < 10) return false;          // まだ大きさが決まっていない（出た直後）
    if (fitted === w + 'x' + h) return true;
    fitted = w + 'x' + h;
    s.renderer.setSize(w, h, false);
    s.camera.aspect = w / h;
    const tan = Math.tan((s.camera.fov * Math.PI) / 360);
    // 回っても枠からはみ出さないように、少し余白をとる
    const dist = Math.max((all.x * 0.64) / (tan * s.camera.aspect), (all.y * 0.62) / tan) + all.x * 0.3;
    s.camera.position.set(0, midY, dist);
    s.camera.lookAt(0, midY, 0);
    s.camera.updateProjectionMatrix();
    s.back.position.y = midY - (o.crown ? all.y * 0.08 : 0);
    return true;
  };

  s.renderer.setPixelRatio(o.low ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
  const gap = (o.low ? 1 / 30 : 1 / 60) * 1000 - 4;   // リフレッシュレートが高い画面でも、これより細かくは描かない
  let last = -1e9;
  const t0 = performance.now();
  const INTRO = 1.3, PERIOD = 6.5, SPIN = 1.4;
  const pos = s.sparks.geometry.attributes.position;
  const frame = (now) => {
    if (!host.isConnected || s.host !== host) return;     // 画面が変わったら止める
    // 見えていない（ほかのタブにいる）ときと、前に描いてから間がないときは描かない
    if (host.offsetParent === null) {   // 見えていない（ほかのタブにいる）：毎コマではなく 0.5 秒ごとに確かめる
      s.raf = 0;
      clearTimeout(s.idle);
      s.idle = setTimeout(() => { if (s.host === host) s.raf = requestAnimationFrame(frame); }, 500);
      return;
    }
    if (now - last < gap) { s.raf = requestAnimationFrame(frame); return; }
    if (!fit()) { s.raf = requestAnimationFrame(frame); return; }   // 枠の大きさが決まるまで待つ（幅が変わったら合わせ直す）
    last = now;
    const t = (now - t0) / 1000;
    let ry = 0, scale = 1, y = 0, rx = 0, burst = 1;
    if (!o.reducedMotion) {
      if (t < INTRO) {
        const k = easeOut(t / INTRO);
        ry = (1 - k) * -Math.PI * 2.2;
        scale = 0.55 + 0.45 * k;
        y = (1 - k) * -0.25;
        burst = k;
      } else {
        const u = (t - INTRO) % PERIOD;
        const hold = PERIOD - SPIN;
        ry = u < hold ? Math.sin((u / hold) * Math.PI * 2) * 0.16 : easeInOut((u - hold) / SPIN) * Math.PI * 2;
        y = Math.sin(t * 1.2) * 0.02;
        rx = Math.sin(t * 0.8) * 0.05;
      }
    }
    s.pivot.rotation.set(rx, ry, 0);
    s.pivot.scale.setScalar(scale);
    s.pivot.position.y = y;
    // 後ろの光：筋がゆっくり回り、明るさが息をするように変わる。出てきた瞬間は強く光る
    const pulse = o.reducedMotion ? 1 : 0.85 + 0.15 * Math.sin(t * 2.1);
    const flash = o.reducedMotion ? 0 : Math.max(0, 1 - Math.abs(t - INTRO * 0.85) * 2.2);
    s.rays.rotation.z = o.reducedMotion ? 0 : t * 0.18;
    s.rays.material.opacity = (0.55 + flash * 0.6) * pulse * burst;
    s.halo.material.opacity = (0.45 + flash * 0.5) * pulse * burst;
    s.glyphGlow.material.opacity = (0.9 + flash * 0.4) * pulse;
    s.letter.emissiveIntensity = 0.55 + flash * 0.9 + 0.12 * Math.sin(t * 2.1);
    // 光の粒：中心からこぼれ出て、外へ向かって消えていく
    const R = s.rays.scale.x * 0.5;
    s.seeds.forEach((d, i) => {
      const life = o.reducedMotion ? d.ph : (t * d.sp * 0.35 + d.ph) % 1;
      const r = R * (0.15 + life * 0.85);
      pos.setXYZ(i, Math.cos(d.a) * r, Math.sin(d.a) * r * 0.7, 0.05);
    });
    pos.needsUpdate = true;
    s.sparks.material.opacity = 0.8 * burst;
    s.renderer.render(s.scene, s.camera);
    s.raf = o.reducedMotion && t > 0.1 ? 0 : requestAnimationFrame(frame);
  };
  s.raf = requestAnimationFrame(frame);
  return true;
}
