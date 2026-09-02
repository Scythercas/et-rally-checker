/* =====================================================================
 * ETロボコン2026 ETラリー 走行シミュレータ（v2: バック走行対応）
 * 仕様: docs/設計書_v003.md（無印版との差分は「バックN」の走行指示）
 * 外部ライブラリ・ネットワーク接続なしで動作する。
 * ===================================================================== */
'use strict';

/* ---------------------------------------------------------------
 * 定数
 * ------------------------------------------------------------- */

const COLS = 11;                       // A〜K
const ROWS = 11;                       // 1〜11
const COL_LABEL = 'ABCDEFGHIJK';
const CELL = 100 / COLS;               // 1マスのステージ比率(%)

/* コース画像の較正値。
 * gx,gy,gw,gh は画像内で 11x11 のマス目が占める領域(画像ピクセル)。
 * 座標表示版は画像自身の罫線から、非表示版はグレーの丸(偶数座標)の中心から実測した。 */
const COURSE_CAL = {
  'LCourse.png':       { w: 549, h: 531, gx: 31.46, gy: -8.72, gw: 490.88, gh: 490.74 },
  'LCourse_Coord.png': { w: 481, h: 487, gx: 48.90, gy: 45.00, gw: 419.10, gh: 413.50 },
  'RCourse_Coord.png': { w: 497, h: 481, gx: 45.00, gy: 43.00, gw: 419.00, gh: 413.50 }
};

/* ゲート画像の定義。
 * f1,f2 は画像内での足の接地点(画像ピクセル)、span は足と足の距離(=2マス)。 */
const GATE_DEF = {
  red:    { name: '赤', img: '../images/GateRed.png',    w: 285, h: 209, axis: 'h', f1: [17.0, 204.0], span: 250.0 },
  yellow: { name: '黄', img: '../images/GateYellow.png', w: 284, h: 210, axis: 'h', f1: [16.0, 205.0], span: 250.0 },
  blue:   { name: '青', img: '../images/GateBlue.png',   w: 107, h: 245, axis: 'v', f1: [8.5,  31.5],  span: 188.5 }
};

/* 初期位置(足のうち左/上側)。赤=H4-J4, 黄=F2-H2, 青=F4-F6 */
const GATE_INIT = { red: { c: 7, r: 3 }, yellow: { c: 5, r: 1 }, blue: { c: 5, r: 3 } };

/* パックマンの初期状態: I1 を左向き */
const PACKMAN_INIT = { c: 8, r: 0, dir: 3 };

/* 方位: 0=上, 1=右, 2=下, 3=左 (Packman.png は右向きが基準) */
const DIR_LABEL = ['上', '右', '下', '左'];
const DIR_DELTA = [[0, -1], [1, 0], [0, 1], [-1, 0]];

const MOVE_MS = 380;                   // 1マス移動の基準時間
const TURN_MS = 280;                   // 90度回転の基準時間

/* 競技規約 5.17.3「ゲート通過」より、1周回として成立するゲートの通過順序(表5-3) */
const RALLY_ORDER = ['red', 'blue', 'yellow'];

/* 競技規約 6.4「【B】課題ポイント」表6-2 より、ETラリーの課題ポイント。
 * 1周回=5, 2周回=10, 3周回=15 で「いずれかが成立」= 最も多い周回のみが加点される。 */
const RALLY_POINTS = [0, 5, 10, 15];
const RALLY_MAX_LAPS = RALLY_POINTS.length - 1;
const RALLY_MAX_POINTS = RALLY_POINTS[RALLY_MAX_LAPS];

const SAMPLE_INSTRUCTIONS = [
  '左', '直進4', '右', '直進5', '右', '直進4', '右', '直進3', '右', '直進2',
  '左', '直進2', '右', '直進2', '右', '直進5', '右', '直進4', '右', '直進3',
  '右', '直進2', '左', '直進2', '右', '直進2', '右', '直進5', '右', '直進4',
  '右', '直進3', '右', '直進10'
].join('\n');

/* ---------------------------------------------------------------
 * 状態
 * ------------------------------------------------------------- */

