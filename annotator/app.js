'use strict';
/* 减字谱标注器。页面数据为 data/pages/<id>.jz（语法见 JZ.md），每个减字两层：
 *   sem 语义层（如「名十勾四」）——决定是什么字；
 *   tw  微调层（如「弦~1,-2 /40」）——只改位置、大小与变体。
 * 画面上的部件全部由 JZ.build + JZ.layout 实时生成；拖动/缩放部件只改写微调层。
 */
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const GLYPH_PX = 0.042;   // 字形 1000 单位 → 页面像素（1em ≈ 42px，约等于标准字高）

const S = {
  lib: [], env: null, userLib: [], font: null, glyphs: {},
  pageId: null, page: null, sel: { ci: -1, ai: -1 }, mode: 'select',
  view: { x: 0, y: 0, k: 1 }, undo: [], redo: [], dirty: false, clipboard: null,
  mouse: [0, 0], libCat: '全部', built: [],
};

/* ---------- 组件与字形 ---------- */
function glyph(ch) {
  if (S.glyphs[ch]) return S.glyphs[ch];
  if (!S.font) return { d: '', bbox: [0, -800, 1000, 1000] };
  const p = S.font.getPath(ch, 0, 0, 1000), b = p.getBoundingBox();
  return (S.glyphs[ch] = { d: p.toPathData(2), bbox: [b.x1, b.y1, (b.x2 - b.x1) || 1, (b.y2 - b.y1) || 1] });
}
function polyBBox(poly) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}
function intersect(a, b) {
  const x = Math.max(a[0], b[0]), y = Math.max(a[1], b[1]);
  return [x, y, Math.max(1, Math.min(a[0] + a[2], b[0] + b[2]) - x), Math.max(1, Math.min(a[1] + a[3], b[1] + b[3]) - y)];
}
function srcBBox(p) {
  if (p.t === 'sym') return S.env.lib[p.ref].bbox;
  if (p.t === 'glyph') { const g = glyph(p.ch); return p.clip ? intersect(g.bbox, polyBBox(p.clip)) : g.bbox; }
  return [0, 0, 1, 1];
}
function makeEnv() {
  const lib = {};
  S.lib.forEach((s) => { lib[s.name] = s; });
  S.userLib.forEach((u) => { lib[u.name] = { ...u, get bbox() { return srcBBox({ t: 'glyph', ch: u.ch, clip: u.clip }); } }; });
  return {
    lib,
    natural(p) {
      const b = srcBBox(p), k = S.page ? S.page.scale || 1 : 1;
      return p.t === 'sym' ? [b[2] * k, b[3] * k] : [b[2] * GLYPH_PX * k, b[3] * GLYPH_PX * k];
    },
    slot: () => null,
  };
}
const DIGITS = '一二三四五六七八九十';
function categoryOf(name) {
  const f = JZ.familyOf(name) || '';
  if (f.startsWith('数')) return '数字';
  if (['名', '大', '食'].includes(f)) return '左手';
  if (f) return '右手';
  return '其他';
}

/* ---------- 编译与排版 ---------- */
function buildAll() {
  S.built = S.page.chars.map((c) => {
    try {
      const ast = JZ.build(S.env, c), out = [];
      JZ.layout(S.env, ast, c.box, out);
      return { ast, out, err: null };
    } catch (e) { return { ast: null, out: [], err: e.message }; }
  });
}
function charBox(ci) { return S.page.chars[ci].box; }

