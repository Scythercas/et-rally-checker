/* script.js のロジックを最小限のDOMスタブ上で実行して検証する */
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
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 550, height: 550 }; }
}

const els = new Map();
const document = {
  getElementById: (id) => { if (!els.has(id)) els.set(id, new FakeEl()); return els.get(id); },
  createElement: (t) => new FakeEl(t),
  querySelectorAll: () => []
};

const ctx = vm.createContext({
  document, structuredClone, console,
  setTimeout: () => 0, clearTimeout: () => {},
  window: {}
});

const src = fs.readFileSync(path.join(PROJ, 'script.js'), 'utf8');
vm.runInContext(src, ctx, { filename: 'script.js' });

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

/* ---------- 1. 走行指示の解析 ---------- */
console.log('\n[1] 走行指示の解析');
const sample = ctx.SAMPLE_INSTRUCTIONS || fs.readFileSync(path.join(PROJ, 'samples/InstructionsSample.txt'), 'utf8');
const p1 = G(sample);
check('サンプルがエラーなく解析できる', !p1.error, JSON.stringify(p1.error));
eq('サンプルの指示数は34', p1.cmds && p1.cmds.length, 34);
eq('1件目は左回転', p1.cmds[0].type + ':' + p1.cmds[0].delta, 'turn:-1');
eq('2件目は直進4', p1.cmds[1].type + ':' + p1.cmds[1].n, 'straight:4');

check('空行で指示が終了する', G('左\n右\n\n直進99').cmds.length === 2);
eq('円弧はarcエラー', G('左\n円弧3').error.kind, 'arc');
eq('直進0はstraightArgエラー', G('直進0').error.kind, 'straightArg');
eq('直進2.5はstraightArgエラー', G('直進2.5').error.kind, 'straightArg');
eq('直進(数値なし)はstraightArgエラー', G('直進').error.kind, 'straightArg');
eq('未知の行はunknownエラー', G('ほげ').error.kind, 'unknown');
eq('空入力はemptyエラー', G('').error.kind, 'empty');
eq('全角数字も受け付ける', G('直進５').cmds[0].n, 5);
eq('前後の空白は無視する', G('  左  ').cmds[0].type, 'turn');

/* ---------- 2. ルート算出(既定条件) ---------- */
console.log('\n[2] ルート算出(A9・右向き / ゲート初期位置)');
const start = { c: 0, r: 8, dir: 1 };
const r1 = R(p1.cmds, start, GATE_INIT);
check('衝突・逸脱の停止が発生する(最後の直進10)', !!r1.stop, JSON.stringify(r1.stop));
eq('停止理由はコース外', r1.stop && r1.stop.kind, 'edge');
eq('停止したのは34行目の直進10', r1.stop.cmd.lineNo + ':' + r1.stop.cmd.text, '34:直進10');

/* 最初の数手を手計算と突き合わせる: 左->上, 直進4 で A9->A5 */
const moves = r1.actions.filter(a => a.kind === 'move');
eq('最初の移動先はA8', nm(moves[0].c, moves[0].r), 'A8');
eq('4手目でA5に到達', nm(moves[3].c, moves[3].r), 'A5');
eq('5手目はB5(右折して東進)', nm(moves[4].c, moves[4].r), 'B5');

/* 全ての移動がコース内かつゲートの足を踏んでいないこと */
const feetKeys = new Set();
for (const [color, p] of Object.entries(GATE_INIT)) {
  const f2 = color === 'blue' ? { c: p.c, r: p.r + 2 } : { c: p.c + 2, r: p.r };
  feetKeys.add(`${p.c},${p.r}`); feetKeys.add(`${f2.c},${f2.r}`);
}
check('全移動先がコース内', moves.every(m => m.c >= 0 && m.c < 11 && m.r >= 0 && m.r < 11));
check('ゲートの足を踏んでいない', moves.every(m => !feetKeys.has(`${m.c},${m.r}`)));

/* クッキーは通過回数と一致する */
const totalCookies = [...r1.cookies.values()].reduce((a, b) => a + b, 0);
eq('クッキー総数 = 開始マス + 移動回数', totalCookies, moves.length + 1);

