// 从人工微调中泛化排版修正，写入 style.json 的 delta（jz.js 的「学到的修正」层读取它）。
//
// 用法:
//   node learn_manual.js <style.json> <页面目录> [--loco]
//     --loco  不写文件，做「留一列」检验：每次去掉一列，用其余列学习，看被留出那一列还剩多少微调
//
// 每个已能编译的字都算作人工复核过：有微调的原子贡献其偏移/缩放，没有微调的原子贡献 0
// （表示默认位置被认可）。
// 一个字所有部件的平均偏移是「整字平移」—— 字框位置的误差，因字而异、无规律可学，先减掉；
// 只学剩下的部件间相对修正。修正量按上下文由具体到一般汇总（键见 jz.js deltaKeys），
// 每个键取中位数；样本少于 MIN_N 的键不写入。
'use strict';
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', 'jz.js'));
const JZ = globalThis.JZ;

const MIN_N = +(process.env.MIN_N || 4);      // 一个键至少要有这么多样本
const LAMBDA = +(process.env.LAMBDA || 2);    // 收缩：修正量 × n/(n+λ)，样本少的键更保守
const LEVELS = process.env.LEVELS ? process.env.LEVELS.split(',').map(Number) : [0, 1, 2, 3, 4];   // 使用哪些层级的键
const MIN_SHIFT = 0.4;    // pt；更小的偏移视为无
const MIN_LOGS = 0.03;    // |ln 缩放|；更小视为无

const [stylePath, pagesDir, ...flags] = process.argv.slice(2);
const style = JSON.parse(fs.readFileSync(stylePath, 'utf8'));
const lib = {};
JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'library.json'), 'utf8')).forEach((s) => { lib[s.name] = s; });
const env = { lib, style: { ...style, delta: null }, natural: () => [30, 30], slot: () => null };

/* 收集样本：{col, page, keys, dx, dy (pt), ls (ln 缩放)} */
const samples = [];
for (const f of fs.readdirSync(pagesDir).filter((n) => n.endsWith('.jz'))) {
  const page = JZ.parsePage(fs.readFileSync(path.join(pagesDir, f), 'utf8'));
  const k = page.scale || 1;
  JZ.columns(page.chars).forEach((col, ci) => {
    for (const { c } of col) {
      if (c.sem.trim().startsWith('{')) continue;
      let ast;
      try { ast = JZ.build(env, c); } catch { continue; }
      const keys = JZ.deltaKeys(ast);
      const as = JZ.atoms(ast).filter((a) => a.role && !a.role.startsWith('文') && a.role !== '圈' && a.role !== '字');
      if (as.length < 2) continue;   // 单部件的字只有整字平移，没有相对关系可学
      const tx = as.reduce((s, a) => s + a.dx, 0) / as.length, ty = as.reduce((s, a) => s + a.dy, 0) / as.length;
      for (const a of as) {
        samples.push({ page: f, col: ci, ch: `${f}#${c.box.join(',')}`, keys: keys[a.role], dx: (a.dx - tx) / k, dy: (a.dy - ty) / k, ls: Math.log(a.s) });
      }
    }
  });
}

const median = (v) => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function learn(train) {
  const by = {};
  for (const sm of train) sm.keys.forEach((key, li) => { if (LEVELS.includes(li)) (by[key] = by[key] || []).push(sm); });
  const delta = {};
  for (const [key, v] of Object.entries(by)) {
    if (v.length < MIN_N) continue;
    const sh = v.length / (v.length + LAMBDA);
    const dx = sh * median(v.map((x) => x.dx)), dy = sh * median(v.map((x) => x.dy)), ls = sh * median(v.map((x) => x.ls));
    if (Math.hypot(dx, dy) < MIN_SHIFT && Math.abs(ls) < MIN_LOGS) { delta[key] = [0, 0, 1, v.length]; continue; }
    delta[key] = [Math.round(dx * 100) / 100, Math.round(dy * 100) / 100, Math.round(Math.exp(ls) * 1000) / 1000, v.length];
  }
  return delta;
}
const lookupKey = (delta, keys) => { for (const k of keys) if (delta[k]) return k; return '-'; };
const lookup = (delta, keys) => { for (const k of keys) if (delta[k]) return delta[k]; return [0, 0, 1]; };
const stat = (rows) => ({
  shift: rows.reduce((s, r) => s + Math.hypot(r.dx, r.dy), 0) / rows.length,
  scale: rows.reduce((s, r) => s + Math.abs(r.ls), 0) / rows.length,
  touched: rows.filter((r) => Math.hypot(r.dx, r.dy) >= 1 || Math.abs(r.ls) >= 0.05).length,
});

if (flags.includes('--loco')) {
  const before = [], after = [];
  const cols = [...new Set(samples.map((s) => `${s.page}#${s.col}`))];
  for (const col of cols) {
    const test = samples.filter((s) => `${s.page}#${s.col}` === col);
    const delta = learn(samples.filter((s) => `${s.page}#${s.col}` !== col));
    // 残差也扣掉每个字的平均平移（整字平移归字框，不算排版误差）
    const byCh = {};
    for (const s of test) {
      const d = lookup(delta, s.keys);
      (byCh[s.ch] = byCh[s.ch] || []).push({ s, r: { dx: s.dx - d[0], dy: s.dy - d[1], ls: s.ls - Math.log(d[2]) } });
    }
    for (const rows of Object.values(byCh)) {
      const mx = rows.reduce((t, x) => t + x.r.dx, 0) / rows.length, my = rows.reduce((t, x) => t + x.r.dy, 0) / rows.length;
      for (const { s, r } of rows) { before.push(s); after.push({ dx: r.dx - mx, dy: r.dy - my, ls: r.ls, role: s.keys[s.keys.length - 1], key: lookupKey(delta, s.keys) }); }
    }
  }
  const b = stat(before), a = stat(after);
  console.log(`原子 ${before.length} 个（${cols.length} 列，留一列检验）`);
  console.log(`  平均偏移   ${b.shift.toFixed(2)} pt → ${a.shift.toFixed(2)} pt`);
  console.log(`  平均|ln缩放| ${b.scale.toFixed(3)} → ${a.scale.toFixed(3)}`);
  console.log(`  仍需微调（偏移 ≥1pt 或缩放 ≥5%）的原子 ${b.touched} → ${a.touched}`);
  if (flags.includes('--detail')) {
    const g = {};
    before.forEach((s, i) => { const r = after[i].role; (g[r] = g[r] || [[], []]); g[r][0].push(s); g[r][1].push(after[i]); });
    for (const [r, [bb, aa]] of Object.entries(g)) console.log(`  ${r.padEnd(4)} n=${bb.length}  偏移 ${stat(bb).shift.toFixed(2)} → ${stat(aa).shift.toFixed(2)}  缩放 ${stat(bb).scale.toFixed(3)} → ${stat(aa).scale.toFixed(3)}`);
  }
} else {
  style.delta = learn(samples);
  fs.writeFileSync(stylePath, JSON.stringify(style, null, 0).replace(/\],"/g, '],\n"'));
  const used = Object.entries(style.delta).filter(([, d]) => d[0] || d[1] || d[2] !== 1);
  console.log(`${samples.length} 个原子 → ${Object.keys(style.delta).length} 个键，其中非零修正 ${used.length} 个：`);
  for (const [k, d] of used) console.log(`  ${k.padEnd(18)} dx ${d[0]}  dy ${d[1]}  ×${d[2]}  (n=${d[3]})`);
}