/* ---------- 渲染 ---------- */
let clipSeq = 0;
function partMarkup(p, fill) {
  const [x, y, w, h] = p.r;
  if (p.t === 'circle') {
    const sw = Math.max(0.8, w * 0.09);
    return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${Math.max(0.1, w / 2 - sw / 2)}" ry="${Math.max(0.1, h / 2 - sw / 2)}" fill="none" stroke="${fill}" stroke-width="${sw}"/>`;
  }
  const b = srcBBox(p), sx = w / b[2], sy = h / b[3];
  const tf = `translate(${x - b[0] * sx} ${y - b[1] * sy}) scale(${sx} ${sy})`;
  if (p.t === 'sym') {
    const s = S.env.lib[p.ref];
    let m = `<g transform="${tf}"><path d="${s.d}" fill-rule="${s.rule}" fill="${fill}"/>`;
    if (s.sd) m += `<path d="${s.sd}" fill="none" stroke="${fill}" stroke-width="${s.sw}"/>`;
    return m + '</g>';
  }
  const g = glyph(p.ch);
  if (!p.clip) return `<g transform="${tf}"><path d="${g.d}" fill="${fill}"/></g>`;
  const id = 'clip' + (++clipSeq);
  return `<g transform="${tf}"><clipPath id="${id}"><polygon points="${p.clip.map((q) => q.join(',')).join(' ')}"/></clipPath>` +
    `<path d="${g.d}" fill="${fill}" clip-path="url(#${id})"/></g>`;
}
function render() {
  const pg = S.page; if (!pg) return;
  buildAll();
  const red = $('#redMode').checked, fill = red ? '#e0201c' : '#111';
  clipSeq = 0;
  let vec = '';
  S.built.forEach((b) => b.out.forEach((o) => { vec += partMarkup(o.part, fill); }));
  const vg = $('#vec');
  vg.innerHTML = vec;
  vg.style.opacity = $('#vecOp').value;
  vg.style.mixBlendMode = red ? 'multiply' : 'normal';
  $('#scan').style.opacity = $('#scanOp').value;

  const sw = 1 / S.view.k, show = $('#showBoxes').checked;
  let ui = '';
  pg.chars.forEach((c, ci) => {
    const [x, y, w, h] = c.box, b = S.built[ci], selC = S.sel.ci === ci;
    if (show || selC || b.err) {
      const col = b.err ? 'var(--danger)' : selC ? 'var(--accent)' : c.ok ? 'var(--ok)' : 'var(--ai)';
      ui += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${b.err ? 'rgba(192,57,43,.15)' : 'none'}" stroke="${col}" stroke-width="${(selC ? 2 : 1) * sw}" ${c.ok || selC ? '' : `stroke-dasharray="${4 * sw} ${3 * sw}"`}/>`;
      if (c.note) ui += `<circle cx="${x + w}" cy="${y}" r="${3.5 * sw}" fill="var(--danger)"/>`;
    }
    ui += `<rect class="hit" data-ci="${ci}" data-ai="-1" x="${x}" y="${y}" width="${w}" height="${h}" fill="transparent"/>`;
    if (selC) b.out.forEach((o, ai) => {
      const r = o.part.r;
      ui += `<rect class="hit" data-ci="${ci}" data-ai="${ai}" x="${r[0]}" y="${r[1]}" width="${Math.max(r[2], 3)}" height="${Math.max(r[3], 3)}" fill="transparent" stroke="rgba(47,111,214,.35)" stroke-width="${sw}"/>`;
    });
  });
  const sr = selRect();
  if (sr) {
    if (S.sel.ai >= 0) {
      const slot = S.built[S.sel.ci].out[S.sel.ai].slotRect;
      ui += `<rect x="${slot[0]}" y="${slot[1]}" width="${slot[2]}" height="${slot[3]}" fill="none" stroke="var(--ok)" stroke-dasharray="${2 * sw} ${2 * sw}" stroke-width="${sw}"/>`;
      ui += `<rect x="${sr[0]}" y="${sr[1]}" width="${sr[2]}" height="${sr[3]}" fill="none" stroke="var(--accent)" stroke-width="${sw}"/>`;
    }
    const hs = 7 * sw;
    for (const [hx, hy, id] of handles(sr)) {
      if (S.sel.ai >= 0 && id.length === 1) continue;   // 部件只能等比缩放
      ui += `<rect class="handle" data-h="${id}" x="${hx - hs / 2}" y="${hy - hs / 2}" width="${hs}" height="${hs}" fill="#fff" stroke="var(--accent)" stroke-width="${sw}" style="cursor:${id}-resize"/>`;
    }
  }
  if (S.drawBox) {
    const [x, y, w, h] = S.drawBox;
    ui += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(47,111,214,.1)" stroke="var(--accent)" stroke-width="${sw}"/>`;
  }
  $('#ui').innerHTML = ui;
  applyView();
}
function handles([x, y, w, h]) {
  return [[x, y, 'nw'], [x + w / 2, y, 'n'], [x + w, y, 'ne'], [x + w, y + h / 2, 'e'],
    [x + w, y + h, 'se'], [x + w / 2, y + h, 's'], [x, y + h, 'sw'], [x, y + h / 2, 'w']];
}
function selRect() {
  const { ci, ai } = S.sel; if (ci < 0 || !S.page.chars[ci]) return null;
  if (ai >= 0) { const o = S.built[ci].out[ai]; return o ? o.part.r : null; }
  return charBox(ci);
}
function applyView() { const { x, y, k } = S.view; $('#world').setAttribute('transform', `translate(${x} ${y}) scale(${k})`); }
function fitView() {
  const el = $('#canvas').getBoundingClientRect(), [w, h] = S.page.size;
  const k = Math.min(el.width / w, el.height / h) * 0.96;
  S.view = { k, x: (el.width - w * k) / 2, y: (el.height - h * k) / 2 };
  render();
}
function viewRect([x, y, w, h]) {
  const el = $('#canvas').getBoundingClientRect(), k = Math.min(el.width / w, el.height / h);
  S.view = { k, x: (el.width - w * k) / 2 - x * k, y: (el.height - h * k) / 2 - y * k };
}
function centerOn(r) {
  const el = $('#canvas').getBoundingClientRect(), k = S.view.k;
  const cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2, sx = cx * k + S.view.x, sy = cy * k + S.view.y;
  if (sx < 60 || sx > el.width - 60 || sy < 60 || sy > el.height - 60) { S.view.x = el.width / 2 - cx * k; S.view.y = el.height / 2 - cy * k; }
}