/* ---------- 3. ゲートへの衝突 ---------- */
console.log('\n[3] ゲートの足への衝突');
/* B2(赤の左足)へ向かって進む: A2 から東へ */
const r2 = R(G('直進3').cmds, { c: 0, r: 1, dir: 1 }, GATE_INIT);
eq('赤の足に衝突して停止', r2.stop.kind, 'gate');
eq('衝突したゲートは赤', r2.stop.color, 'red');
eq('衝突地点はB2', nm(r2.stop.at.c, r2.stop.at.r), 'B2');
eq('衝突前に進めた距離は0マス', r2.stop.done, 0);

/* ---------- 4. ゲートの通過判定 ---------- */
console.log('\n[4] ゲートの通過判定');
/* 赤(B2-D2)の中央はC2。C列を縦に進めばくぐれる */
const r3 = R(G('直進4').cmds, { c: 2, r: 4, dir: 0 }, GATE_INIT);   /* C5から上へ */
const passes3 = r3.actions.filter(a => a.pass).map(a => a.pass);
eq('C列を北上して赤・黄をくぐる', passes3, ['yellow', 'red']);

/* 横向きゲートを横方向に通っても「くぐった」ことにならない */
const r4 = R(G('直進2').cmds, { c: 1, r: 1, dir: 1 }, { red: { c: 5, r: 1 }, yellow: { c: 1, r: 3 }, blue: { c: 1, r: 5 } });
eq('横向きゲートを横切っても通過扱いにしない', r4.actions.filter(a => a.pass).length, 0);

/* 青(B6-B8)の中央はB7。横方向に通ればくぐれる */
const r5 = R(G('直進2').cmds, { c: 0, r: 6, dir: 1 }, GATE_INIT);   /* A7から東へ */
eq('B7を東進して青をくぐる', r5.actions.filter(a => a.pass).map(a => a.pass), ['blue']);

/* 縦向きゲートを縦方向に通っても通過扱いにしない */
const r6 = R(G('直進2').cmds, { c: 1, r: 5, dir: 2 }, { red: { c: 5, r: 1 }, yellow: { c: 5, r: 3 }, blue: { c: 1, r: 5 } });
eq('縦向きゲートの足の上は通れない(衝突)', r6.stop.kind, 'gate');

/* ---------- 5. コース外での停止 ---------- */
console.log('\n[5] コース外での停止');
const r7 = R(G('直進5').cmds, { c: 8, r: 0, dir: 1 }, GATE_INIT);  /* I1から東へ: J,K で端 */
eq('K1まで進んで停止', r7.stop.kind, 'edge');
eq('進めたのは2マス', r7.stop.done, 2);
const mv7 = r7.actions.filter(a => a.kind === 'move');
eq('最終到達はK1', nm(mv7[mv7.length - 1].c, mv7[mv7.length - 1].r), 'K1');

/* ---------- 6. 回転の追従 ---------- */
console.log('\n[6] 回転');
const r8 = R(G('右\n右\n右\n右').cmds, { c: 5, r: 5, dir: 0 }, GATE_INIT);
eq('右4回で元の向きに戻る', r8.actions.map(a => a.dir), [1, 2, 3, 0]);
const r9 = R(G('左\n左').cmds, { c: 5, r: 5, dir: 0 }, GATE_INIT);
eq('左2回で反対向き', r9.actions.map(a => a.dir), [3, 2]);

/* ---------- 7. 描画角度と向きの整合 ---------- */
console.log('\n[7] 描画角度と向きの整合');
/* Packman.png は右向き(dir=1)。回転0度が右を向いていること。 */
const A = ctx.dirToAngleBase;
eq('dir=1(右)は回転0度', A(1), 0);
eq('dir=2(下)は回転90度', A(2), 90);
eq('dir=3(左)は回転180度', A(3), 180);
eq('dir=0(上)は回転-90度', A(0), -90);

/* サンプル走行を通して、累積角度が常に向きと一致し続けること */
let ang = A(start.dir), dir = start.dir, drift = null;
for (const a of r1.actions) {
  if (a.kind !== 'turn') continue;
  ang += a.delta * 90;
  dir = a.dir;
  if ((((ang - A(dir)) % 360) + 360) % 360 !== 0) { drift = { ang, dir }; break; }
}
check('サンプル全体で累積角度と向きがずれない', drift === null, JSON.stringify(drift));

/* ---------- 結果 ---------- */
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