const state = {
  phase: 'idle',                       // idle(開始前) | running(実行中) | finished(終了後)
  course: 'L',
  showCoord: true,
  showCookie: true,
  speed: 1,
  gates: structuredClone(GATE_INIT),
  packman: { ...PACKMAN_INIT },
  angle: 0,                            // 見た目の累積回転角(度)。init() で向きに合わせて設定する
  snapshot: null,                      // 実行直前の状態(初期化で復元する)
  route: null,                         // 算出済みルート
  cookies: new Map(),                  // "c,r" -> 残りクッキー数
  passes: [],                          // 通過したゲートの色を順に保持する
  timer: null,
  stepIndex: 0
};

/* dir と表示角度の対応。Packman.png は右向き(dir=1)が回転0度である。 */
function dirToAngleBase(dir) { return (dir - 1) * 90; }

/* ---------------------------------------------------------------
 * DOM
 * ------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const courseImg = $('course-img');
const gridBox = $('grid-box');
const layerGates = $('layer-gates');
const layerCookies = $('layer-cookies');
const layerPackman = $('layer-packman');
const layerCells = $('layer-cells');

let packmanEl = null;
const gateEls = {};

/* ---------------------------------------------------------------
 * 座標ユーティリティ
 * ------------------------------------------------------------- */

const cellName = (c, r) => `${COL_LABEL[c]}${r + 1}`;
const centerX = (c) => (c + 0.5) * CELL;
const centerY = (r) => (r + 0.5) * CELL;
const inBounds = (c, r) => c >= 0 && c < COLS && r >= 0 && r < ROWS;
const key = (c, r) => `${c},${r}`;

/* ゲートの2つ目の足の位置 */
function gateFoot2(color, pos) {
  return GATE_DEF[color].axis === 'h'
    ? { c: pos.c + 2, r: pos.r }
    : { c: pos.c, r: pos.r + 2 };
}

/* ゲートの中央(パックマンがくぐるマス) */
function gateMiddle(color, pos) {
  return GATE_DEF[color].axis === 'h'
    ? { c: pos.c + 1, r: pos.r }
    : { c: pos.c, r: pos.r + 1 };
}

/* 足が置ける位置か。足は偶数座標(列B,D,F,H,J / 行2,4,6,8,10)の上にある。 */
function isValidGatePos(color, c, r) {
  if (c % 2 !== 1 || r % 2 !== 1) return false;      // 0基点なので奇数インデックス=偶数座標
  const f2 = gateFoot2(color, { c, r });
  return inBounds(c, r) && inBounds(f2.c, f2.r);
}

/* 現在の全ゲートの足のマップ "c,r" -> color */
function footMap(gates = state.gates) {
  const m = new Map();
  for (const color of Object.keys(gates)) {
    const p = gates[color];
    const f2 = gateFoot2(color, p);
    m.set(key(p.c, p.r), color);
    m.set(key(f2.c, f2.r), color);
  }
  return m;
}

/* 中央マスのマップ "c,r" -> {color, axis} */
function middleMap(gates = state.gates) {
  const m = new Map();
  for (const color of Object.keys(gates)) {
    const mid = gateMiddle(color, gates[color]);
    m.set(key(mid.c, mid.r), { color, axis: GATE_DEF[color].axis });
  }
  return m;
}

/* ---------------------------------------------------------------
 * 描画: コース
 * ------------------------------------------------------------- */

function currentCourseFile() {
  if (state.showCoord) return state.course === 'L' ? 'LCourse_Coord.png' : 'RCourse_Coord.png';
  return 'LCourse.png';                                 // 座標非表示のRコースは左右反転で表現する
}

/* ステージは正方形。コース画像はその中に "contain" で収め、
 * 11x11 のマス目領域(grid-box)を画像に合わせて重ねる。
 * これにより座標表示版の行列見出しも画面内に収まる。 */
const FIT = 0.94;                      // ステージに対する画像の占有率(周囲に余白を残す)