/* ---------- 面板 ---------- */
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function partName(p) { return p.t === 'sym' ? p.ref : p.t === 'glyph' ? (p.ref || p.ch) : '○'; }
function thumb(p, size = 44) {
  if (p.t === 'circle') return `<svg viewBox="0 0 10 10" height="${size}"><circle cx="5" cy="5" r="4" fill="none" stroke="#111"/></svg>`;
  const b = srcBBox(p), pad = Math.max(b[2], b[3]) * 0.08;
  return `<svg viewBox="${[b[0] - pad, b[1] - pad, b[2] + 2 * pad, b[3] + 2 * pad].join(' ')}" height="${size}">${partMarkup({ ...p, r: b }, '#111')}</svg>`;
}
function panels() {
  const pg = S.page; if (!pg) return;
  const n = pg.chars.length, ok = pg.chars.filter((c) => c.ok).length;
  const errs = S.built.filter((b) => b.err).length, notes = pg.chars.filter((c) => c.note).length;
  $('#pageInfo').innerHTML = `<h3>${esc(S.pageId)}</h3>
    <div class="muted">${n} 个字 · 已校对 ${ok} · 待查 ${n - ok}${notes ? ` · <span style="color:var(--danger)">●</span> 备注 ${notes}` : ''}${errs ? ` · <b style="color:var(--danger)">语法错误 ${errs}</b>` : ''}</div>
    <div class="row"><label class="muted">符号比例 pt→px <input id="scaleIn" type="number" step="0.01" value="${pg.scale}" style="width:70px"></label></div>`;
  $('#scaleIn').onchange = (e) => commit(() => { pg.scale = +e.target.value || 1; });

  const c = pg.chars[S.sel.ci];
  if (!c) { $('#charPanel').innerHTML = '<div class="muted">未选中字。单击画面上的字，或用「新字框」拖出一个。</div>'; $('#partPanel').innerHTML = ''; return; }
  const b = S.built[S.sel.ci];
  $('#charPanel').innerHTML = `<h3>减字 #${S.sel.ci + 1} <span class="chip ${c.ok ? 'ok' : 'ai'}">${c.ok ? '已校对' : '待校对'}</span></h3>
    <label class="muted">语义层</label>
    <div class="row"><input id="cSem" type="text" value="${esc(c.sem)}" placeholder="如：名十勾四 / 散挑七 / '引上十'" style="flex:1;font-size:16px"></div>
    <label class="muted">微调层（只影响位置与变体）</label>
    <div class="row"><input id="cTw" type="text" value="${esc(c.tw)}" placeholder="如：弦~1,-2 徽*0.9 /40" style="flex:1;font-family:ui-monospace,monospace"></div>
    ${b.err ? `<div style="color:var(--danger)">${esc(b.err)}</div>` : `<div class="muted" style="font-family:ui-monospace,monospace">结构：${esc(JZ.fmt(b.ast))}</div>`}
    <textarea id="cNote" rows="2" placeholder="备注（不确定之处；有备注的字显示红点）">${esc(c.note)}</textarea>
    <ul class="parts">${b.out.map((o, i) => `<li data-ai="${i}" class="${i === S.sel.ai ? 'sel' : ''}">${thumb(o.part, 20)}<span>${esc(o.node.role || '')}</span><span class="muted">${esc(partName(o.part))}</span></li>`).join('')}</ul>
    <div class="row"><button id="cStatus">${c.ok ? '改回待校对' : '标为已校对 ⏎'}</button><button id="cTwClear">清除微调</button><button id="cDel" class="danger">删除此字</button></div>`;
  $('#cSem').onchange = (e) => commit(() => { c.sem = e.target.value.trim(); });
  $('#cTw').onchange = (e) => commit(() => { c.tw = e.target.value.trim(); });
  $('#cNote').onchange = (e) => commit(() => { c.note = e.target.value.trim(); });
  $('#cStatus').onclick = toggleStatus;
  $('#cTwClear').onclick = () => commit(() => { c.tw = ''; });
  $('#cDel').onclick = deleteSel;
  document.querySelectorAll('.parts li').forEach((li) => { li.onclick = () => { S.sel.ai = +li.dataset.ai; refresh(); }; });

  const o = b.out[S.sel.ai];
  if (!o) { $('#partPanel').innerHTML = ''; return; }
  const a = o.node, p = o.part, nat = p.t === 'circle' ? p.r.slice(2) : S.env.natural(p);
  let html = `<h3>部件「${esc(a.role)}」：${esc(partName(p))}${a.forced ? '（指定）' : ''}</h3>
    <div class="muted">设计原大 ${nat[0].toFixed(1)}×${nat[1].toFixed(1)}，当前 ${Math.round(p.r[3] / nat[1] * 100)}%；偏移 ${a.dx},${a.dy} 缩放 ${a.s}</div>
    <div class="row"><button id="pReset" title="R">清除此部件微调</button>${a.forced ? '<button id="pAuto">恢复自动变体</button>' : ''}${p.t === 'glyph' ? '<button id="pClip">裁切成新组件…</button>' : ''}</div>`;
  const vars = variantsOf(a, p);
  if (vars.length > 1) {
    html += `<div class="muted">尺寸变体（[ / ] 切换；点选即写入微调层「${esc(a.role)}=…」）</div><div class="variants">` +
      vars.map((v, i) => `<div class="tile ${partName(v) === partName(p) ? 'cur' : ''}" data-vi="${i}" title="${esc(partName(v))}">${thumb(v)}<span>${esc(partName(v))}</span></div>`).join('') + '</div>';
  }
  $('#partPanel').innerHTML = html;
  $('#pReset').onclick = resetAtom;
  if ($('#pAuto')) $('#pAuto').onclick = () => editAtom((x) => { x.forced = false; });
  if ($('#pClip')) $('#pClip').onclick = () => openClip(p);
  document.querySelectorAll('#partPanel .tile').forEach((t) => { t.onclick = () => forceVariant(vars[+t.dataset.vi]); });
}
function variantsOf(a, p) {
  const name = p.t === 'sym' ? p.ref : a.v;
  const fam = JZ.familyOf(name) || (p.t === 'glyph' && DIGITS.includes(p.ch) ? '数' + (DIGITS.indexOf(p.ch) + 1) : null);
  if (!fam) return [];
  const out = Object.keys(S.env.lib).filter((nm) => JZ.familyOf(nm) === fam).map((nm) => ({ t: 'sym', ref: nm }));
  if (fam.startsWith('数')) out.push({ t: 'glyph', ch: DIGITS[+fam.slice(1) - 1] });
  return out;
}

