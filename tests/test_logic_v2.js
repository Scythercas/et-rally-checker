/* v2/script.js のロジックを最小限のDOMスタブ上で実行して検証する。
 * 無印版(tests/test_logic.js)との差分である「バックN」を中心に検証し、
 * 既存ロジック(直進・回転・停止・ゲート通過)に回帰がないことも合わせて確認する。 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const PROJ = path.join(__dirname, '..');

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = tag; this.style = {}; this.dataset = {}; this.children = [];
    this._cls = new Set(); this.innerHTML = ''; this.textContent = ''; this.value = '';
    this.checked = true; this.disabled = false;
    this.classList = {
      add: (c) => this._cls.add(c), remove: (c) => this._cls.delete(c),
      contains: (c) => this._cls.has(c),
      toggle: (c, on) => { on ? this._cls.add(c) : this._cls.delete(c); }
    };
  }
  addEventListener() {} removeEventListener() {}
  setPointerCapture() {} releasePointerCapture() {}
  appendChild(c) { this.children.push(c); return c; }
  remove() {}
  set innerHTML(v) { this._html = v; if (v === '') this.children = []; }
  get innerHTML() { return this._html || ''; }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._cls].join(' '); }
  querySelectorAll(sel) {
    const cls = String(sel).replace(/^\./, '');
    const out = [];
    const walk = (n) => n.children.forEach((c) => { if (c._cls.has(cls)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 550, height: 550 }; }
}

const els = new Map();
const document = {
  getElementById: (id) => { if (!els.has(id)) els.set(id, new FakeEl()); return els.get(id); },
  createElement: (t) => new FakeEl(t),
  querySelectorAll: () => [],
  querySelector: (sel) => {
    const k = 'sel:' + sel;
    if (!els.has(k)) els.set(k, new FakeEl());
    return els.get(k);
  }
};

const ctx = vm.createContext({
  document, structuredClone, console,
  setTimeout: () => 0, clearTimeout: () => {},
  window: {}
});

const src = fs.readFileSync(path.join(PROJ, 'v2/script.js'), 'utf8');
vm.runInContext(src, ctx, { filename: 'v2/script.js' });

vm.runInContext(
  'globalThis.__state = state;' +
  'globalThis.__GATE_INIT = GATE_INIT;' +
  'globalThis.__PACKMAN_INIT = PACKMAN_INIT;' +
  'globalThis.__DIR_LABEL = DIR_LABEL;' +
  'globalThis.__SAMPLE_INSTRUCTIONS = SAMPLE_INSTRUCTIONS;', ctx);

/* ---------- テスト基盤 ---------- */
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(name, a === e, `actual=${a} expected=${e}`);
}

const G = ctx.parseInstructions, R = ctx.computeRoute;
const GATE_INIT = { red: { c: 1, r: 1 }, yellow: { c: 1, r: 3 }, blue: { c: 1, r: 5 } };
const COL = 'ABCDEFGHIJK';
const nm = (c, r) => COL[c] + (r + 1);

/* ---------- 1. 「バックN」の解析 ---------- */
console.log('\n[1] 「バックN」走行指示の解析');
eq('バック6はback:6と解析される', (() => { const p = G('バック6'); return p.cmds[0].type + ':' + p.cmds[0].n; })(), 'back:6');
eq('バック0はbackArgエラー', G('バック0').error.kind, 'backArg');
eq('バック-1はbackArgエラー', G('バック-1').error.kind, 'backArg');
eq('バック2.5はbackArgエラー', G('バック2.5').error.kind, 'backArg');
eq('バック(数値なし)はbackArgエラー', G('バック').error.kind, 'backArg');
eq('全角数字も受け付ける', G('バック５').cmds[0].n, 5);
eq('前後の空白は無視する', G('  バック3  ').cmds[0].type, 'back');
check('直進とバックを混在できる', !G('直進2\nバック1').error);

/* ---------- 2. バック走行時のルート算出 ---------- */
console.log('\n[2] バック走行時のルート算出(向きを維持したまま逆方向へ移動)');

/* 右向き(dir=1)でC5からバック2 -> 見た目は左向きに2マス進み、A5に到達。向きは右のまま。 */
const rb1 = R(G('バック2').cmds, { c: 2, r: 4, dir: 1 }, GATE_INIT);
check('バック走行で停止しない', !rb1.stop, JSON.stringify(rb1.stop));
eq('バック2マスでA5に到達', nm(rb1.end.c, rb1.end.r), 'A5');
eq('向き(dir)は移動後も右のまま', rb1.end.dir, 1);
check('回転(turn)アクションは発生しない', rb1.actions.every((a) => a.kind !== 'turn'));
const mvB1 = rb1.actions.filter((a) => a.kind === 'move');
eq('1マス目はB5(右向きの逆=左へ)', nm(mvB1[0].c, mvB1[0].r), 'B5');
eq('2マス目はA5', nm(mvB1[1].c, mvB1[1].r), 'A5');