function renderCourse() {
  const file = currentCourseFile();
  const cal = COURSE_CAL[file];
  const mirrored = !state.showCoord && state.course === 'R';
  const gx = mirrored ? (cal.w - cal.gx - cal.gw) : cal.gx;

  const ar = cal.w / cal.h;
  const dw = ar >= 1 ? 100 * FIT : 100 * FIT * ar;     // 画像の表示幅(ステージ比%)
  const dh = ar >= 1 ? 100 * FIT / ar : 100 * FIT;     // 画像の表示高(ステージ比%)
  const dx = (100 - dw) / 2;
  const dy = (100 - dh) / 2;

  courseImg.src = '../images/' + file;
  courseImg.style.left = dx + '%';
  courseImg.style.top = dy + '%';
  courseImg.style.width = dw + '%';
  courseImg.style.height = dh + '%';
  courseImg.style.transform = mirrored ? 'scaleX(-1)' : 'none';

  gridBox.style.left = (dx + gx / cal.w * dw) + '%';
  gridBox.style.top = (dy + cal.gy / cal.h * dh) + '%';
  gridBox.style.width = (cal.gw / cal.w * dw) + '%';
  gridBox.style.height = (cal.gh / cal.h * dh) + '%';

  $('course-label').textContent = state.course;
}

/* ---------------------------------------------------------------
 * 描画: ゲート
 * ------------------------------------------------------------- */

function buildGates() {
  layerGates.innerHTML = '';
  for (const color of Object.keys(GATE_DEF)) {
    const def = GATE_DEF[color];
    const el = document.createElement('div');
    el.className = 'gate gate-' + color;
    el.dataset.color = color;
    el.innerHTML = `<img src="${def.img}" alt="${def.name}のゲート" draggable="false">`;
    layerGates.appendChild(el);
    gateEls[color] = el;
    el.addEventListener('pointerdown', (ev) => startDragGate(ev, color));
  }
}

/* 足の位置(マス座標、小数可)を指定してゲートを配置する */
function placeGateAt(color, anchorX, anchorY) {
  const def = GATE_DEF[color];
  const el = gateEls[color];
  const u = (2 * CELL) / def.span;                    // 画像1px -> ステージ%
  el.style.width = (def.w * u) + '%';
  el.style.height = (def.h * u) + '%';
  el.style.left = (anchorX - def.f1[0] * u) + '%';
  el.style.top = (anchorY - def.f1[1] * u) + '%';
}

function renderGates() {
  for (const color of Object.keys(GATE_DEF)) {
    const p = state.gates[color];
    placeGateAt(color, centerX(p.c), centerY(p.r));
    const f2 = gateFoot2(color, p);
    $(`gate-${color}-pos`).textContent = `${cellName(p.c, p.r)}-${cellName(f2.c, f2.r)}`;
  }
}

/* ---------------------------------------------------------------
 * 描画: パックマン
 * ------------------------------------------------------------- */

function buildPackman() {
  layerPackman.innerHTML = '';
  packmanEl = document.createElement('div');
  packmanEl.id = 'packman';
  packmanEl.innerHTML = '<img src="../images/Packman.png" alt="走行体" draggable="false">';
  layerPackman.appendChild(packmanEl);
  packmanEl.addEventListener('pointerdown', startDragPackman);
}

const PAC_SIZE = CELL * 0.82;

function placePackmanAt(x, y, angle) {
  packmanEl.style.width = PAC_SIZE + '%';
  packmanEl.style.height = PAC_SIZE + '%';
  packmanEl.style.left = (x - PAC_SIZE / 2) + '%';
  packmanEl.style.top = (y - PAC_SIZE / 2) + '%';
  packmanEl.style.transform = `rotate(${angle}deg)`;
}

function renderPackman() {
  const p = state.packman;
  placePackmanAt(centerX(p.c), centerY(p.r), state.angle);
  $('pac-pos').textContent = cellName(p.c, p.r);
  $('pac-dir').textContent = DIR_LABEL[p.dir];
}

/* ---------------------------------------------------------------
 * 描画: クッキー
 * ------------------------------------------------------------- */

const COOKIE_SIZE = CELL * 0.34;

function renderCookies() {
  layerCookies.innerHTML = '';
  layerCookies.style.display = state.showCookie ? '' : 'none';
  for (const [k, n] of state.cookies) {
    if (n <= 0) continue;
    const [c, r] = k.split(',').map(Number);
    const el = document.createElement('div');
    el.className = 'cookie';
    el.style.width = COOKIE_SIZE + '%';
    el.style.height = COOKIE_SIZE + '%';
    el.style.left = (centerX(c) - COOKIE_SIZE / 2) + '%';
    el.style.top = (centerY(r) - COOKIE_SIZE / 2) + '%';
    el.innerHTML = `<img src="../images/PackmanCookie.png" alt="">` +
      (n > 1 ? `<span class="count">${n}</span>` : '');
    layerCookies.appendChild(el);
  }
}