/* ---------- 微调层编辑：改 AST 原子，再写回 c.tw ---------- */
function editAtom(fn) {
  const { ci, ai } = S.sel, c = S.page.chars[ci], b = S.built[ci];
  if (!b || !b.out[ai]) return;
  commit(() => {
    const atom = b.out[ai].node;
    fn(atom);
    if (!atom.forced) { const o = originalAtom(c, atom.role); atom.v = o.v; atom.q = o.q; }
    c.tw = JZ.tweaksOf(b.ast);
  });
}
function originalAtom(c, role) {
  return JZ.atoms(JZ.compile(S.env, c.sem)).find((x) => x.role === role) || { v: '', q: false };
}
function forceVariant(v) {
  editAtom((a) => { a.forced = true; if (v.t === 'glyph') { a.v = v.ch; a.q = true; } else { a.v = v.ref; a.q = false; } });
}
function cycleVariant(dir) {
  const o = S.built[S.sel.ci] && S.built[S.sel.ci].out[S.sel.ai]; if (!o) return;
  const vars = variantsOf(o.node, o.part); if (vars.length < 2) return;
  const i = vars.findIndex((v) => partName(v) === partName(o.part));
  forceVariant(vars[(i + dir + vars.length) % vars.length]);
}
function resetAtom() { editAtom((a) => { a.dx = 0; a.dy = 0; a.s = 1; }); }

