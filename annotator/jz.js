'use strict';
/* JZ 减字描述语言：解析、排版、序列化。语法说明见 JZ.md。
 * 纯函数，不依赖 DOM；组件库与字体通过 env 传入：
 *   env.lib[name]       → {bbox, slot?}       符号库组件（含自制组件）
 *   env.natural(part)   → [w, h]              部件设计原大（页面像素）
 *   env.slot(part)      → [x, y, w, h]        包围类部件的内框（相对其外框的 0–1 比例）
 */
(function (root) {
  const DIGITS = '一二三四五六七八九十';
  const FAMILIES = ['勾', '挑', '抹', '打', '剔', '摘', '历', '托', '轮', '蠲', '名', '大', '食'];
  const PREC = { '+': 1, '/': 2, '|': 3, in: 4, atom: 5 };

  /* ---------- 词法 ---------- */
  function tokenize(s) {
    const out = [];
    let i = 0;
    const num = (re) => { const m = s.slice(i).match(re); if (m) i += m[0].length; return m; };
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if ('()[]+'.includes(c)) { out.push({ t: c }); i++; continue; }
      if (c === '/' || c === '|') { i++; const m = num(/^\d+(\.\d+)?/); out.push({ t: c, r: m ? +m[0] / 100 : null }); continue; }
      if (c === '~') { i++; const m = num(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/); if (!m) throw new Error('「~」后应为 dx,dy'); out.push({ t: '~', dx: +m[1], dy: +m[2] }); continue; }
      if (c === '*') { i++; const m = num(/^\d+(\.\d+)?/); if (!m) throw new Error('「*」后应为缩放倍数'); out.push({ t: '*', s: +m[0] }); continue; }
      if (c === "'") { const j = s.indexOf("'", i + 1); if (j < 0) throw new Error('引号未闭合'); out.push({ t: 'name', v: s.slice(i + 1, j), q: true }); i = j + 1; continue; }
      let j = i;
      while (j < s.length && !/[\s()[\]+/|~*']/.test(s[j])) j++;
      out.push({ t: 'name', v: s.slice(i, j) }); i = j;
    }
    return out;
  }

  /* ---------- 语法：+ 叠放 < / 上下 < | 左右 < X[Y] 包围 ---------- */
  function parse(src) {
    const toks = tokenize(src);
    let p = 0;
    const peek = () => toks[p], next = () => toks[p++];
    const expect = (t) => { const k = next(); if (!k || k.t !== t) throw new Error(`缺少「${t}」`); };
    function bin(op, sub) {
      return () => {
        let a = sub();
        while (peek() && peek().t === op) { const r = next().r; a = { k: op, a, b: sub(), r: op === '+' ? null : r }; }
        return a;
      };
    }
    function post() {
      let a = prim();
      while (peek() && peek().t === '[') { next(); const b = over(); expect(']'); a = { k: 'in', a, b }; }
      return a;
    }
    function prim() {
      const k = next();
      if (!k) throw new Error('表达式不完整');
      if (k.t === '(') { const e = over(); expect(')'); return e; }
      if (k.t !== 'name' || !k.v) throw new Error(`意外的「${k.t}」`);
      const n = { k: 'atom', v: k.v, q: !!k.q, dx: 0, dy: 0, s: 1 };
      while (peek() && (peek().t === '~' || peek().t === '*')) {
        const m = next();
        if (m.t === '~') { n.dx = m.dx; n.dy = m.dy; } else n.s = m.s;
      }
      return n;
    }
    const row = bin('|', post), stack = bin('/', row), over = bin('+', stack);
    const e = over();
    if (p < toks.length) throw new Error(`多余的「${toks[p].t === 'name' ? toks[p].v : toks[p].t}」`);
    return e;
  }

  /* ---------- 序列化 ---------- */
  const n1 = (v) => String(Math.round(v * 10) / 10);
  function fmt(n, parent = 0) {
    let s;
    if (n.k === 'atom') {
      s = n.q ? `'${n.v}'` : n.v;
      if (n.dx || n.dy) s += `~${n1(n.dx)},${n1(n.dy)}`;
      if (n.s !== 1) s += `*${Math.round(n.s * 100) / 100}`;
    } else if (n.k === 'in') {
      s = `${fmt(n.a, PREC.in)}[${fmt(n.b, 0)}]`;
    } else {
      const op = n.k + (n.r != null ? Math.round(n.r * 100) : '');
      const sep = n.k === '|' && n.r == null ? '' : ' ';
      s = `${fmt(n.a, PREC[n.k])}${sep}${op}${sep}${fmt(n.b, PREC[n.k] + 1)}`;
    }
    return PREC[n.k] < parent ? `(${s})` : s;
  }
  function atoms(n, out = []) {
    if (n.k === 'atom') out.push(n); else { atoms(n.a, out); atoms(n.b, out); }
    return out;
  }

  /* ---------- 原子 → 候选部件 ---------- */
  function digitOf(name) {
    if (name.length === 1 && DIGITS.includes(name)) return DIGITS.indexOf(name) + 1;
    let m = name.match(/^上(\d+)$/); if (m) return +m[1];
    m = name.match(/^小(\d)\d?$/); if (m) return +m[1];
    return 0;
  }
  function familyOf(name) {
    const d = digitOf(name); if (d) return '数' + d;
    const m = name.match(/^(名|大|食)\d$/); if (m) return m[1];
    if (name === '扁打摘') return '摘';
    for (const f of FAMILIES) if (name.includes(f)) return f;
    return null;
  }
  function familyMembers(env, fam) {
    const out = Object.keys(env.lib).filter((nm) => familyOf(nm) === fam && !NO_AUTO.test(nm)).map((nm) => ({ t: 'sym', ref: nm }));
    if (fam.startsWith('数')) out.push({ t: 'glyph', ch: DIGITS[+fam.slice(1) - 1] });
    return out;
  }
  /* 返回 {cands, auto}；auto=true 表示由排版按格子大小挑选变体 */
  function resolve(env, atom) {
    const v = atom.v;
    if (atom.q) return { cands: [{ t: 'glyph', ch: v }], auto: false };
    if (v === '○') return { cands: [{ t: 'circle' }], auto: false };
    const exact = () => (env.lib[v].clip ? { t: 'glyph', ch: env.lib[v].ch, clip: env.lib[v].clip, ref: v } : { t: 'sym', ref: v });
    if (atom.forced && env.lib[v]) return { cands: [exact()], auto: false };
    const d = digitOf(v);
    if (d && v.length === 1) return { cands: familyMembers(env, '数' + d), auto: true };
    if (FAMILIES.includes(v)) { const c = familyMembers(env, v); if (c.length) return { cands: c, auto: true }; }
    if (env.lib[v]) return { cands: [exact()], auto: false };
    if ([...v].length === 1) return { cands: [{ t: 'glyph', ch: v }], auto: false };
    throw new Error(`未知组件「${v}」`);
  }
  function defaultCand(env, atom) {
    const { cands } = resolve(env, atom);
    return cands.find((c) => c.ref && c.ref.startsWith('标准')) || cands.find((c) => c.ref === atom.v) ||
      cands.find((c) => c.ref && /^(名|大|食)1$/.test(c.ref)) || cands[0];
  }
  function pick(env, cands, w, h) {
    let best = cands[0], bd = Infinity;
    for (const c of cands) {
      const [nw, nh] = env.natural(c);
      const k = Math.min(w / nw, h / nh);             // 放进格子所需的缩放
      const d = Math.abs(Math.log(k)) + 0.6 * Math.abs(Math.log((nw / nh) / (w / h)));
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  /* ---------- 排版 ---------- */
  function natural(env, n) {
    if (n.k === 'atom') { const c = defaultCand(env, n); return c.t === 'circle' ? [12, 12] : env.natural(c); }
    if (n.k === 'in' || n.k === '+') return natural(env, n.a);
    const a = natural(env, n.a), b = natural(env, n.b);
    return n.k === '/' ? [Math.max(a[0], b[0]), a[1] + b[1]] : [a[0] + b[0], Math.max(a[1], b[1])];
  }
  /* 把节点 n 排进矩形 rect，部件追加到 out；返回实际占用外框 */
  function layout(env, n, rect, out) {
    const [x, y, w, h] = rect;
    if (n.k === 'atom') {
      const { cands, auto } = resolve(env, n);
      const part = auto ? pick(env, cands, w, h) : cands[0];
      let pw, ph;
      if (part.t === 'circle') { pw = ph = Math.min(w, h); }
      else { const [nw, nh] = env.natural(part); const k = Math.min(w / nw, h / nh); pw = nw * k; ph = nh * k; }
      pw *= n.s; ph *= n.s;
      const r = [x + (w - pw) / 2 + n.dx, y + (h - ph) / 2 + n.dy, pw, ph];
      out.push({ node: n, part: { ...part, r }, slotRect: rect });
      return r;
    }
    if (n.k === 'in') {
      const R = layout(env, n.a, rect, out);
      const outer = out[out.length - 1].part;
      const fam = outer.ref && familyOf(outer.ref);
      const s = (env.slot && env.slot(outer)) || SLOTS[fam] || [0.2, 0.2, 0.6, 0.6];
      layout(env, n.b, [R[0] + s[0] * R[2], R[1] + s[1] * R[3], s[2] * R[2], s[3] * R[3]], out);
      return R;
    }
    if (n.k === '+') { layout(env, n.a, rect, out); layout(env, n.b, rect, out); return rect; }
    const na = natural(env, n.a), nb = natural(env, n.b);
    if (n.k === '/') {
      const r = n.r ?? na[1] / (na[1] + nb[1]);
      layout(env, n.a, [x, y, w, h * r], out); layout(env, n.b, [x, y + h * r, w, h * (1 - r)], out);
    } else {
      const r = n.r ?? na[0] / (na[0] + nb[0]);
      layout(env, n.a, [x, y, w * r, h], out); layout(env, n.b, [x + w * r, y, w * (1 - r), h], out);
    }
    return rect;
  }

  /* ---------- 语义层 → 结构 ----------
   * 一个减字 = [散] [左手指 徽 [分]] [右手指法 弦]，或单独的弦数 / 术语 / 'text'。
   * 结构由下列规则生成；每个原子带角色名（指 徽 分 散 法 弦 数 字 圈 文N），供微调层引用。
   */
  const LEX = {
    LH: { 大: '大', 食: '食', 中: '中', 名: '名', 跪: '跪' },
    RH: ['勾', '挑', '抹', '打', '剔', '摘', '历', '托', '轮', '蠲', '扶', '拨', '刺', '撮', '伏', '滚', '拂', '泼', '剌'],
  };
  const RH_GLYPH = { 扶: '夫' };   // 没有专门组件、借字形书写的指法
  const NUMS = ['十一', '十二', '十三', ...DIGITS];
  // 右手指法如何与弦数组合：in = 指法包住弦数（用组件的 slot），below = 弦数在下
  const ATTACH = { 抹: 'below', 轮: 'below', 蠲: 'below', 挑: 'above' };
  // 包围类指法的内框（相对组件外框的比例 x,y,w,h），按字形目测
  const SLOTS = {
    勾: [0.02, 0.36, 0.7, 0.6], 打: [0.02, 0.3, 0.66, 0.66], 剔: [0.08, 0.52, 0.6, 0.46],
    摘: [0.2, 0.45, 0.55, 0.52], 历: [0.32, 0.3, 0.68, 0.66], 托: [0.32, 0.38, 0.64, 0.58],
  };
  const NO_AUTO = /^(侧|窄侧)/;   // 特殊位置用的变体，只能用「=」指定
  function semTokens(s) {
    const words = [...NUMS, ...Object.keys(LEX.LH), ...LEX.RH, '散', '分', '○', '。'];
    const out = [];
    let i = 0;
    while (i < s.length) {
      if (/\s/.test(s[i])) { i++; continue; }
      if (s[i] === "'") { const j = s.indexOf("'", i + 1); if (j < 0) throw new Error('引号未闭合'); out.push({ t: 'text', v: s.slice(i + 1, j) }); i = j + 1; continue; }
      let w = words.filter((x) => s.startsWith(x, i)).sort((a, b) => b.length - a.length)[0];
      let t;
      if (w) t = NUMS.includes(w) ? 'num' : LEX.LH[w] ? 'lh' : LEX.RH.includes(w) ? 'rh' : w;
      else {   // 其余：最长匹配的组件名，否则单个字
        w = (semTokens.libNames || []).filter((x) => s.startsWith(x, i)).sort((a, b) => b.length - a.length)[0] || s[i];
        t = 'word';
      }
      out.push({ t, v: w }); i += w.length;
    }
    return out;
  }
  const A = (v, role, q = false) => ({ k: 'atom', v, q, role, dx: 0, dy: 0, s: 1 });
  function numAtom(v, role) {
    // 十一～十三：十在上、个位在下
    if (v.length === 2) return { k: '/', a: A('十', role + '十'), b: A(v[1], role), r: null };
    return A(v, role);
  }
  function compile(env, sem) {
    sem = sem.trim();
    if (sem.startsWith('{') && sem.endsWith('}')) {   // 逃生口：直接写结构
      const ast = parse(sem.slice(1, -1));
      atoms(ast).forEach((a, i) => { a.role = '#' + (i + 1); });
      return ast;
    }
    semTokens.libNames = Object.keys(env.lib).filter((n) => n.length > 1);
    const tk = semTokens(sem);
    if (!tk.length) throw new Error('语义为空');
    if (tk.length === 1 && tk[0].t === 'text') {
      const chars = [...tk[0].v];
      let n = A(chars[0], '文1', true);
      for (let i = 1; i < chars.length; i++) n = { k: '/', a: n, b: A(chars[i], '文' + (i + 1), true), r: null };
      return n;
    }
    if (tk[0].t === '。' && tk.length === 1) return A('○', '圈');
    // 小字注、术语序列（三作、引上十…）：不套减字结构，竖排堆叠
    if (tk.length > 1 && tk.every((t) => ['num', 'word', 'text'].includes(t.t))) {
      const parts = tk.flatMap((t) => (t.t === 'text' ? [...t.v].map((c) => ({ v: c, q: true })) : [{ v: t.v, q: false }]));
      let n = A(parts[0].v, '文1', parts[0].q);
      for (let i = 1; i < parts.length; i++) n = { k: '/', a: n, b: A(parts[i].v, '文' + (i + 1), parts[i].q), r: null };
      return n;
    }
    if (tk[0].t === '○') {
      const inner = tk.slice(1).map((t) => t.v).join('');
      return { k: 'in', a: A('○', '圈'), b: A(inner, '字', true) };
    }
    let p = 0;
    const at = (t) => tk[p] && tk[p].t === t;
    let top = null, bottom = null;
    if (at('散')) { top = A('散', '散'); p++; }
    if (at('lh')) {
      const lh = A(LEX.LH[tk[p].v], '指'); p++;
      if (at('num')) {
        let hui = numAtom(tk[p].v, '徽'); p++;
        if (at('num') && tk[p + 1] && tk[p + 1].t === '分') { hui = { k: '/', a: hui, b: numAtom(tk[p].v, '分'), r: null }; p += 2; }
        top = { k: '|', a: lh, b: hui, r: null };
      } else top = lh;   // 只写左手指，不写徽位
    } else if (at('num') && tk[p + 1] && tk[p + 1].t === 'rh') {   // 省略左手指，只写徽位（沿用前一指）
      top = numAtom(tk[p].v, '徽'); p++;
    }
    if (at('rh')) {
      const fam = tk[p].v, rh = A(RH_GLYPH[fam] || fam, '法', !!RH_GLYPH[fam]); p++;
      if (at('num')) {
        const xian = numAtom(tk[p].v, '弦'); p++;
        bottom = ATTACH[fam] === 'below' ? { k: '/', a: rh, b: xian, r: null }
          : ATTACH[fam] === 'above' ? { k: '/', a: xian, b: rh, r: null } : { k: 'in', a: rh, b: xian };
      } else bottom = rh;
    } else if (!top && at('num')) { bottom = numAtom(tk[p].v, '数'); p++; }
    else if (!top && at('word')) { bottom = A(tk[p].v, '字'); p++; }
    if (p < tk.length) throw new Error(`无法放入减字结构：「${tk.slice(p).map((t) => t.v).join('')}」（可用 {结构} 直接写）`);
    if (top && bottom) return { k: '/', a: top, b: bottom, r: null };
    return top || bottom;
  }

  /* ---------- 微调层：只改位置与变体，不改语义 ----------
   *   角色~dx,dy   角色*倍数   角色=变体名   /比例（上下分割，百分比）   |比例（上半左右分割）
   */
  function applyTweaks(ast, tw) {
    const byRole = {};
    atoms(ast).forEach((a) => { byRole[a.role] = a; });
    for (const tok of (tw || '').trim().split(/\s+/).filter(Boolean)) {
      let m = tok.match(/^([/|])(\d+(?:\.\d+)?)$/);
      if (m) {
        const node = m[1] === '/' ? (ast.k === '/' ? ast : null) : (ast.k === '|' ? ast : ast.k === '/' && ast.a.k === '|' ? ast.a : null);
        if (!node) throw new Error(`微调「${tok}」：没有对应的分割`);
        node.r = +m[2] / 100; continue;
      }
      m = tok.match(/^([^~*=]+)((?:~-?[\d.]+,-?[\d.]+|\*[\d.]+|=[^~*=]+)+)$/);
      if (!m || !byRole[m[1]]) throw new Error(`微调「${tok}」：未知角色`);
      const a = byRole[m[1]];
      for (const [, op, val] of m[2].matchAll(/([~*=])([^~*=]+)/g)) {
        if (op === '~') { const [dx, dy] = val.split(',').map(Number); a.dx = dx; a.dy = dy; }
        else if (op === '*') a.s = +val;
        else if (/^'.+'$/.test(val)) { a.v = val.slice(1, -1); a.q = true; a.forced = true; }
        else { a.v = val; a.q = false; a.forced = true; }
      }
    }
    return ast;
  }
  function tweaksOf(ast) {
    const out = [];
    if (ast.k === '/' && ast.r != null) out.push('/' + Math.round(ast.r * 100));
    const row = ast.k === '|' ? ast : ast.k === '/' && ast.a.k === '|' ? ast.a : null;
    if (row && row.r != null) out.push('|' + Math.round(row.r * 100));
    for (const a of atoms(ast)) {
      let s = '';
      if (a.forced) s += '=' + (a.q ? `'${a.v}'` : a.v);
      if (a.dx || a.dy) s += `~${n1(a.dx)},${n1(a.dy)}`;
      if (a.s !== 1) s += `*${Math.round(a.s * 100) / 100}`;
      if (s && a.role) out.push(a.role + s);
    }
    return out.join(' ');
  }
  /* 编译一个减字：语义 + 微调 → 结构 AST（原子带 role） */
  function build(env, c) {
    const ast = compile(env, c.sem);
    if (c.sem.trim().startsWith('{')) return ast;   // 结构式自带微调
    return applyTweaks(ast, c.tw);
  }

  /* ---------- 页面文件（.jz） ----------
   *   <语义>  @x,y,w,h  [| 微调]  [✓]  [! 备注]
   */
  const LINE = /^(.*?)\s+@(-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+)(?:\s+\|\s*(.*?))?(?:\s+(✓))?(?:\s+!\s*(.*))?\s*$/;
  function parsePage(text) {
    const page = { scan: '', size: [1000, 1000], scale: 1, chars: [], errors: [] };
    text.split('\n').forEach((raw, i) => {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim() || line.trim().startsWith('#')) return;
      let m = line.match(/^scan\s+(\S+)\s+(\d+)x(\d+)$/);
      if (m) { page.scan = m[1]; page.size = [+m[2], +m[3]]; return; }
      m = line.match(/^scale\s+([\d.]+)$/);
      if (m) { page.scale = +m[1]; return; }
      m = line.match(LINE);
      if (!m) { page.errors.push(`第 ${i + 1} 行无法识别：${line}`); return; }
      page.chars.push({ sem: m[1].trim(), box: [+m[2], +m[3], +m[4], +m[5]], tw: (m[6] || '').trim(), ok: !!m[7], note: m[8] || '' });
    });
    return page;
  }
  /* 按竖排右起阅读顺序分列：x 中心相距超过 gap 视为新列 */
  function columns(chars, gap = 22) {
    const items = chars.map((c, i) => ({ c, i, cx: c.box[0] + c.box[2] / 2 })).sort((a, b) => b.cx - a.cx);
    const cols = [];
    for (const it of items) {
      const col = cols[cols.length - 1];
      if (col && col.cx - it.cx < gap) { col.items.push(it); col.cx = it.cx; } else cols.push({ cx: it.cx, items: [it] });
    }
    cols.forEach((col) => col.items.sort((a, b) => a.c.box[1] - b.c.box[1]));
    return cols.map((col) => col.items);
  }
  function serializePage(page) {
    const b1 = (v) => n1(v);
    let s = '# 减字谱标注（JZ）· 语法见 annotator/JZ.md\n';
    s += `scan ${page.scan} ${page.size[0]}x${page.size[1]}\nscale ${page.scale}\n`;
    columns(page.chars).forEach((col, k) => {
      s += `\n# 第 ${k + 1} 列\n`;
      const w = Math.max(...col.map((it) => [...it.c.sem].length));
      for (const { c } of col) {
        s += `${c.sem}${'　'.repeat(Math.max(1, w - [...c.sem].length + 1))}@${c.box.map(b1).join(',')}`;
        if (c.tw) s += `  | ${c.tw}`;
        if (c.ok) s += '  ✓';
        if (c.note) s += `  ! ${c.note}`;
        s += '\n';
      }
    });
    return s;
  }

  root.JZ = { SLOTS, ATTACH, parse, fmt, atoms, resolve, familyOf, familyMembers, layout, natural, compile, applyTweaks, tweaksOf, build,
    parsePage, serializePage, columns, DIGITS };
})(typeof window !== 'undefined' ? window : globalThis);