/* 通過したマスのクッキーを1つだけ削除する */
function eatCookie(c, r) {
  const k = key(c, r);
  const n = state.cookies.get(k) || 0;
  if (n > 0) state.cookies.set(k, n - 1);
  renderCookies();
}

/* ---------------------------------------------------------------
 * 走行指示の解析
 * ------------------------------------------------------------- */

/* 全角の数字・空白を半角に寄せてから判定する */
function normalizeLine(s) {
  return s
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ')
    .trim();
}

function parseInstructions(text) {
  const lines = text.split(/\r?\n/);
  const cmds = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const s = normalizeLine(lines[i]);
    if (s === '') break;                             // 空行 = 走行指示の終了

    if (s === '左') { cmds.push({ type: 'turn', delta: -1, lineNo, text: s }); continue; }
    if (s === '右') { cmds.push({ type: 'turn', delta: 1, lineNo, text: s }); continue; }

    if (s.startsWith('円弧')) {
      return { error: { lineNo, text: s, kind: 'arc' } };
    }

    if (s.startsWith('直進')) {
      const num = s.slice(2).trim();
      if (/^[0-9]+$/.test(num) && Number(num) > 0) {
        cmds.push({ type: 'straight', n: Number(num), lineNo, text: s });
        continue;
      }
      return { error: { lineNo, text: s, kind: 'straightArg' } };
    }

    /* 「バックN」: 向きを変えずに、向いている方向と逆向きへNマス進む(v2で追加)。
     * 数値の判定ルールは「直進N」と同じ。 */
    if (s.startsWith('バック')) {
      const num = s.slice(3).trim();
      if (/^[0-9]+$/.test(num) && Number(num) > 0) {
        cmds.push({ type: 'back', n: Number(num), lineNo, text: s });
        continue;
      }
      return { error: { lineNo, text: s, kind: 'backArg' } };
    }

    return { error: { lineNo, text: s, kind: 'unknown' } };
  }

  if (cmds.length === 0) return { error: { lineNo: 1, text: '', kind: 'empty' } };
  return { cmds };
}

function errorMessage(err) {
  switch (err.kind) {
    case 'arc':
      return `${err.lineNo}行目「${err.text}」: 円弧の指示は実機の走行指示には存在しますが、本シミュレータでは未対応です。`;
    case 'straightArg':
      return `${err.lineNo}行目「${err.text}」: 走行指示が不適切です。「直進」の後ろには1以上の整数を半角で記載してください。`;
    case 'backArg':
      return `${err.lineNo}行目「${err.text}」: 走行指示が不適切です。「バック」の後ろには1以上の整数を半角で記載してください。`;
    case 'empty':
      return '走行指示が入力されていません。';
    default:
      return `${err.lineNo}行目「${err.text}」: 走行指示が不適切です。「左」「右」「直進N」「バックN」のいずれかを1行に1つ記載してください。`;
  }
}

/* ---------------------------------------------------------------
 * ルートの算出
 * ------------------------------------------------------------- */

