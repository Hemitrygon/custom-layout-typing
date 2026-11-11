// 3D の舞台：机の上のキーボード 1 台。画面のキーボードガイドも兼ねる。
//   - キーの刻印は、選んでいる配列の文字を描き直す（元の刻印の形は隠す）
//   - 押したキーが沈み、指の色で光る。次に押すキーは静かに灯る
//   - 画面（タブ・練習の状態）ごとにカメラの位置と光の色（ムード）が変わる
//   - HTML 側が決めた枠（slot）にキーボードが収まるように、カメラの距離と中心を合わせる
//   - テーマ（ダーク・ライト）で、光と机の色が変わる
//   - 練習中以外は、カメラが大きくゆっくり回り込み、寄ったり引いたりする（練習中は止める）
//   - 運指の色分けは、刻印の文字とキーの面の両方に付ける
// 材質は glTF の色を使わず、ここで付け直している。
// 写真らしく見せる工夫（「軽い表示」では省く）：Blender と同じ AgX の色の出し方、環境光の遮り（GTAO）でキーの間の暗がり、
// 被写界深度（奥と手前のぼけ）、フィルムの粒子・周辺減光・周辺の色ずれ、PBT のざらつきと梨地のアルミ、やわらかい影。
// 軽くするための工夫：動きがないコマは描かない。カメラのゆらぎだけのときは 30 コマ/秒（奥にさがってぼけているときは 20 コマ/秒）にし、
// 画面のリフレッシュレートが高くても 60 コマ/秒を超えない。影はキーが動いたときだけ描き直す。
// ほかのタブ（CSS でぼかしている）では、GTAO と被写界深度を省き、解像度を下げる（ぼけているので見た目は変わらない）。
// 「軽い表示」：影・GTAO・ぼけ・ブルーム・フィルムを省き、カメラのゆらぎも止めて、動きがあるときだけ描く。
// チカチカしないように：動きはどれもゆっくりにし、カメラは練習中は止め、次のキーは点滅させず、打鍵の光は控えめにし、光のにじみ（ブルーム）は強い光にだけ効かせる。
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { MODEL_KEY_BY_CODE } from '../keyboard_keys.js';
import { FINGERS, ACCENT, DANGER, shade } from '../theme.js';

const DEG = Math.PI / 180;
const KEY_TRAVEL = 0.0032;          // キーが沈む深さ（m）
const LEGEND_CELL = 128;            // 刻印の絵 1 つの大きさ（px）
const LEGEND_COLS = 8;

// ---------- カメラの位置（ポーズ） ----------
// elev：水平からの角度、azim：正面からの回り込み、fill：枠の幅に対するキーボードの幅、fov：画角、drift：ゆらぎの大きさ、dof：ぼけの強さ
const POSES = {
  home:    { elev: 40, azim: -16, fill: 0.86, fov: 30, drift: 1.2, roll: 0, dof: 1 },
  typing:  { elev: 61, azim: 0, fill: 1.0, fov: 26, drift: 0, roll: 0, dof: 0.25 },
  result:  { elev: 30, azim: 24, fill: 0.84, fov: 30, drift: 1.6, roll: 0, dof: 1 },
  words:   { elev: 22, azim: 38, fill: 1.5, fov: 34, drift: 1.0, roll: -2, dof: 1.2 },
  editor:  { elev: 72, azim: -8, fill: 1.25, fov: 28, drift: 0.6, roll: 3, dof: 0.5 },
  history: { elev: 34, azim: -42, fill: 1.35, fov: 32, drift: 1.0, roll: 0, dof: 1.2 },
  shuttle: { elev: 57, azim: 0, fill: 1.0, fov: 26, drift: 0, roll: 0, dof: 0.25 },
  over:    { elev: 26, azim: -20, fill: 0.9, fov: 32, drift: 1.4, roll: 0, dof: 1 },
};

// ---------- 光の色（ムード） ----------
const MOODS_DARK = {
  studio:  { bg: '#0d0e11', desk: '#2b2927', key: '#ffe2c2', keyI: 3.6, rim: '#7fa8ff', rimI: 1.3, env: 0.50, legend: 0.0, back: 0.0, backColor: ACCENT, exposure: 1.0 },
  focus:   { bg: '#0a0b0e', desk: '#252321', key: '#ffe6cc', keyI: 3.2, rim: '#7fa8ff', rimI: 1.0, env: 0.42, legend: 0.05, back: 0.0, backColor: ACCENT, exposure: 1.0 },
  dawn:    { bg: '#15100d', desk: '#33291f', key: '#ffc79a', keyI: 3.2, rim: '#8fb5ff', rimI: 0.9, env: 0.40, legend: 0.0, back: 0.0, backColor: ACCENT, exposure: 1.0 },
  night:   { bg: '#080b12', desk: '#1a2130', key: '#bcd2ff', keyI: 2.2, rim: '#ff9a5c', rimI: 0.9, env: 0.34, legend: 0.12, back: 0.0, backColor: '#6f8cff', exposure: 1.0 },
  day:     { bg: '#17181c', desk: '#3c3e45', key: '#ffffff', keyI: 3.2, rim: '#b9c9ff', rimI: 1.2, env: 0.72, legend: 0.0, back: 0.0, backColor: ACCENT, exposure: 1.05 },
  shuttle: { bg: '#04080b', desk: '#0f1a1f', key: '#9fe9e0', keyI: 0.9, rim: '#2fe0c8', rimI: 1.4, env: 0.16, legend: 0.75, back: 0.55, backColor: '#2fe0c8', exposure: 1.0 },
};
// ライト：明るい部屋の、明るい机。シャトルランは、どちらのテーマでも暗い
const MOODS_LIGHT = {
  studio:  { bg: '#e6e2db', desk: '#d6c6ad', key: '#fff8ee', keyI: 2.6, rim: '#a9c1ff', rimI: 0.6, env: 0.95, legend: 0.0, back: 0.0, backColor: ACCENT, exposure: 1.0 },
  focus:   { bg: '#e2ded7', desk: '#d1c1a8', key: '#fffaf2', keyI: 2.5, rim: '#a9c1ff', rimI: 0.5, env: 0.9, legend: 0.0, back: 0.0, backColor: ACCENT, exposure: 1.0 },
  dawn:    { bg: '#ebe0d2', desk: '#d9c3a3', key: '#ffd8ae', keyI: 2.8, rim: '#a9c1ff', rimI: 0.5, env: 0.85, legend: 0.0, back: 0.0, backColor: ACCENT, exposure: 1.0 },
  night:   { bg: '#dde2ea', desk: '#c6c3bd', key: '#e4ecff', keyI: 2.4, rim: '#ffb07a', rimI: 0.5, env: 0.85, legend: 0.0, back: 0.0, backColor: '#6f8cff', exposure: 1.0 },
  day:     { bg: '#ebe8e3', desk: '#dccdb5', key: '#ffffff', keyI: 2.7, rim: '#b9c9ff', rimI: 0.6, env: 1.0, legend: 0.0, back: 0.0, backColor: ACCENT, exposure: 1.0 },
  shuttle: MOODS_DARK.shuttle,
};