/* ---------- 编辑操作 ---------- */
const r1 = (v) => Math.round(v * 10) / 10;
function snapshot() { return JSON.stringify(S.page); }
function pushUndo() { S.undo.push(snapshot()); if (S.undo.length > 300) S.undo.shift(); S.redo = []; }
function commit(fn) { pushUndo(); fn(); markDirty(); refresh(); }
function markDirty() { S.dirty = true; status(); }
function refresh() { render(); panels(); }
function status(msg) { const el = $('#status'); el.textContent = msg || (S.dirty ? '有未保存的修改' : '已保存'); el.className = S.dirty ? 'dirty' : ''; }
function undo() { if (!S.undo.length) return; S.redo.push(snapshot()); S.page = JSON.parse(S.undo.pop()); fixSel(); markDirty(); refresh(); }
function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); S.page = JSON.parse(S.redo.pop()); fixSel(); markDirty(); refresh(); }
function fixSel() { if (!S.page.chars[S.sel.ci]) S.sel = { ci: -1, ai: -1 }; }
function deleteSel() {
  if (S.sel.ci < 0) return;
  commit(() => { S.page.chars.splice(S.sel.ci, 1); S.sel = { ci: -1, ai: -1 }; });
}
function toggleStatus() { const c = S.page.chars[S.sel.ci]; if (c) commit(() => { c.ok = !c.ok; }); }
function nudge(dx, dy) {
  const c = S.page.chars[S.sel.ci]; if (!c) return;
  if (S.sel.ai >= 0) editAtom((a) => { a.dx = r1(a.dx + dx); a.dy = r1(a.dy + dy); });
  else commit(() => { c.box[0] = r1(c.box[0] + dx); c.box[1] = r1(c.box[1] + dy); });
}
function readingOrder() { return JZ.columns(S.page.chars).flat().map((it) => it.i); }
function step(dir) {
  const order = readingOrder(); if (!order.length) return;
  const at = order.indexOf(S.sel.ci), ci = order[(at + dir + order.length) % order.length];
  S.sel = { ci, ai: -1 }; centerOn(charBox(ci)); refresh();
  if (document.activeElement) document.activeElement.blur();
}