function computeRoute(cmds, start, gates) {
  const feet = footMap(gates);
  const mids = middleMap(gates);
  const actions = [];                                // アニメーション用
  const cells = [{ c: start.c, r: start.r }];        // 通過するマス(クッキー配置用)
  let cur = { ...start };
  let stop = null;

  outer:
  for (const cmd of cmds) {
    if (cmd.type === 'turn') {
      cur.dir = (cur.dir + cmd.delta + 4) % 4;
      actions.push({ kind: 'turn', delta: cmd.delta, dir: cur.dir });
      continue;
    }
    /* 「バック」は向きを変えず、向いている方向と逆向きに移動する(v2で追加)。
     * DIR_DELTA は軸(縦/横)に沿ったベクトルなので、符号を反転しても
     * ゲート通過判定の軸判定(下記 movingVertical)には影響しない。 */
    const sign = (cmd.type === 'back') ? -1 : 1;
    for (let k = 0; k < cmd.n; k++) {
      const [dc, dr] = DIR_DELTA[cur.dir];
      const nc = cur.c + dc * sign, nr = cur.r + dr * sign;

      if (!inBounds(nc, nr)) { stop = { kind: 'edge', cmd, done: k }; break outer; }

      const hitColor = feet.get(key(nc, nr));
      if (hitColor) { stop = { kind: 'gate', cmd, done: k, color: hitColor, at: { c: nc, r: nr } }; break outer; }

      cur = { c: nc, r: nr, dir: cur.dir };
      cells.push({ c: nc, r: nr });

      const act = { kind: 'move', c: nc, r: nr };
      const mid = mids.get(key(nc, nr));
      /* 横向きゲートは縦方向に、縦向きゲートは横方向に通過したときだけ「くぐった」とみなす */
      if (mid) {
        const movingVertical = (cur.dir === 0 || cur.dir === 2);
        if ((mid.axis === 'h' && movingVertical) || (mid.axis === 'v' && !movingVertical)) {
          act.pass = mid.color;
        }
      }
      actions.push(act);
    }
  }

  const cookies = new Map();
  for (const cell of cells) {
    const k = key(cell.c, cell.r);
    cookies.set(k, (cookies.get(k) || 0) + 1);
  }

  return { actions, cookies, stop, end: cur };
}

/* ---------------------------------------------------------------
 * 獲得ポイントの算出（競技規約 5.17.3 / 6.4）
 * ------------------------------------------------------------- */

/* 通過したゲートの並びから、周回数と課題ポイントを求める。
 * - 同色の連続通過は1回と見なす
 * - 赤→青→黄 の順に通過して1周回が成立する
 * - 順番を外れた場合は1番目からやり直しとなる
 * - 成立した周回数は累積する */
function rallyScore(passes) {
  const seq = passes.filter((c, i) => i === 0 || c !== passes[i - 1]);
  let laps = 0;
  let step = 0;                                       // 次に通過すべき順番(0=赤)
  for (const color of seq) {
    if (color === RALLY_ORDER[step]) {
      step++;
      if (step === RALLY_ORDER.length) { laps++; step = 0; }
    } else {
      step = (color === RALLY_ORDER[0]) ? 1 : 0;      // 1番目からやり直す
    }
  }
  return {
    laps,
    points: RALLY_POINTS[Math.min(laps, RALLY_MAX_LAPS)],
    max: RALLY_MAX_POINTS
  };
}

function stopMessage(stop) {
  const where = `${stop.cmd.lineNo}行目「${stop.cmd.text}」の${stop.done + 1}マス目`;
  if (stop.kind === 'edge') {
    return { cls: 'warn', text: `コース外に出るため、${where}で停止しました。` };
  }
  return {
    cls: 'err',
    text: `${GATE_DEF[stop.color].name}のゲートの足（${cellName(stop.at.c, stop.at.r)}）に衝突するため、${where}で停止しました。`
  };
}

/* ---------------------------------------------------------------
 * シミュレーション制御
 * ------------------------------------------------------------- */

function setPhase(phase) {
  state.phase = phase;
  const label = { idle: 'シミュレーション開始前', running: 'シミュレーション実行中', finished: 'シミュレーション終了後' };
  $('phase-label').textContent = label[phase];

  const pre = (phase === 'idle');
  document.querySelectorAll('[data-phase-lock="pre"]').forEach((card) => {
    card.querySelectorAll('button, input, textarea').forEach((el) => { el.disabled = !pre; });
  });
  stage.classList.toggle('locked', !pre);

  $('btn-start').disabled = !pre;
  $('btn-replay').disabled = (phase !== 'finished');
  $('btn-reset').disabled = pre;
  $('stage-hint').style.visibility = pre ? '' : 'hidden';
}

function setMessage(text, cls = '') {
  const el = $('message');
  el.textContent = text;
  el.className = 'message ' + cls;
}

function clearGateLog() {
  $('gate-log').innerHTML = '<li class="empty">まだ通過していません</li>';
  state.passes = [];
  renderScore();
}

function logGatePass(color) {
  const ol = $('gate-log');
  const empty = ol.querySelector('.empty');
  if (empty) empty.remove();
  const li = document.createElement('li');
  li.className = 'g-' + color;
  li.textContent = GATE_DEF[color].name;             // 色だけを表示する（赤・黄・青）
  ol.appendChild(li);
  state.passes.push(color);
  renderScore();
}