// フィルムの仕上げ：粒子・周辺減光・周辺の色ずれ（OutputPass の後に掛ける）
const FilmLook = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uGrain: { value: 0.035 }, uVignette: { value: 0.32 }, uShift: { value: 0.0016 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime, uGrain, uVignette, uShift; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 d = vUv - 0.5; float r = dot(d, d);
      vec3 c = vec3(texture2D(tDiffuse, vUv + d * uShift * r * 4.0).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - d * uShift * r * 4.0).b);
      c *= 1.0 - uVignette * r * 1.6;
      float n = hash(vUv * vec2(1931.0, 1213.0) + fract(uTime) * 61.0) - 0.5;
      c += n * uGrain * (0.6 + 0.4 * (1.0 - dot(c, vec3(0.333))));
      gl_FragColor = vec4(c, 1.0);
    }`,
};

/** UV のない形に、面の向きに合わせた座標を作る（箱に貼る要領。scale：1m あたりのくり返し）。 */
function boxUv(geo, scale) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  if (!pos || !nor) return;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
    const x = pos.getX(i) * scale, y = pos.getY(i) * scale, z = pos.getZ(i) * scale;
    if (ay >= ax && ay >= az) { uv[i * 2] = x; uv[i * 2 + 1] = z; }
    else if (ax >= az) { uv[i * 2] = z; uv[i * 2 + 1] = y; }
    else { uv[i * 2] = x; uv[i * 2 + 1] = y; }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const addColor = (to, c, s) => { to.r += c.r * s; to.g += c.g * s; to.b += c.b * s; };

export class Stage {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{quality?: 'high'|'low', reducedMotion?: boolean, theme?: 'dark'|'light'}} [opts]
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.reducedMotion = Boolean(opts.reducedMotion);
    this.ready = false;
    this.keys = new Map();          // 物体の名前 → キーの状態
    this.codeToKey = new Map();     // KeyboardEvent.code → キーの状態
    this.legendCodes = [];          // 刻印を描くキー（code の並び＝絵の中の場所）
    this.targets = new Map();       // code → 'key' | 'shift'
    this.heat = new Map();
    this.waves = [];
    this.slot = null;               // キーボードを収める枠（画面の座標）
    this.pose = { ...POSES.home };
    this.poseFrom = { ...POSES.home };
    this.poseTo = { ...POSES.home };
    this.poseT = 1;
    this.poseDur = 1;
    this.slotNow = { cx: 0.5, cy: 0.5, w: 0.6, h: 0.5 };
    this.slotFrom = { ...this.slotNow };
    this.slotTo = { ...this.slotNow };
    this.theme = opts.theme === 'light' ? 'light' : 'dark';
    this.mood = this.#moodOf('studio');
    this.moodFrom = this.mood;
    this.moodTo = this.mood;
    this.moodT = 1;
    this.urgency = 0;               // シャトルラン：0（余裕）〜1（時間切れ寸前）
    this.pointer = { x: 0, y: 0, sx: 0, sy: 0 };
    this.legendOptions = { fingerColors: true, qwertySub: true };
    this.layout = null;
    this.kind = 'jis';
    this.clock = new THREE.Clock();
    this.time = 0;
    this.running = true;
    this.needsRender = true;
    this.keysBusy = false;          // キーの沈み・光が動いている途中か
    this.shadowDirty = true;        // 影を描き直すか（キーが動いたときだけ）
    this.backdrop = false;          // ほかのタブで、CSS のぼかしの奥にあるか
    this.acc = 0;                   // 前に描いてからの時間（秒）

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer = renderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.AgXToneMapping;            // Blender の既定と同じ色の出し方（明るいところが自然に白く飽和する）
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.type = THREE.PCFShadowMap;           // r182 から、PCF はやわらかい影（radius でぼかす）
    renderer.shadowMap.autoUpdate = false;                  // 影はキーが動いたときだけ描き直す（shadowDirty）

    // GPU のない環境（ソフトウェア描画）では軽い設定にする
    let software = false;
    try {
      const gl = renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      software = /swiftshader|llvmpipe|software/i.test(name);
    } catch { /* 分からなければ高い設定のまま */ }
    this.software = software;
    this.quality = opts.quality || (software ? 'low' : 'high');

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.mood.bg);
    this.scene.fog = new THREE.FogExp2(this.mood.bg, 0.55);
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = this.mood.env;
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.02, 20);

    // 光：斜め上からの主光（影を落とす）と、奥からの縁の光
    this.keyLight = new THREE.DirectionalLight(this.mood.key, this.mood.keyI);
    this.keyLight.position.set(-0.35, 0.75, 0.3);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(4096, 4096);
    const sc = this.keyLight.shadow.camera;
    sc.left = -0.28; sc.right = 0.28; sc.top = 0.2; sc.bottom = -0.2; sc.near = 0.2; sc.far = 2;
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.0006;
    this.keyLight.shadow.radius = 9;
    this.scene.add(this.keyLight, this.keyLight.target);
    this.rimLight = new THREE.DirectionalLight(this.mood.rim, this.mood.rimI);
    this.rimLight.position.set(0.5, 0.35, -0.6);
    this.scene.add(this.rimLight);

    // 机：遠くは霧で背景に溶ける
    this.desk = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 8),
      new THREE.MeshStandardMaterial({ color: this.mood.desk, roughness: 0.9, metalness: 0.0, normalMap: this.#grainTexture(40), normalScale: new THREE.Vector2(0.25, 0.25), envMapIntensity: 0.5 }),
    );
    this.desk.rotation.x = -Math.PI / 2;
    this.desk.position.y = -0.0005;
    this.desk.receiveShadow = true;
    this.scene.add(this.desk);
    // 机の上の光だまり（キーボードのまわりだけ明るく、遠くは暗く）
    this.pool = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 1.5),
      new THREE.MeshBasicMaterial({ map: this.#glowTexture(), transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, color: this.mood.key, toneMapped: false }),
    );
    this.pool.rotation.x = -Math.PI / 2;
    this.pool.position.set(-0.03, 0.0002, 0.02);
    this.pool.renderOrder = 1;
    this.scene.add(this.pool);

    this.target = new THREE.Vector3(0, 0.012, 0.004);   // カメラが見る点（キーボードの中心）
    this.kbSize = new THREE.Vector3(0.31, 0.03, 0.125);

    this.#buildComposer();
    this.setQuality(this.quality);

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._onPointer = (e) => {
      this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener('pointermove', this._onPointer, { passive: true });
    document.addEventListener('visibilitychange', () => { this.running = !document.hidden; if (this.running) this.clock.getDelta(); });
    this.resize();
    renderer.setAnimationLoop(() => this.#frame());
  }

  // ---------- 読み込み ----------

  /** 3D のキーボードを読み込む。 @param {string} baseUrl import.meta.env.BASE_URL */
  load(baseUrl) {
    const draco = new DRACOLoader().setDecoderPath(baseUrl + 'draco/');
    return new Promise((resolve, reject) => {
      new GLTFLoader().setDRACOLoader(draco).load(baseUrl + 'models/keyboard.glb', (gltf) => {
        try {
          this.#setupModel(gltf.scene);
          this.ready = true;
          this.#redrawLegends();
          this.needsRender = true;
          this.shadowDirty = true;
          resolve(this.keys.size);
        } catch (e) { reject(e); }
        draco.dispose();
      }, undefined, reject);
    });
  }

  #setupModel(root) {
    // 素材に付いてきた余計な物体（既定の立方体）は使わない
    const stray = root.getObjectByName('Cube');
    if (stray) stray.parent.remove(stray);
    this.model = root;
    this.scene.add(root);

    // PBT のキーは、細かいざらつき（法線のノイズ）で、つやのないマットな面にする。ケースは梨地（ビーズブラスト）のアルミ
    // 模様のくり返しは 1（座標は下の boxUv で、4cm ごとに 1 枚になるように作る）
    const grain = this.#grainTexture(1, 'normal');
    const pbt = { normalMap: grain, normalScale: new THREE.Vector2(0.35, 0.35), roughnessMap: this.#grainTexture(1, 'rough'), envMapIntensity: 0.55 };
    const mat = (o) => new THREE.MeshStandardMaterial(o);
    this.materials = {
      KB_Case: mat({ color: '#3a3c42', roughness: 0.5, metalness: 0.9, normalMap: grain, normalScale: new THREE.Vector2(0.12, 0.12), envMapIntensity: 0.8 }),
      KB_Logo: mat({ color: '#d9dde6', roughness: 0.45, metalness: 0.7 }),
      KB_Cap: mat({ color: '#2a2c33', roughness: 0.82, ...pbt }),
      KB_CapAlpha: mat({ color: '#c4c0b8', roughness: 0.8, ...pbt }),
      KB_CapMod: mat({ color: '#323e5a', roughness: 0.82, ...pbt }),
      KB_Orange: mat({ color: '#e85a22', roughness: 0.78, ...pbt }),
      KB_Black: mat({ color: '#121317', roughness: 0.75, ...pbt }),
      KB_Legend: mat({ color: '#e9e7e2', roughness: 0.5 }),
      KB_LegendDark: mat({ color: '#1c1e23', roughness: 0.5 }),
      KB_Switch: mat({ color: '#08090b', roughness: 0.6 }),
    };

    const glowTex = this.#glowTexture();
    const keyNodes = [];
    root.traverse((o) => {
      if (o.isMesh) {
        const m = this.materials[o.material.name];
        o.userData.matName = o.material.name;
        if (m) o.material = m;
        if (m && m.normalMap && !o.geometry.attributes.uv) boxUv(o.geometry, 25);
        o.castShadow = true;
        o.receiveShadow = true;
      }
      if (/^Key_/.test(o.name) && o.parent && o.parent.name === 'KB_Root') keyNodes.push(o);
    });
    this.root = root.getObjectByName('KB_Root') || root;

    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    box.getSize(this.kbSize);
    const c = box.getCenter(new THREE.Vector3());
    this.target.set(c.x, c.y, c.z);

    // 刻印の絵（配列が変わるたびに描き直す）
    this.legendCanvas = document.createElement('canvas');
    this.legendCanvas.width = LEGEND_CELL * LEGEND_COLS;
    this.legendCanvas.height = LEGEND_CELL * LEGEND_COLS;
    this.legendTexture = new THREE.CanvasTexture(this.legendCanvas);
    this.legendTexture.colorSpace = THREE.SRGBColorSpace;
    this.legendTexture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.legendMaterial = new THREE.MeshStandardMaterial({
      map: this.legendTexture, transparent: true, roughness: 0.55, depthWrite: false,
      emissive: '#ffffff', emissiveMap: this.legendTexture, emissiveIntensity: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });

    const codeOfName = new Map();
    for (const [code, name] of Object.entries(MODEL_KEY_BY_CODE)) if (name) codeOfName.set(name, code);
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);

    for (const node of keyNodes) {
      const meshes = [];
      node.traverse((o) => { if (o.isMesh) meshes.push(o); });
      const cap = meshes.find((m) => /Cap|Orange|Black/.test(m.userData.matName)) || meshes[0];
      const legend = meshes.find((m) => /Legend/.test(m.userData.matName)) || null;
      if (!cap) continue;
      const capMat = cap.material.clone();   // キーごとに光らせるため、材質を分ける
      cap.material = capMat;
      const light = cap.userData.matName === 'KB_CapAlpha';
      const baseColor = capMat.color.clone();   // 運指の色分けをやめたときに戻す色

      // キーの上の面を探す（キーの中での座標）
      cap.geometry.computeBoundingBox();
      const bb = cap.geometry.boundingBox;
      const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
      const w = bb.max.x - bb.min.x, d = bb.max.z - bb.min.z;
      let topY = bb.max.y;
      const normal = new THREE.Vector3(0, 1, 0);
      const inv = new THREE.Matrix4().copy(cap.matrixWorld).invert();
      const hits = [];
      for (const [ox, oz] of [[0, 0], [-0.22, -0.22], [0.22, -0.22], [-0.22, 0.22], [0.22, 0.22]]) {
        const p = new THREE.Vector3(cx + ox * Math.min(w, 0.019), bb.max.y + 0.01, cz + oz * d).applyMatrix4(cap.matrixWorld);
        ray.set(p, down.clone().transformDirection(cap.matrixWorld).normalize());
        const hit = ray.intersectObject(cap, false)[0];
        if (hit) hits.push(hit.point.clone().applyMatrix4(inv));
      }
      if (hits.length) topY = Math.max(...hits.map((h) => h.y));

      const key = {
        name: node.name, node, cap, capMat, legendMesh: legend, light, baseColor,
        code: codeOfName.get(node.name) || null,
        restY: node.position.y, y: 0, v: 0, down: false, autoUp: 0,
        glow: 0, glowColor: new THREE.Color(ACCENT), target: 0, heat: 0,
        finger: -1, color: new THREE.Color('#ffffff'),
        x: node.position.x, z: node.position.z,
        topY, cx, cz, w, d, plane: null, under: null,
      };
      capMat.emissive = new THREE.Color(0, 0, 0);

      // キーの下からもれる光（板）
      const under = new THREE.Mesh(
        new THREE.PlaneGeometry(w + 0.012, d + 0.012),
        new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, color: ACCENT, toneMapped: false }),
      );
      under.rotation.x = -Math.PI / 2;
      under.position.set(node.position.x + cx, 0.0074, node.position.z + cz);
      under.renderOrder = 2;
      under.visible = false;
      this.root.add(under);
      key.under = under;

      this.keys.set(node.name, key);
      if (key.code) this.codeToKey.set(key.code, key);
    }
    // 中心からの距離（光の波に使う）
    for (const k of this.keys.values()) k.nx = (k.x - 0.152) / 0.152;
  }

  /** 細かいざらつき。kind：'normal'（法線のゆらぎ）か 'rough'（粗さのむら）。repeat はくり返しの回数。 */
  #grainTexture(repeat = 6, kind = 'normal') {
    const N = 256;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d');
    const img = g.createImageData(N, N);
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < N * N; i++) {
      if (kind === 'normal') {
        // 法線：x と y を、少しだけゆらす
        img.data[i * 4] = 128 + (rnd() - 0.5) * 70;
        img.data[i * 4 + 1] = 128 + (rnd() - 0.5) * 70;
        img.data[i * 4 + 2] = 255;
      } else {
        const v = 200 + rnd() * 55;   // 粗さ：0.78〜1 倍のむら
        img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v;
      }
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    return t;
  }

  #glowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ---------- 刻印（配列の文字） ----------

  /**
   * 配列を刻印に反映する。
   * @param {import('../core.js').Layout} layout
   * @param {'jis'|'us'} kind
   * @param {Array<Array<{code: string, label: string, isModifier: boolean, homeBump: boolean}>>} rows core.keyboardRows(kind)
   * @param {{fingerColors?: boolean, qwertySub?: boolean, qwerty?: import('../core.js').Layout}} [options]
   */
  setLayout(layout, kind, rows, options = {}) {
    this.layout = layout;
    this.kind = kind;
    this.rows = rows;
    Object.assign(this.legendOptions, options);
    if (this.ready) this.#redrawLegends();
  }

  #redrawLegends() {
    if (!this.layout || !this.rows) return;
    const g = this.legendCanvas.getContext('2d');
    g.clearRect(0, 0, this.legendCanvas.width, this.legendCanvas.height);
    const slots = this.rows.flat().filter((s) => !s.isModifier && s.code !== 'Space');
    const opt = this.legendOptions;
    const used = new Set();
    let i = 0;
    for (const slot of slots) {
      const key = this.codeToKey.get(slot.code);
      const def = this.layout.keys[slot.code];
      if (!key || !def) continue;
      used.add(key);
      key.finger = def.finger;
      const base = FINGERS[def.finger] ? FINGERS[def.finger].color : '#ffffff';
      key.color.set(base);
      this.#tintCap(key, opt.fingerColors ? base : null);
      const col = i % LEGEND_COLS, row = Math.floor(i / LEGEND_COLS);
      const x0 = col * LEGEND_CELL, y0 = row * LEGEND_CELL;
      const ch = String(def.char || '');
      // 面を指の色で塗るので、文字は面に対してはっきり見える色（明るい面には濃い色、暗い面には明るい色）
      const ink = opt.fingerColors
        ? (key.light ? shade(base, -0.72) : shade(base, 0.55))
        : (key.light ? '#1c1e23' : '#e9e7e2');
      g.save();
      g.translate(x0, y0);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = ink;
      const big = ch.length > 1 ? 44 : 76;
      g.font = `600 ${big}px "Sora", "Zen Kaku Gothic New", "Noto Sans JP", system-ui, sans-serif`;
      g.fillText(ch, 64, 66);
      if (def.shiftChar) {
        g.font = '600 30px "JetBrains Mono", ui-monospace, monospace';
        g.globalAlpha = 0.85;
        g.fillText(def.shiftChar, 104, 24);
        g.globalAlpha = 1;
      }
      const q = opt.qwerty && opt.qwerty.keys[slot.code] ? String(opt.qwerty.keys[slot.code].char) : '';
      if (opt.qwertySub && q && q !== ch) {
        g.font = '500 26px "JetBrains Mono", ui-monospace, monospace';
        g.globalAlpha = 0.5;
        g.fillStyle = key.light ? '#1c1e23' : '#e9e7e2';
        g.fillText(q, 104, 106);
        g.globalAlpha = 1;
      }
      if (slot.homeBump) {
        g.fillStyle = ink;
        g.globalAlpha = 0.7;
        g.fillRect(48, 112, 32, 5);
      }
      g.restore();
      this.#placeLegend(key, col, row);
      i++;
    }
    // 刻印を描かないキー：元の刻印の形を見せる
    for (const key of this.keys.values()) {
      const custom = used.has(key);
      if (key.legendMesh) key.legendMesh.visible = !custom;
      if (key.plane) key.plane.visible = custom;
      if (!custom) {
        key.finger = key.code && this.layout.keys[key.code] ? this.layout.keys[key.code].finger : -1;
        key.color.set(key.finger >= 0 ? FINGERS[key.finger].color : ACCENT);
        // Shift だけは、配列で決めた指の色で塗る（ほかの文字のないキーは、元の色）
        const shiftKey = key.code === 'ShiftLeft' || key.code === 'ShiftRight';
        this.#tintCap(key, opt.fingerColors && shiftKey && key.finger >= 0 ? FINGERS[key.finger].color : null);
      }
    }
    this.legendTexture.needsUpdate = true;
    this.needsRender = true;
  }

  /** キーの面を指の色で塗る（null で元の色に戻す）。明るいキーは淡く、暗いキーは深く色を混ぜる。 */
  #tintCap(key, color) {
    key.capMat.color.copy(key.baseColor);
    if (!color) return;
    const c = new THREE.Color(color);
    if (key.light) key.capMat.color.lerp(c, 0.62);
    else key.capMat.color.lerp(c.multiplyScalar(0.62), 0.55);
  }

  #placeLegend(key, col, row) {
    const size = Math.min(key.w, key.d) * 0.7;
    if (!key.plane) {
      const geo = new THREE.PlaneGeometry(size, size);
      const plane = new THREE.Mesh(geo, this.legendMaterial);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(key.cx, key.topY + 0.00012, key.cz);
      plane.renderOrder = 3;
      key.cap.add(plane);
      key.plane = plane;
    }
    const uv = key.plane.geometry.attributes.uv;
    const u0 = col / LEGEND_COLS, u1 = (col + 1) / LEGEND_COLS;
    const v1 = 1 - row / LEGEND_COLS, v0 = 1 - (row + 1) / LEGEND_COLS;
    uv.setXY(0, u0, v1); uv.setXY(1, u1, v1); uv.setXY(2, u0, v0); uv.setXY(3, u1, v0);
    uv.needsUpdate = true;
  }

  /** フォントが読み込めたあとなどに、刻印を描き直す。 */
  refreshLegends() { if (this.ready) this.#redrawLegends(); }

  // ---------- キーの動きと光 ----------

  #keyOf(code) { return this.codeToKey.get(code) || null; }

  /**
   * キーを押す。
   * @param {string} code KeyboardEvent.code
   * @param {{tone?: 'correct'|'miss'|'neutral', hold?: boolean}} [o] hold：離すまで沈めたままにする
   */
  press(code, o = {}) {
    const key = this.#keyOf(code);
    if (!key) return;
    key.down = true;
    key.autoUp = o.hold ? 0 : this.time + 0.09;
    const tone = o.tone || 'neutral';
    if (tone === 'miss') key.glowColor.set(DANGER);
    else if (tone === 'correct') key.glowColor.copy(key.color);
    else key.glowColor.set(key.finger >= 0 ? key.color : new THREE.Color('#ffffff'));
    key.glow = tone === 'neutral' ? 0.35 : tone === 'miss' ? 0.85 : 0.6;
    this.needsRender = true;
  }

  release(code) {
    const key = this.#keyOf(code);
    if (key) { key.down = false; key.autoUp = 0; }
  }

  releaseAll() { for (const k of this.keys.values()) { k.down = false; k.autoUp = 0; } }

  /** 次に押すキー。 @param {Array<{code: string, role?: 'key'|'shift'}>} list */
  setTargets(list) {
    this.targets.clear();
    for (const t of list || []) if (t && t.code) this.targets.set(t.code, t.role || 'key');
    this.needsRender = true;
  }

  /** ミスの多かったキーを赤く灯す（結果の画面）。 @param {Object<string, number>} map code → 0〜1 */
  setHeat(map) {
    this.heat.clear();
    for (const [code, v] of Object.entries(map || {})) this.heat.set(code, v);
    this.needsRender = true;
  }

  /**
   * 光の波。
   * @param {{color?: string|null, from?: 'left'|'center'|'right', speed?: number, strength?: number, rainbow?: boolean}} [o]
   */
  wave(o = {}) {
    if (this.reducedMotion) return;
    this.waves.push({ t0: this.time, color: o.color ? new THREE.Color(o.color) : null, from: o.from || 'center', speed: o.speed || 1, strength: o.strength ?? 1, rainbow: Boolean(o.rainbow) });
    this.needsRender = true;
  }

  // ---------- カメラと光 ----------

  /** HTML 側が決めた枠にキーボードを収める。 @param {{left: number, top: number, width: number, height: number}} rect 画面の座標 */
  setSlot(rect, immediate = false) {
    const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
    const to = { cx: (rect.left + rect.width / 2) / vw, cy: (rect.top + rect.height / 2) / vh, w: rect.width / vw, h: rect.height / vh };
    const same = Math.abs(to.cx - this.slotTo.cx) + Math.abs(to.cy - this.slotTo.cy) + Math.abs(to.w - this.slotTo.w) + Math.abs(to.h - this.slotTo.h) < 0.002;
    if (same && !immediate) return;
    this.slotFrom = { ...this.slotNow };
    this.slotTo = to;
    if (immediate || this.reducedMotion) { this.slotNow = { ...to }; this.slotFrom = { ...to }; }
    else if (this.poseT >= 1) { this.poseFrom = { ...this.pose }; this.poseT = 0; this.poseDur = 0.5; }
    this.needsRender = true;
  }

  /** カメラの位置を変える。 @param {keyof typeof POSES} name */
  setPose(name, seconds = 1.1) {
    const to = POSES[name] || POSES.home;
    this.poseName = name;
    this.poseFrom = { ...this.pose };
    this.slotFrom = { ...this.slotNow };
    this.poseTo = { ...to };
    this.poseT = this.reducedMotion ? 1 : 0;
    this.poseDur = seconds;
    if (this.reducedMotion) { this.pose = { ...to }; this.slotNow = { ...this.slotTo }; }
    this.needsRender = true;
  }

  /** テーマ（'dark' | 'light'）。光・机・小物の色がなめらかに変わる。 */
  setTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    if (t === this.theme) return;
    this.theme = t;
    this.moodFrom = this.#currentMood();
    this.moodTo = this.#moodOf(this.moodTo.name);
    this.moodT = this.reducedMotion ? 1 : 0;
    this.moodDur = 0.8;
    this.needsRender = true;
  }

  #moodOf(name) {
    const set = this.theme === 'light' ? MOODS_LIGHT : MOODS_DARK;
    const m = set[name] || set.studio;
    return {
      name, bg: new THREE.Color(m.bg), desk: new THREE.Color(m.desk), key: new THREE.Color(m.key), keyI: m.keyI,
      rim: new THREE.Color(m.rim), rimI: m.rimI, env: m.env, legend: m.legend, back: m.back, backColor: new THREE.Color(m.backColor), exposure: m.exposure,
    };
  }

  /** 光の色を変える。 @param {keyof typeof MOODS} name */
  setMood(name, seconds = 1.2) {
    if (this.moodTo.name === name) return;
    this.moodFrom = this.#currentMood();
    this.moodTo = this.#moodOf(name);
    this.moodT = this.reducedMotion ? 1 : 0;
    this.moodDur = seconds;
    this.needsRender = true;
  }

  #currentMood() {
    if (this.moodT >= 1) return this.moodTo;   // 変わり終わっていれば、作り直さない
    const a = this.moodFrom, b = this.moodTo, t = ease(Math.min(1, this.moodT));
    return {
      name: b.name, bg: a.bg.clone().lerp(b.bg, t), desk: a.desk.clone().lerp(b.desk, t), key: a.key.clone().lerp(b.key, t), keyI: lerp(a.keyI, b.keyI, t),
      rim: a.rim.clone().lerp(b.rim, t), rimI: lerp(a.rimI, b.rimI, t), env: lerp(a.env, b.env, t), legend: lerp(a.legend, b.legend, t),
      back: lerp(a.back, b.back, t), backColor: a.backColor.clone().lerp(b.backColor, t), exposure: lerp(a.exposure, b.exposure, t),
    };
  }

  /** シャトルラン：残り時間の少なさ（0〜1）。光が青緑 → 橙 → 赤に変わる。 */
  setUrgency(u) {
    const v = Math.max(0, Math.min(1, u));
    if (Math.abs(v - this.urgency) > 0.001) this.needsRender = true;
    this.urgency = v;
  }

  setReducedMotion(on) { this.reducedMotion = Boolean(on); }

  setQuality(q) {
    this.quality = q === 'low' ? 'low' : 'high';
    const high = this.quality === 'high';
    this.renderer.shadowMap.enabled = high;
    this.keyLight.castShadow = high;
    this.useBloom = high;
    this.shadowDirty = true;
    this.#applyResolution();
  }

  /** 描く解像度（画面の画素に対する倍率）。高い設定でも 1.5 倍まで（それ以上は見た目がほとんど変わらず、重さだけが増える）。
   *  CSS でぼかしている奥では下げる。 */
  #pixelRatio() {
    const dpr = window.devicePixelRatio || 1;
    if (this.quality === 'low') return this.backdrop ? 0.5 : Math.min(dpr, 1);
    return this.backdrop ? 0.6 : Math.min(dpr, 1.5);
  }

  #applyResolution() {
    const pr = this.#pixelRatio();
    if (pr !== this.renderer.getPixelRatio()) this.renderer.setPixelRatio(pr);
    // ぼけている奥では、キーの間の暗がりと被写界深度は見えないので省く
    if (this.gtao) this.gtao.enabled = !this.backdrop;
    if (this.bokeh) this.bokeh.enabled = !this.backdrop;
    this.resize();
  }

  /** 画面の CSS で、舞台がぼかされているか（ほかのタブ・平面のキーボードの練習）。 */
  #blurredByPage() {
    const b = document.body.dataset;
    if (b.shuttle === '1') return false;
    if (b.depth === 'back') return true;
    return b.view === 'flat' && b.tab === 'practice' && b.pscreen !== 'result';
  }

  #buildComposer() {
    const size = new THREE.Vector2(1, 1);
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // 環境光の遮り：キーとキーの間・キーの根元・ケースのふちに、自然な暗がり（単位は m）
    this.gtao = new GTAOPass(this.scene, this.camera, 1, 1, undefined, { radius: 0.018, distanceExponent: 1.4, thickness: 0.012, scale: 1.25, samples: 16 }, { radius: 6, rings: 2, samples: 12 });
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 1;
    this.composer.addPass(this.gtao);
    // 被写界深度：見ている点から前後に離れるほど、ぼける
    this.bokeh = new BokehPass(this.scene, this.camera, { focus: 0.6, aperture: 0.035, maxblur: 0.006 });
    this.composer.addPass(this.bokeh);
    this.bloom = new UnrealBloomPass(size, 0.3, 0.45, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.film = new ShaderPass(FilmLook);
    this.composer.addPass(this.film);
  }

  resize() {
    const w = window.innerWidth || 1, h = window.innerHeight || 1;
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.needsRender = true;
  }

  // ---------- 1 コマ ----------

  #frame() {
    if (!this.running) return;
    // ぼかしの奥に入った・出たとき：出るときはすぐ、入るときは CSS のぼかしが効いてから（0.9 秒）解像度を変える
    const blurred = this.#blurredByPage();
    if (blurred !== this.backdropWant) { this.backdropWant = blurred; this.backdropAt = performance.now() + (blurred ? 900 : 0); }
    if (this.backdrop !== this.backdropWant && performance.now() >= this.backdropAt) {
      this.backdrop = this.backdropWant;
      this.#applyResolution();
    }
    const drift = this.reducedMotion || this.quality === 'low' ? 0 : this.pose.drift;
    const animating = this.needsRender || this.poseT < 1 || this.moodT < 1 || this.waves.length > 0 || this.keysBusy;
    this.acc += this.clock.getDelta();
    // 何も動いていなければ、何もしない
    if (!animating && drift <= 0.01) { this.acc = 0; return; }
    // 動きがあるときは 60 コマ/秒まで。カメラのゆらぎだけのときは 30（ぼけた奥では 20）コマ/秒
    const gap = animating ? 1 / 60 : this.backdrop ? 1 / 20 : 1 / 30;
    if (this.acc < gap - 0.004) return;
    const dt = Math.min(this.acc, 0.05);
    this.acc = 0;
    this.time += dt;
    const t = this.time;
    let active = this.needsRender;

    // カメラ
    if (this.poseT < 1) {
      this.poseT = Math.min(1, this.poseT + dt / Math.max(0.05, this.poseDur));
      const k = ease(this.poseT);
      for (const f of Object.keys(this.poseTo)) this.pose[f] = lerp(this.poseFrom[f], this.poseTo[f], k);
      for (const f of ['cx', 'cy', 'w', 'h']) this.slotNow[f] = lerp(this.slotFrom[f], this.slotTo[f], k);
      active = true;
    }
    if (this.moodT < 1) { this.moodT = Math.min(1, this.moodT + dt / Math.max(0.05, this.moodDur || 1)); active = true; }
    this.pointer.sx += (this.pointer.x - this.pointer.sx) * Math.min(1, dt * 3);
    this.pointer.sy += (this.pointer.y - this.pointer.sy) * Math.min(1, dt * 3);
    this.#placeCamera(t, drift);

    // 光
    const m = this.#currentMood();
    const urgent = this.urgency;
    const back = m.backColor.clone();
    if (urgent > 0) back.lerp(new THREE.Color('#ffb23e'), Math.min(1, urgent * 2)).lerp(new THREE.Color(DANGER), Math.max(0, urgent * 2 - 1));
    this.scene.background.copy(m.bg);
    this.scene.fog.color.copy(m.bg);
    this.desk.material.color.copy(m.desk);
    this.pool.material.color.copy(m.key);
    this.pool.material.opacity = (this.theme === 'light' ? 0.012 : 0.05) * m.keyI;   // 明るい机では、にじんで白くならないように弱く
    this.keyLight.color.copy(m.key);
    this.keyLight.intensity = m.keyI;
    this.rimLight.color.copy(m.rim).lerp(back, m.back);
    this.rimLight.intensity = m.rimI;
    // 周りからの光は控えめにして、主光の当たり方の差（光と影）をはっきりさせる
    this.scene.environmentIntensity = m.env * (this.theme === 'light' ? 0.75 : 0.45);
    this.renderer.toneMappingExposure = m.exposure * (this.theme === 'light' ? 1.0 : 0.9);
    if (this.legendMaterial) this.legendMaterial.emissiveIntensity = m.legend;
    // ライト：霧は遠くの机だけにかける（キーボードには、ほとんどかからない）
    this.scene.fog.density = this.theme === 'light' ? 0.22 / Math.max(0.2, this.focusDist || 0.6) : 0.55;
    // キー
    this.keysBusy = this.ready ? this.#animateKeys(dt, t, m, back) : false;
    active = this.keysBusy || active;

    if (active || drift > 0.01) {
      if (this.shadowDirty && this.renderer.shadowMap.enabled) { this.renderer.shadowMap.needsUpdate = true; this.shadowDirty = false; }
      if (this.useBloom) {
        // ライト：明るい机やキーまでにじむと、霧がかかったように白っぽくなる。光っているところだけにじませる
        const light = this.theme === 'light';
        this.bloom.threshold = light ? 2.6 : 1.0;
        this.bloom.strength = light ? 0.2 : 0.3;
        const u = this.bokeh.uniforms;
        u.focus.value = this.focusDist || 0.6;
        u.aperture.value = 0.06 * (this.pose.dof ?? 1);
        this.film.uniforms.uTime.value = t;
        this.composer.render(dt);
      }
      else this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  }

  #placeCamera(t, drift) {
    const p = this.pose;
    const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
    const cam = this.camera;
    cam.fov = p.fov;
    // ゆっくり大きく：左右に約 10 度回り込み、上下にもゆれる。マウスの位置にも少しついてくる
    const elev = (p.elev + Math.sin(t * 0.13) * 3.5 * drift - this.pointer.sy * 3 * drift) * DEG;
    const azim = (p.azim + Math.sin(t * 0.09 + 1.3) * 8.5 * drift + this.pointer.sx * 4 * drift) * DEG;

    // 枠の幅にキーボードの幅を合わせる（高さが足りなければ高さに合わせる）
    const slotW = Math.max(40, this.slotNow.w * vw), slotH = Math.max(40, this.slotNow.h * vh);
    const tanHalf = Math.tan((p.fov * DEG) / 2);
    const ca = Math.abs(Math.cos(azim)), sa = Math.abs(Math.sin(azim));
    const spanX = this.kbSize.x * ca + this.kbSize.z * sa;
    const spanZ = this.kbSize.z * ca + this.kbSize.x * sa;
    const spanY = spanZ * Math.sin(elev) + this.kbSize.y * Math.cos(elev);
    const pxPerM = Math.min((slotW * p.fill) / spanX, (slotH * p.fill * 0.96) / spanY);
    const dist = (vh / (2 * tanHalf * pxPerM)) * (1 + Math.sin(t * 0.07 + 0.6) * 0.06 * drift);   // 寄ったり引いたり

    this.focusDist = dist;
    cam.position.set(
      this.target.x + dist * Math.cos(elev) * Math.sin(azim),
      this.target.y + dist * Math.sin(elev),
      this.target.z + dist * Math.cos(elev) * Math.cos(azim),
    );
    cam.up.set(Math.sin(p.roll * DEG), Math.cos(p.roll * DEG), 0);
    cam.lookAt(this.target);
    const ox = (this.slotNow.cx - 0.5) * vw;
    const oy = (this.slotNow.cy - 0.5) * vh;
    cam.setViewOffset(vw, vh, -ox, -oy, vw, vh);
    cam.updateProjectionMatrix();
  }

  #animateKeys(dt, t, m, back) {
    let active = false;
    const still = this.reducedMotion;
    // 光の波
    this.waves = this.waves.filter((w) => t - w.t0 < 2.2 / w.speed);
    const tmp = new THREE.Color();

    for (const key of this.keys.values()) {
      // 沈み（ばね）
      if (key.autoUp && t >= key.autoUp) { key.down = false; key.autoUp = 0; }
      const goal = key.down && !still ? -KEY_TRAVEL : 0;
      if (Math.abs(goal - key.y) > 1e-6 || Math.abs(key.v) > 1e-5) {
        const stiff = key.down ? 5200 : 1500, damp = key.down ? 120 : 46;
        const steps = 3, h = dt / steps;
        for (let i = 0; i < steps; i++) {
          key.v += (stiff * (goal - key.y) - damp * key.v) * h;
          key.y += key.v * h;
        }
        if (key.y < -KEY_TRAVEL) { key.y = -KEY_TRAVEL; key.v = 0; }
        key.node.position.y = key.restY + key.y;
        active = true;
        this.shadowDirty = true;
      }

      // 光
      const role = key.code ? this.targets.get(key.code) : null;
      const want = role ? 1 : 0;
      key.target += (want - key.target) * Math.min(1, dt * 14);
      if (Math.abs(want - key.target) > 0.003) active = true; else key.target = want;
      const heatWant = key.code && this.heat.has(key.code) ? this.heat.get(key.code) : 0;
      key.heat += (heatWant - key.heat) * Math.min(1, dt * 4);
      if (Math.abs(heatWant - key.heat) > 0.003) active = true; else key.heat = heatWant;
      if (key.glow > 0.002) { key.glow *= Math.exp(-dt * 5.5); active = true; } else key.glow = 0;

      let wave = 0;
      let waveColor = null;
      for (const w of this.waves) {
        const age = (t - w.t0) * w.speed;
        const pos = w.from === 'left' ? (key.nx + 1) / 2 : w.from === 'right' ? (1 - key.nx) / 2 : Math.hypot(key.nx, (key.z - 0.03) / 0.152) * 0.75;
        const d = age * 1.6 - pos * 1.25;
        if (d > 0 && d < 0.6) {
          const a = Math.sin((d / 0.6) * Math.PI) * w.strength;
          if (a > wave) { wave = a; waveColor = w.rainbow ? tmp.setHSL((pos * 0.8 + 0.02) % 1, 0.85, 0.6).clone() : (w.color || key.color); }
        }
      }
      if (wave > 0) active = true;

      const e = key.capMat.emissive;
      e.setRGB(0, 0, 0);
      let under = 0;
      const uc = key.under.material.color;
      if (m.back > 0.01) { under += m.back * 0.5; uc.copy(back); }
      if (key.target > 0.01) {
        const c = role === 'shift' ? tmp.set('#ffffff') : role === 'accent' ? tmp.set(ACCENT) : key.color;
        const a = key.target;
        addColor(e, c, a * (key.light ? 0.3 : 0.55));
        under = Math.max(under, a * 0.85); uc.copy(c);
      }
      if (key.heat > 0.01) {
        addColor(e, tmp.set(DANGER), key.heat * 0.5);
        under = Math.max(under, key.heat * 0.9); uc.set(DANGER);
      }
      if (wave > 0.01) {
        addColor(e, waveColor, wave * 0.6);
        if (wave > under) { under = wave; uc.copy(waveColor); }
      }
      if (key.glow > 0.01) {
        addColor(e, key.glowColor, key.glow * (key.light ? 0.45 : 0.8));
        if (key.glow * 0.9 > under) { under = key.glow * 0.9; uc.copy(key.glowColor); }
      }
      key.under.visible = under > 0.01;
      key.under.material.opacity = Math.min(1, under);
    }
    return active;
  }

  /** キーボードが画面のどこに映っているか（px）。 */
  screenRect() {
    const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
    return { left: (this.slotNow.cx - this.slotNow.w / 2) * vw, top: (this.slotNow.cy - this.slotNow.h / 2) * vh, width: this.slotNow.w * vw, height: this.slotNow.h * vh };
  }

  /** 画面の点の下にあるキーの code（なければ null）。 */
  pick(clientX, clientY) {
    if (!this.ready) return null;
    const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((clientX / vw) * 2 - 1, -(clientY / vh) * 2 + 1), this.camera);
    const caps = [...this.keys.values()].map((k) => k.cap);
    const hit = ray.intersectObjects(caps, false)[0];
    if (!hit) return null;
    for (const k of this.keys.values()) if (k.cap === hit.object) return k.code;
    return null;
  }
}