/* ---------- 指针交互 ---------- */
function toWorld(ev) {
  const el = $('#canvas').getBoundingClientRect();
  return [(ev.clientX - el.left - S.view.x) / S.view.k, (ev.clientY - el.top - S.view.y) / S.view.k];
}
let drag = null, spaceDown = false;
function onDown(ev) {
  if (ev.button === 1 || spaceDown) { startPan(ev); return; }
  const t = ev.target, pt = toWorld(ev);
  if (t.classList.contains('handle')) {
    pushUndo();
    const { ci, ai } = S.sel, c = S.page.chars[ci];
    drag = { kind: 'resize', h: t.dataset.h, rect: selRect().slice(), box: c.box.slice(), atom: ai >= 0 ? S.built[ci].out[ai].node : null, s0: ai >= 0 ? S.built[ci].out[ai].node.s : 1, moved: false };
  } else if (t.classList.contains('hit')) {
    const ci = +t.dataset.ci, ai = +t.dataset.ai;
    if (S.sel.ci !== ci) S.sel = { ci, ai: -1 }; else if (ai >= 0) S.sel.ai = ai;
    pushUndo();
    drag = { kind: 'move', last: pt, moved: false, atom: S.sel.ai >= 0 ? S.built[ci].out[S.sel.ai].node : null };
    refresh();
  } else if (S.mode === 'box') {
    drag = { kind: 'box', start: pt };
  } else { S.sel = { ci: -1, ai: -1 }; refresh(); startPan(ev); return; }
  $('#canvas').setPointerCapture(ev.pointerId);
}
function startPan(ev) {
  drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vx: S.view.x, vy: S.view.y };
  $('#canvas').classList.add('panning'); $('#canvas').setPointerCapture(ev.pointerId);
}
function writeAtom(atom) { const c = S.page.chars[S.sel.ci]; c.tw = JZ.tweaksOf(S.built[S.sel.ci].ast); }
function onMove(ev) {
  const pt = toWorld(ev); S.mouse = pt;
  if (!drag) return;
  if (drag.kind === 'pan') { S.view.x = drag.vx + ev.clientX - drag.sx; S.view.y = drag.vy + ev.clientY - drag.sy; applyView(); return; }
  const c = S.page.chars[S.sel.ci];
  if (drag.kind === 'move') {
    const dx = pt[0] - drag.last[0], dy = pt[1] - drag.last[1];
    if (!drag.moved && Math.hypot(dx, dy) * S.view.k < 3) return;
    drag.moved = true; drag.last = pt;
    if (drag.atom) {
      const a = S.built[S.sel.ci].out[S.sel.ai].node;
      a.dx = r1(a.dx + dx); a.dy = r1(a.dy + dy); writeAtom(a);
    } else { c.box[0] = r1(c.box[0] + dx); c.box[1] = r1(c.box[1] + dy); }
    render();
  } else if (drag.kind === 'resize') {
    drag.moved = true;
    const [x, y, w, h] = drag.rect, hd = drag.h;
    let x1 = x, y1 = y, x2 = x + w, y2 = y + h;
    if (hd.includes('w')) x1 = pt[0]; if (hd.includes('e')) x2 = pt[0];
    if (hd.includes('n')) y1 = pt[1]; if (hd.includes('s')) y2 = pt[1];
    if (drag.atom) {   // 部件：等比，改 *s
      const f = Math.max((x2 - x1) / w, (y2 - y1) / h);
      const a = S.built[S.sel.ci].out[S.sel.ai].node;
      a.s = Math.max(0.2, Math.round(drag.s0 * f * 100) / 100); writeAtom(a);
    } else c.box = [x1, y1, Math.max(4, x2 - x1), Math.max(4, y2 - y1)].map(r1);
    render();
  } else if (drag.kind === 'box') {
    const [a, b] = [drag.start, pt];
    S.drawBox = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])];
    render();
  }
}
function onUp() {
  if (!drag) return;
  const d = drag; drag = null;
  $('#canvas').classList.remove('panning');
  if (d.kind === 'move' || d.kind === 'resize') { if (d.moved) markDirty(); else S.undo.pop(); refresh(); }
  else if (d.kind === 'box') {
    const b = S.drawBox; S.drawBox = null;
    if (b && b[2] > 4 && b[3] > 4) {
      commit(() => { S.page.chars.push({ sem: '四', tw: '', box: b.map(r1), ok: false, note: '' }); S.sel = { ci: S.page.chars.length - 1, ai: -1 }; });
      setMode('select'); setTimeout(() => { $('#cSem').focus(); $('#cSem').select(); });
    } else render();
  }
}
function onWheel(ev) {
  ev.preventDefault();
  const el = $('#canvas').getBoundingClientRect();
  if (ev.ctrlKey || ev.metaKey) {
    const f = Math.exp(-ev.deltaY * 0.01), mx = ev.clientX - el.left, my = ev.clientY - el.top;
    const k = Math.min(40, Math.max(0.2, S.view.k * f));
    S.view.x = mx - (mx - S.view.x) * (k / S.view.k); S.view.y = my - (my - S.view.y) * (k / S.view.k); S.view.k = k;
  } else { S.view.x -= ev.deltaX; S.view.y -= ev.deltaY; }
  render();
}
function setMode(m) {
  S.mode = m;
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('#canvas').classList.toggle('boxmode', m === 'box');
}
function onKey(ev) {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || $('#clipDlg').open;
  const mod = ev.metaKey || ev.ctrlKey, key = ev.key.toLowerCase();
  if (mod && key === 's') { ev.preventDefault(); save(); return; }
  if (typing) {
    if (ev.key === 'Escape') document.activeElement.blur();
    if (ev.key === 'Tab' && document.activeElement.id === 'cTw') { ev.preventDefault(); document.activeElement.dispatchEvent(new Event('change')); step(ev.shiftKey ? -1 : 1); }
    return;
  }
  if (ev.key === ' ') { spaceDown = true; ev.preventDefault(); return; }
  if (mod && key === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if (mod && key === 'c') { copySel(); return; }
  if (mod && key === 'v') { paste(S.mouse); return; }
  if (mod && key === 'd') { ev.preventDefault(); copySel(); paste(null); return; }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[ev.key] && S.sel.ci >= 0) {
    ev.preventDefault();
    const m = ev.shiftKey ? 10 : ev.altKey ? 0.2 : 1;
    nudge(arrows[ev.key][0] * m, arrows[ev.key][1] * m); return;
  }
  switch (ev.key) {
    case 'Escape': if (S.sel.ai >= 0) S.sel.ai = -1; else S.sel = { ci: -1, ai: -1 }; setMode('select'); refresh(); break;
    case 'Delete': case 'Backspace': if (S.sel.ai >= 0) resetAtom(); else deleteSel(); break;
    case 'Tab': ev.preventDefault(); step(ev.shiftKey ? -1 : 1); break;
    case 'Enter': toggleStatus(); break;
    case 'e': case 'E': if (S.sel.ci >= 0) { ev.preventDefault(); $('#cSem').focus(); $('#cSem').select(); } break;
    case '[': cycleVariant(-1); break;
    case ']': cycleVariant(1); break;
    case 'r': case 'R': resetAtom(); break;
    case 'v': case 'V': setMode('select'); break;
    case 'b': case 'B': setMode('box'); break;
    case '0': fitView(); break;
  }
}
function copySel() { const c = S.page.chars[S.sel.ci]; if (c) { S.clipboard = JSON.parse(JSON.stringify(c)); status('已复制'); } }
function paste(at) {
  if (!S.clipboard) return;
  const c = JSON.parse(JSON.stringify(S.clipboard)); c.ok = false;
  if (at) { c.box[0] = r1(at[0] - c.box[2] / 2); c.box[1] = r1(at[1] - c.box[3] / 2); } else { c.box[0] += 8; c.box[1] += 8; }
  commit(() => { S.page.chars.push(c); S.sel = { ci: S.page.chars.length - 1, ai: -1 }; });
}