/* 「現在のポイント / 最大ポイント」の形式で表示する */
function renderScore() {
  const s = rallyScore(state.passes);
  $('score-now').textContent = s.points;
  $('score-max').textContent = s.max;
  $('score-laps').textContent = `${s.laps}周回`;
  document.querySelector('.score-box').classList.toggle('full', s.points >= s.max);
}

function startSimulation() {
  const parsed = parseInstructions($('instructions').value);
  if (parsed.error) {
    setMessage(errorMessage(parsed.error), 'err');
    return;
  }

  /* 実行直前の状態を退避する(「シミュレーションを初期化」で復元する) */
  state.snapshot = {
    gates: structuredClone(state.gates),
    packman: { ...state.packman },
    angle: state.angle,
    instructions: $('instructions').value,
    course: state.course,
    showCoord: state.showCoord,
    showCookie: state.showCookie
  };

  state.route = computeRoute(parsed.cmds, state.packman, state.gates);
  setPhase('running');
  beginRun();
}

function beginRun() {
  const route = state.route;
  state.cookies = new Map(route.cookies);
  state.packman = { ...state.snapshot.packman };
  state.angle = state.snapshot.angle;
  state.stepIndex = 0;

  clearGateLog();
  setMessage('シミュレーションを実行しています…');
  renderPackman();
  renderCookies();
  eatCookie(state.packman.c, state.packman.r);        // 開始マスのクッキーを食べる

  state.timer = setTimeout(runStep, MOVE_MS / state.speed / 2);
}

function runStep() {
  const route = state.route;
  if (state.stepIndex >= route.actions.length) { finishRun(); return; }

  const a = route.actions[state.stepIndex++];
  const dur = (a.kind === 'move' ? MOVE_MS : TURN_MS) / state.speed;
  packmanEl.style.transitionDuration = `${dur}ms, ${dur}ms, ${dur}ms`;

  if (a.kind === 'move') {
    state.packman.c = a.c;
    state.packman.r = a.r;
    renderPackman();
    eatCookie(a.c, a.r);
    if (a.pass) logGatePass(a.pass);
  } else {
    state.packman.dir = a.dir;
    state.angle += a.delta * 90;
    renderPackman();
  }

  state.timer = setTimeout(runStep, dur);
}

function finishRun() {
  state.timer = null;
  setPhase('finished');
  const stop = state.route.stop;
  if (stop) {
    const m = stopMessage(stop);
    setMessage(m.text, m.cls);
  } else {
    setMessage('走行が完了しました。', 'ok');
  }
}

/* 「シミュレーションを初期化」= 実行直前の状態に戻す */
function resetSimulation() {
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  const s = state.snapshot;
  if (s) {
    state.gates = structuredClone(s.gates);
    state.packman = { ...s.packman };
    state.angle = s.angle;
    state.course = s.course;
    state.showCoord = s.showCoord;
    state.showCookie = s.showCookie;
    $('instructions').value = s.instructions;
    $('chk-coord').checked = s.showCoord;
    $('chk-cookie').checked = s.showCookie;
  }
  state.cookies = new Map();
  state.route = null;
  packmanEl.style.transitionDuration = '';
  setPhase('idle');
  setMessage('');
  clearGateLog();
  renderAll();
}

function replaySimulation() {
  if (state.phase !== 'finished') return;
  setPhase('running');
  beginRun();
}

/* ---------------------------------------------------------------
 * ドラッグ＆ドロップ
 * ------------------------------------------------------------- */

/* ポインタ位置を grid-box に対する％に変換する */
function stageFraction(ev) {
  const rect = gridBox.getBoundingClientRect();
  return {
    x: (ev.clientX - rect.left) / rect.width * 100,
    y: (ev.clientY - rect.top) / rect.height * 100
  };
}

/* 足を置ける位置（偶数座標のグレーの丸）をすべて表示する。
 * 他のゲートの足が既にある位置は「使用中」として区別する。 */
