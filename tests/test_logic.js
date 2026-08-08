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
  set innerHTML(v) { this._html = v; if (v === '') this.children = []; }
  get innerHTML() { return this._html || ''; }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._cls].join(' '); }
  /* 子孫のうちクラス名が一致するものを返す（'.slot' のような単純セレクタのみ対応） */
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
  /* '.score-box' のようなクラス指定を、その名前の擬似要素として返す */
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

const src = fs.readFileSync(path.join(PROJ, 'script.js'), 'utf8');
vm.runInContext(src, ctx, { filename: 'script.js' });

/* script.js の const はグローバルオブジェクトに載らないので、同じコンテキストで取り出す */
vm.runInContext(
  'globalThis.__state = state;' +
  'globalThis.__GATE_INIT = GATE_INIT;' +
  'globalThis.__PACKMAN_INIT = PACKMAN_INIT;' +
  'globalThis.__DIR_LABEL = DIR_LABEL;', ctx);

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
/* ルート算出のテストは既定値の変更に影響されないよう、固定の配置を使う */
const GATE_INIT = { red: { c: 1, r: 1 }, yellow: { c: 1, r: 3 }, blue: { c: 1, r: 5 } };
const COL = 'ABCDEFGHIJK';
const nm = (c, r) => COL[c] + (r + 1);
const span = (color, p) => nm(p.c, p.r) + '-' +
  (color === 'blue' ? nm(p.c, p.r + 2) : nm(p.c + 2, p.r));

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

/* ---------- 8. ゲートの足のハイライト ---------- */
console.log('\n[8] ゲートの足のハイライト');
const cells = els.get('layer-cells');
const slotState = () => {
  const m = {};
  for (const s of cells.querySelectorAll('.slot')) {
    const tags = ['active', 'invalid', 'taken'].filter((t) => s._cls.has(t));
    if (tags.length) m[s.dataset.pos] = tags.join('+');
  }
  return m;
};
/* "c,r" キーをマス名にし、キー順に依存しない形へ正規化する */
const posName = (o) => Object.entries(o)
  .map(([k, v]) => { const [c, r] = k.split(',').map(Number); return nm(c, r) + '=' + v; })
  .sort().join(' ');

/* 既定値に左右されないよう、ハイライトの検証も固定の配置で行う */
ctx.__state.gates = JSON.parse(JSON.stringify(GATE_INIT));

ctx.showSlots('blue');
eq('足の候補は偶数座標の25箇所', cells.querySelectorAll('.slot').length, 25);
eq('他ゲート(赤・黄)の足4箇所がtaken', posName(slotState()),
  'B2=taken B4=taken D2=taken D4=taken');

/* 配置可能な位置(H8)へ動かすと、その2つの足が active になる */
ctx.showSlots('blue');
ctx.highlightSlot('blue', { c: 7, r: 7 });
eq('H8へ配置可: H8とH10の両足がactive', posName(slotState()),
  'B2=taken B4=taken D2=taken D4=taken H10=active H8=active');

/* 黄ゲートの足(D4)と重なる位置へ動かすと、2つの足が invalid になる */
ctx.showSlots('blue');
ctx.highlightSlot('blue', { c: 3, r: 3 });
eq('D4へ配置不可: D4とD6の両足がinvalid', posName(slotState()),
  'B2=taken B4=taken D2=taken D4=invalid+taken D6=invalid');

/* 横向きゲートは左右の足が2列離れる */
ctx.showSlots('red');
ctx.highlightSlot('red', { c: 5, r: 5 });
eq('赤をF6へ: F6とH6の両足がactive', posName(slotState()),
  'B4=taken B6=taken B8=taken D4=taken F6=active H6=active');

/* 掴んでいるゲート自身の足は taken にしない（自分自身とは重ならない） */
ctx.showSlots('blue');
check('自分の足(B6,B8)はtakenにならない', !slotState()['1,5'] && !slotState()['1,7']);