/* 直進と組み合わせても、向きに変化がないことを確認 */
const rb2 = R(G('直進2\nバック2').cmds, { c: 2, r: 4, dir: 1 }, GATE_INIT);
eq('直進2+バック2で元の位置(C5)に戻る', nm(rb2.end.c, rb2.end.r), 'C5');
eq('向きは右のまま', rb2.end.dir, 1);

/* クッキーは通過したマス(開始マス含む)の回数と一致する */
const totalCookiesB = [...rb1.cookies.values()].reduce((a, b) => a + b, 0);
eq('バック走行でもクッキー総数=開始マス+移動回数', totalCookiesB, mvB1.length + 1);

/* ---------- 3. バック走行でのコース外・ゲート衝突 ---------- */
console.log('\n[3] バック走行でのコース外・ゲート足への衝突');

/* B1(右向き)からバック3: A1で端に達して2マスで停止(K方向ではなくA方向) */
const rb3 = R(G('バック3').cmds, { c: 1, r: 0, dir: 1 }, GATE_INIT);
eq('コース外に出るため2マスで停止', rb3.stop && rb3.stop.kind + ':' + rb3.stop.done, 'edge:1');

/* 赤の足(B2)へ向かってバックで衝突させる: C2で右向きのままバック1すると、逆方向(左)のB2で赤の足に衝突する */
const rb4 = R(G('バック1').cmds, { c: 2, r: 1, dir: 1 }, GATE_INIT);
eq('赤の足に衝突して停止', rb4.stop && rb4.stop.kind + ':' + rb4.stop.color, 'gate:red');
eq('衝突地点はB2', nm(rb4.stop.at.c, rb4.stop.at.r), 'B2');
eq('衝突前に進めた距離は0マス', rb4.stop.done, 0);

/* ---------- 4. バック走行でのゲート通過判定 ---------- */
console.log('\n[4] バック走行でのゲート通過判定(軸は向きで決まり、前進・後退で変わらない)');

/* 赤(B2-D2)の中央はC2。下向き(dir=2)のままC3からバック1すると、実際には上へ後退してC2に至る。
 * 軸判定は縦(movingVertical)のままなので、横向きゲート(赤)の通過とみなされる。 */
const rb5 = R(G('バック1').cmds, { c: 2, r: 2, dir: 2 }, GATE_INIT);
const passesB5 = rb5.actions.filter((a) => a.pass).map((a) => a.pass);
eq('下向きのままバック1、C3からC2へ後退して赤をくぐる', passesB5, ['red']);
eq('向き(dir)は下のまま', rb5.end.dir, 2);

/* 前進で同じセルを通過した場合と同じ結果になることを確認(対称性の回帰確認) */
const rf5 = R(G('直進1').cmds, { c: 2, r: 2, dir: 0 }, GATE_INIT); /* C3から上向きへ直進 */
eq('直進での通過判定は従来どおり(赤)', rf5.actions.filter((a) => a.pass).map((a) => a.pass), ['red']);

/* ---------- 5. 既存ロジックの回帰確認(直進・回転・角度) ---------- */
console.log('\n[5] 既存ロジックの回帰確認');
const sample = ctx.__SAMPLE_INSTRUCTIONS;
const p1 = G(sample);
check('サンプル(直進のみ)がエラーなく解析できる', !p1.error, JSON.stringify(p1.error));
const r1 = R(p1.cmds, ctx.__PACKMAN_INIT, ctx.__GATE_INIT);
const samplePasses = r1.actions.filter((a) => a.pass).map((a) => a.pass);
eq('サンプル走行の通過ゲート(v1と同じ結果)', samplePasses.join(''),
  'redblueyellowredblueyellowredblueyellow');
check('サンプル走行はコース外・衝突で止まらない', !r1.stop, JSON.stringify(r1.stop));

const A = ctx.dirToAngleBase;
eq('dir=1(右)は回転0度', A(1), 0);
eq('dir=3(左)は回転180度', A(3), 180);

const r8 = R(G('右\n右\n右\n右').cmds, { c: 5, r: 5, dir: 0 }, GATE_INIT);
eq('右4回で元の向きに戻る(turnは従来どおり)', r8.actions.map((a) => a.dir), [1, 2, 3, 0]);

/* ---------- 6. 既定の初期配置(無印版と同じ) ---------- */
console.log('\n[6] 既定の初期配置');
const PI = ctx.__PACKMAN_INIT;
eq('パックマンの初期位置はI1', nm(PI.c, PI.r), 'I1');
eq('パックマンの初期向きは左', ctx.__DIR_LABEL[PI.dir], '左');

/* ---------- 結果 ---------- */
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