function showSlots(color) {
  layerCells.innerHTML = '';
  const size = CELL * 0.42;
  const taken = footMap();
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (c % 2 !== 1 || r % 2 !== 1) continue;      // 0基点なので奇数インデックス=偶数座標
      const el = document.createElement('div');
      el.className = 'slot';
      if (taken.get(key(c, r)) && taken.get(key(c, r)) !== color) el.classList.add('taken');
      el.dataset.pos = key(c, r);
      el.style.width = size + '%';
      el.style.height = size + '%';
      el.style.left = (centerX(c) - size / 2) + '%';
      el.style.top = (centerY(r) - size / 2) + '%';
      layerCells.appendChild(el);
    }
  }
}

/* いまドロップした場合に足が乗る2箇所を強調する。
 * 配置可否の判定に使うのは「2つの足」なので、その両方を同じ状態で示す。 */
function highlightSlot(color, pos) {
  const placeable = !!pos && gateFits(color, pos);
  const feet = [];
  if (pos) {
    const f2 = gateFoot2(color, pos);
    feet.push(key(pos.c, pos.r), key(f2.c, f2.r));
  }
  layerCells.querySelectorAll('.slot').forEach((el) => {
    const isFoot = feet.includes(el.dataset.pos);
    el.classList.toggle('active', isFoot && placeable);
    el.classList.toggle('invalid', isFoot && !placeable);
  });
}

function clearSlots() { layerCells.innerHTML = ''; }

/* 位置(%)から最も近い有効なゲート位置を求める */
function nearestGatePos(color, x, y) {
  let best = null, bestD = Infinity;
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (!isValidGatePos(color, c, r)) continue;
      const d = (centerX(c) - x) ** 2 + (centerY(r) - y) ** 2;
      if (d < bestD) { bestD = d; best = { c, r }; }
    }
  }
  return best;
}

/* 他のゲートと足が重なっていないか */
function gateFits(color, pos) {
  const mine = [key(pos.c, pos.r), key(gateFoot2(color, pos).c, gateFoot2(color, pos).r)];
  for (const other of Object.keys(state.gates)) {
    if (other === color) continue;
    const p = state.gates[other];
    const f2 = gateFoot2(other, p);
    const theirs = [key(p.c, p.r), key(f2.c, f2.r)];
    if (mine.some((k) => theirs.includes(k))) return false;
  }
  return true;
}

function startDragGate(ev, color) {
  if (state.phase !== 'idle') return;
  ev.preventDefault();
  const el = gateEls[color];
  const p = state.gates[color];
  const start = stageFraction(ev);
  const grabDx = start.x - centerX(p.c);
  const grabDy = start.y - centerY(p.r);

  el.classList.add('dragging');
  try { el.setPointerCapture(ev.pointerId); } catch (_) { /* 捕捉できなくてもドラッグは継続する */ }
  showSlots(color);
  highlightSlot(color, p);                            // 掴んだ時点の足を強調しておく

  const onMove = (e) => {
    const f = stageFraction(e);
    const ax = f.x - grabDx, ay = f.y - grabDy;
    placeGateAt(color, ax, ay);
    highlightSlot(color, nearestGatePos(color, ax, ay));
  };

  const onUp = (e) => {
    try { el.releasePointerCapture(ev.pointerId); } catch (_) { /* 未捕捉なら何もしない */ }
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.classList.remove('dragging');
    clearSlots();

    const f = stageFraction(e);
    const near = nearestGatePos(color, f.x - grabDx, f.y - grabDy);
    if (near && gateFits(color, near)) {
      state.gates[color] = near;
      setMessage('');
    } else if (near) {
      setMessage('他のゲートと足が重なるため、その位置には配置できません。', 'warn');
    }
    renderGates();
    ensurePackmanNotOnFoot();
  };

  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
}

/* ゲート移動でパックマンが足の下に取り残されたら、空いているマスへ退避させる */
function ensurePackmanNotOnFoot() {
  const feet = footMap();
  if (!feet.has(key(state.packman.c, state.packman.r))) return;
  for (let d = 1; d < COLS; d++) {
    for (const [dc, dr] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const c = state.packman.c + dc * d, r = state.packman.r + dr * d;
      if (inBounds(c, r) && !feet.has(key(c, r))) {
        state.packman.c = c; state.packman.r = r;
        renderPackman();
        setMessage('ゲートの足と重なるため、走行体を移動しました。', 'warn');
        return;
      }
    }
  }
}