/* ---------- 9. 既定の初期配置 ---------- */
console.log('\n[9] 既定の初期配置');
const PI = ctx.__PACKMAN_INIT, GI = ctx.__GATE_INIT;
eq('パックマンの初期位置はI1', nm(PI.c, PI.r), 'I1');
eq('パックマンの初期向きは左', ctx.__DIR_LABEL[PI.dir], '左');
eq('赤の初期位置はH4-J4', span('red', GI.red), 'H4-J4');
eq('黄の初期位置はF2-H2', span('yellow', GI.yellow), 'F2-H2');
eq('青の初期位置はF4-F6', span('blue', GI.blue), 'F4-F6');

/* 初期配置そのものが仕様どおり成立していること */
for (const [color, p] of Object.entries(GI)) {
  check(`${color}の初期位置は偶数座標かつコース内`, ctx.isValidGatePos(color, p.c, p.r));
}
const initFeet = [];
for (const [color, p] of Object.entries(GI)) {
  initFeet.push(nm(p.c, p.r), color === 'blue' ? nm(p.c, p.r + 2) : nm(p.c + 2, p.r));
}
check('ゲート同士の足が重なっていない', new Set(initFeet).size === initFeet.length, initFeet.join(','));
check('パックマンの初期位置がゲートの足と重なっていない', !initFeet.includes(nm(PI.c, PI.r)));

/* ---------- 10. 獲得ポイント（競技規約 5.17.3 / 6.4） ---------- */
console.log('\n[10] 獲得ポイント');
const S = ctx.rallyScore;
const sc = (arr) => { const r = S(arr); return `${r.points}/${r.max} (${r.laps}周回)`; };

eq('未通過は0点', sc([]), '0/15 (0周回)');
eq('赤青黄で1周回=5点', sc(['red', 'blue', 'yellow']), '5/15 (1周回)');
eq('2周回=10点', sc(['red', 'blue', 'yellow', 'red', 'blue', 'yellow']), '10/15 (2周回)');
eq('3周回=15点', sc(['red', 'blue', 'yellow', 'red', 'blue', 'yellow', 'red', 'blue', 'yellow']), '15/15 (3周回)');
eq('4周回でも上限の15点', sc(Array(4).fill(['red', 'blue', 'yellow']).flat()), '15/15 (4周回)');

/* 同色の連続通過は1回と見なす（規約 5.17.3） */
eq('同色の連続通過は1回扱い', sc(['red', 'red', 'red', 'blue', 'blue', 'yellow']), '5/15 (1周回)');

/* 順番を外れたら1番目からやり直し */
eq('順番違い(赤黄青)は成立しない', sc(['red', 'yellow', 'blue']), '0/15 (0周回)');
eq('やり直して成立する', sc(['red', 'yellow', 'red', 'blue', 'yellow']), '5/15 (1周回)');
eq('青から始まっても赤から数え直す', sc(['blue', 'yellow', 'red', 'blue', 'yellow']), '5/15 (1周回)');
eq('途中で崩れた後に成立', sc(['red', 'blue', 'red', 'blue', 'yellow']), '5/15 (1周回)');
eq('成立後の余分な通過は加点しない', sc(['red', 'blue', 'yellow', 'blue']), '5/15 (1周回)');

/* サンプル走行（既定の初期配置）で最大ポイントに達すること */
const sampleRoute = R(p1.cmds, ctx.__PACKMAN_INIT, ctx.__GATE_INIT);
const samplePasses = sampleRoute.actions.filter((a) => a.pass).map((a) => a.pass);
eq('サンプル走行の通過ゲート', samplePasses.join(''),
  'redblueyellowredblueyellowredblueyellow');
eq('サンプル走行は満点', sc(samplePasses), '15/15 (3周回)');
check('サンプル走行はコース外・衝突で止まらない', !sampleRoute.stop, JSON.stringify(sampleRoute.stop));

/* ---------- 結果 ---------- */
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