/* ---------- 组件库 ---------- */
function libPanel() {
  const cats = ['全部', '数字', '左手', '右手', '其他', '自制'];
  $('#libTabs').innerHTML = cats.map((c) => `<button class="${c === S.libCat ? 'on' : ''}" data-c="${c}">${c}</button>`).join('');
  document.querySelectorAll('#libTabs button').forEach((b) => { b.onclick = () => { S.libCat = b.dataset.c; libPanel(); }; });
  const q = $('#libSearch').value.trim();
  const items = [
    ...S.lib.map((s) => ({ name: s.name, cat: categoryOf(s.name), part: { t: 'sym', ref: s.name } })),
    ...S.userLib.map((u) => ({ name: u.name, cat: '自制', part: { t: 'glyph', ch: u.ch, clip: u.clip, ref: u.name } })),
  ].filter((it) => (S.libCat === '全部' || it.cat === S.libCat) && (!q || it.name.includes(q)));
  $('#libGrid').innerHTML = items.map((it, i) => `<div class="tile" data-i="${i}" title="${esc(it.name)}">${thumb(it.part)}<span>${esc(it.name)}</span></div>`).join('');
  document.querySelectorAll('#libGrid .tile').forEach((t) => {
    t.onclick = () => {
      const it = items[+t.dataset.i];
      if (S.sel.ai >= 0) editAtom((a) => { a.v = it.name; a.forced = true; });   // 选中部件时：指定为此变体
      else { navigator.clipboard && navigator.clipboard.writeText(it.name); status(`组件名「${it.name}」已复制`); }
    };
  });
}