function startDragPackman(ev) {
  if (state.phase !== 'idle') return;
  ev.preventDefault();
  const p = state.packman;
  const start = stageFraction(ev);
  const grabDx = start.x - centerX(p.c);
  const grabDy = start.y - centerY(p.r);
  let moved = false;

  packmanEl.classList.add('dragging');
  try { packmanEl.setPointerCapture(ev.pointerId); } catch (_) { /* 捕捉できなくてもドラッグは継続する */ }

  const onMove = (e) => {
    const f = stageFraction(e);
    if (Math.abs(f.x - start.x) > 1 || Math.abs(f.y - start.y) > 1) moved = true;
    placePackmanAt(f.x - grabDx, f.y - grabDy, state.angle);
  };

  const onUp = (e) => {
    try { packmanEl.releasePointerCapture(ev.pointerId); } catch (_) { /* 未捕捉なら何もしない */ }
    packmanEl.removeEventListener('pointermove', onMove);
    packmanEl.removeEventListener('pointerup', onUp);
    packmanEl.removeEventListener('pointercancel', onUp);
    packmanEl.classList.remove('dragging');

    if (!moved) {                                     // クリック = 右に90度回転
      turnPackman(1);
      return;
    }
    const f = stageFraction(e);
    const c = Math.min(COLS - 1, Math.max(0, Math.round((f.x - grabDx) / CELL - 0.5)));
    const r = Math.min(ROWS - 1, Math.max(0, Math.round((f.y - grabDy) / CELL - 0.5)));
    if (footMap().has(key(c, r))) {
      setMessage('ゲートの足があるマスには置けません。', 'warn');
    } else {
      state.packman.c = c;
      state.packman.r = r;
      setMessage('');
    }
    renderPackman();
  };

  packmanEl.addEventListener('pointermove', onMove);
  packmanEl.addEventListener('pointerup', onUp);
  packmanEl.addEventListener('pointercancel', onUp);
}

function turnPackman(delta) {
  if (state.phase !== 'idle') return;
  state.packman.dir = (state.packman.dir + delta + 4) % 4;
  state.angle += delta * 90;
  renderPackman();
}

/* ---------------------------------------------------------------
 * 画面全体の再描画
 * ------------------------------------------------------------- */

function renderAll() {
  renderCourse();
  renderGates();
  renderPackman();
  renderCookies();
}

/* ---------------------------------------------------------------
 * イベント配線
 * ------------------------------------------------------------- */

function wire() {
  $('btn-course').addEventListener('click', () => {
    state.course = (state.course === 'L') ? 'R' : 'L';
    renderCourse();
  });

  $('chk-coord').addEventListener('change', (e) => {
    state.showCoord = e.target.checked;
    renderCourse();
  });

  $('chk-cookie').addEventListener('change', (e) => {
    state.showCookie = e.target.checked;
    renderCookies();
  });

  $('btn-turn-left').addEventListener('click', () => turnPackman(-1));
  $('btn-turn-right').addEventListener('click', () => turnPackman(1));

  $('btn-gate-init').addEventListener('click', () => {
    state.gates = structuredClone(GATE_INIT);
    renderGates();
    ensurePackmanNotOnFoot();
  });

  $('btn-sample').addEventListener('click', () => { $('instructions').value = SAMPLE_INSTRUCTIONS; });
  $('btn-clear').addEventListener('click', () => { $('instructions').value = ''; });

  $('speed').addEventListener('input', (e) => {
    state.speed = Number(e.target.value);
    $('speed-label').textContent = state.speed.toFixed(2) + ' 倍';
  });

  $('btn-start').addEventListener('click', startSimulation);
  $('btn-reset').addEventListener('click', resetSimulation);
  $('btn-replay').addEventListener('click', replaySimulation);
}

/* ---------------------------------------------------------------
 * 初期化
 * ------------------------------------------------------------- */

function init() {
  state.angle = dirToAngleBase(PACKMAN_INIT.dir);
  buildGates();
  buildPackman();
  $('instructions').value = SAMPLE_INSTRUCTIONS;
  $('speed-label').textContent = state.speed.toFixed(2) + ' 倍';
  wire();
  renderAll();
  renderScore();
  setPhase('idle');
  setMessage('');
}

init();
