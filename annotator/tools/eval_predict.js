// 用 JZ 重新排版标准答案中的每个字，输出预测部件，供 eval_compare.py 比对。
// 用法: node eval_predict.js <library.json> <style.json|none> <gt-chars.json> <out.json> [--pdf 酒狂.pdf] [--grid] [--oracle]
//   --oracle  变体直接取标准答案（经微调层「角色=组件」指定），只评估位置比例
'use strict';
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', 'jz.js'));
const JZ = globalThis.JZ;

const [libPath, stylePath, gtPath, outPath, ...flags] = process.argv.slice(2);
const lib = {};
JSON.parse(fs.readFileSync(libPath, 'utf8')).forEach((s) => { lib[s.name] = s; });
const style = stylePath === 'none' ? null : JSON.parse(fs.readFileSync(stylePath, 'utf8'));
const only = flags.includes('--pdf') ? flags[flags.indexOf('--pdf') + 1] : null;
const env = {
  lib, style: flags.includes('--grid') ? null : style, pageScale: 1,
  natural: (p) => (p.t === 'sym' ? [lib[p.ref].bbox[2], lib[p.ref].bbox[3]] : [38, 38]),
  slot: () => null,
};
const out = [];
for (const c of JSON.parse(fs.readFileSync(gtPath, 'utf8'))) {
  if (!c.sem || (only && c.pdf !== only)) continue;
  if (c.parts.some((p) => p.role === '字') && c.parts.length > 1) continue;
  try {
    const tw = flags.includes('--oracle')
      ? c.parts.filter((p) => p.role && p.role !== '字' && p.role !== '数').map((p) => `${p.role}=${p.name}`).join(' ') : '';
    const ast = JZ.build(env, { sem: c.sem, tw });
    const parts = [];
    JZ.place(env, ast, c.box, parts, c.sem);
    out.push({ ...c, pred: parts.map((o) => ({ role: o.node.role, name: o.part.ref || o.part.ch, box: o.part.r })) });
  } catch (e) {
    out.push({ ...c, pred: [], err: e.message });
  }
}
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(out.length, 'chars predicted,', out.filter((o) => o.err).length, 'errors');