/* ---------- 裁切：从字形拆出偏旁，存为自制组件 ---------- */
let clipState = null;
function openClip(p) {
  const g = glyph(p.ch), [bx, by, bw, bh] = g.bbox, pad = 60;
  const poly = p.clip ? p.clip.map((q) => q.slice()) : [[bx - 20, by - 20], [bx + bw + 20, by - 20], [bx + bw + 20, by + bh + 20], [bx - 20, by + bh + 20]];
  clipState = { p, poly, vb: [bx - pad, by - pad, bw + 2 * pad, bh + 2 * pad], drag: -1 };
  $('#clipCh').textContent = p.ch; $('#clipName').value = '';
  drawClip(); $('#clipDlg').showModal();
}
function drawClip() {
  const { p, poly, vb } = clipState, g = glyph(p.ch), u = vb[2] / 420, pts = poly.map((q) => q.join(',')).join(' ');
  $('#clipSvg').setAttribute('viewBox', vb.join(' '));
  $('#clipSvg').innerHTML = `<path d="${g.d}" fill="#ccc"/><clipPath id="dlgClip"><polygon points="${pts}"/></clipPath>
    <path d="${g.d}" fill="#111" clip-path="url(#dlgClip)"/>
    <polygon points="${pts}" fill="rgba(47,111,214,.08)" stroke="#2f6fd6" stroke-width="${1.5 * u}"/>
    ${poly.map((q, i) => `<circle data-v="${i}" cx="${q[0]}" cy="${q[1]}" r="${6 * u}" fill="#fff" stroke="#2f6fd6" stroke-width="${1.5 * u}" style="cursor:move"/>`).join('')}`;
}
function clipPt(ev) {
  const r = $('#clipSvg').getBoundingClientRect(), vb = clipState.vb;
  return [vb[0] + (ev.clientX - r.left) / r.width * vb[2], vb[1] + (ev.clientY - r.top) / r.height * vb[3]].map(Math.round);
}
function initClip() {
  const svg = $('#clipSvg');
  svg.addEventListener('pointerdown', (ev) => {
    const v = ev.target.dataset && ev.target.dataset.v, pt = clipPt(ev), poly = clipState.poly;
    if (v !== undefined) {
      if (ev.altKey && poly.length > 3) { poly.splice(+v, 1); drawClip(); return; }
      clipState.drag = +v; svg.setPointerCapture(ev.pointerId); return;
    }
    let bi = 0, bd = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      const d = (a[0] + t * dx - pt[0]) ** 2 + (a[1] + t * dy - pt[1]) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    poly.splice(bi + 1, 0, pt); clipState.drag = bi + 1; drawClip(); svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener('pointermove', (ev) => { if (clipState && clipState.drag >= 0) { clipState.poly[clipState.drag] = clipPt(ev); drawClip(); } });
  svg.addEventListener('pointerup', () => { if (clipState) clipState.drag = -1; });
  $('#clipReset').onclick = () => { openClip({ ch: clipState.p.ch }); };
  $('#clipCancel').onclick = () => $('#clipDlg').close();
  $('#clipApply').onclick = $('#clipSaveLib').onclick = async () => {
    const name = $('#clipName').value.trim();
    if (!name || name.length < 2) { $('#clipName').focus(); status('组件名至少两个字，避免与单字混淆'); return; }
    S.userLib = S.userLib.filter((u) => u.name !== name);
    S.userLib.push({ name, ch: clipState.p.ch, clip: clipState.poly.map((q) => q.slice()) });
    await post('data/library-user.json', JSON.stringify(S.userLib, null, 1));
    S.env = makeEnv(); libPanel();
    $('#clipDlg').close();
    if (S.sel.ai >= 0) editAtom((a) => { a.v = name; a.forced = true; });
    status(`已存入组件库：${name}`);
  };
}

/* ---------- 读写 ---------- */
async function getText(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); return r.text(); }
async function getJSON(url, dflt) { try { return JSON.parse(await getText(url)); } catch { return dflt; } }
async function post(path, text) {
  const r = await fetch('/api/save?path=' + encodeURIComponent(path), { method: 'POST', body: text });
  if (!r.ok) throw new Error(await r.text());
}
async function save() {
  try { await post(`data/pages/${S.pageId}.jz`, JZ.serializePage(S.page)); S.dirty = false; status('已保存 ' + new Date().toLocaleTimeString()); }
  catch (e) { status('保存失败：' + e.message); }
}
async function loadPage(id) {
  if (S.dirty && !confirm('当前页有未保存的修改，确定切换？')) { $('#pageSel').value = S.pageId; return; }
  S.pageId = id;
  const pg = JZ.parsePage(await getText(`data/pages/${id}.jz`));
  if (pg.errors.length) alert(pg.errors.join('\n'));
  delete pg.errors;
  S.page = pg;
  S.undo = []; S.redo = []; S.dirty = false; S.sel = { ci: -1, ai: -1 };
  const img = $('#scan');
  img.setAttribute('href', pg.scan); img.setAttribute('width', pg.size[0]); img.setAttribute('height', pg.size[1]);
  history.replaceState(null, '', '?' + new URLSearchParams({ ...Object.fromEntries(params), page: id }));
  status(); fitView(); panels();
}
function exportSVG() {
  const [w, h] = S.page.size;
  clipSeq = 0;
  let body = '';
  S.page.chars.forEach((c, i) => { body += `<g data-sem="${esc(c.sem)}">${S.built[i].out.map((o) => partMarkup(o.part, '#000')).join('')}</g>\n`; });
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n${body}</svg>\n`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); a.download = `${S.pageId}.svg`; a.click();
}

/* ---------- 启动 ---------- */
async function main() {
  S.lib = await getJSON('data/library.json', []);
  S.userLib = await getJSON('data/library-user.json', []);
  try { S.font = await opentype.load('/font/main.ttf'); } catch (e) { status('字体加载失败：' + e); }
  S.env = makeEnv();

  const svg = $('#canvas');
  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', (e) => { if (e.key === ' ') spaceDown = false; });
  window.addEventListener('resize', render);
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  document.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
  ['#scanOp', '#vecOp', '#redMode', '#showBoxes'].forEach((s) => { $(s).oninput = render; });
  $('#undoBtn').onclick = undo; $('#redoBtn').onclick = redo; $('#fitBtn').onclick = fitView;
  $('#saveBtn').onclick = save; $('#exportBtn').onclick = exportSVG;
  $('#libSearch').oninput = libPanel;
  initClip();

  // 截图模式：?shot=1&view=x,y,w,h&red=0&boxes=0&scanop=1&vecop=1
  if (params.get('shot')) document.body.classList.add('shot');
  if (params.has('red')) $('#redMode').checked = params.get('red') === '1';
  if (params.has('boxes')) $('#showBoxes').checked = params.get('boxes') === '1';
  if (params.has('scanop')) $('#scanOp').value = params.get('scanop');
  if (params.has('vecop')) $('#vecOp').value = params.get('vecop');

  const pages = await getJSON('/api/pages', []);
  $('#pageSel').innerHTML = pages.map((p) => `<option>${esc(p)}</option>`).join('');
  $('#pageSel').onchange = (e) => loadPage(e.target.value);
  libPanel();
  const want = params.get('page') || pages[0];
  if (want) { $('#pageSel').value = want; await loadPage(want); }
  if (params.get('view')) { viewRect(params.get('view').split(',').map(Number)); render(); }
  document.body.dataset.ready = '1';
}
main();
