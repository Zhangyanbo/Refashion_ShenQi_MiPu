"""从已完成的 Illustrator PDF 中提取每个符号实例的位置，作为排版规则的标准答案。

用法: python3 -I extract_layout.py <library.json> <输出.json> <成品1.pdf> [成品2.pdf ...]

Illustrator 把符号实例导出为 Form XObject（页面里是 "a b c d e f cm /FmN Do"）。
本脚本：
  1. 解析每页内容流，跟踪 q/Q 与 cm，得到每次 Do 的变换矩阵（含嵌套表单）；
  2. 取表单内路径的端点，与符号库各组件的端点集做形状匹配，确定组件名；
  3. 输出每个实例：组件名、页面坐标外框（y 向下，单位 pt）、缩放。
同时输出用字体直接排出的文字（BT…ET）的外框，便于区分。
"""
import json
import re
import subprocess
import sys
import tempfile

import numpy as np

NUM = rb'-?(?:\d+\.?\d*|\.\d+)'
TOK = re.compile(rb'/[^\s/\[\]()<>]+|' + NUM + rb'|[A-Za-z\'"*]+|\[|\]|\([^)]*\)|<[0-9A-Fa-f\s]*>')


def mat(a, b, c, d, e, f):
    return np.array([[a, b, 0], [c, d, 0], [e, f, 1]], float)


def load(src):
    with tempfile.NamedTemporaryFile(suffix='.pdf') as tmp:
        subprocess.run(['qpdf', '--qdf', '--object-streams=disable', '--stream-data=uncompress', src, tmp.name], check=False)
        return open(tmp.name, 'rb').read()


def objects(data):
    out = {}
    for m in re.finditer(rb'\n(\d+) 0 obj\n(.*?)\nendobj', data, re.S):
        body = m.group(2)
        sm = re.search(rb'stream\n(.*)\nendstream', body, re.S)
        out[int(m.group(1))] = (body.split(b'stream\n')[0], sm.group(1) if sm else None)
    return out


def resources_xobjects(objs, dict_bytes):
    """返回名称 → 对象号。资源可能内联，也可能是间接引用。"""
    m = re.search(rb'/Resources (\d+) 0 R', dict_bytes)
    res = objs[int(m.group(1))][0] if m else dict_bytes
    m = re.search(rb'/XObject (\d+) 0 R', res)
    xo = objs[int(m.group(1))][0] if m else res
    m = re.search(rb'/XObject\s*<<(.*?)>>', xo, re.S)
    body = m.group(1) if m else xo
    return {k.decode(): int(v) for k, v in re.findall(rb'/(\w+) (\d+) 0 R', body)}


def form_points(stream):
    """表单内所有路径端点（考虑表单内部的 cm）。"""
    pts, stack, ctm, args = [], [], np.eye(3), []
    for t in TOK.findall(stream):
        if re.fullmatch(NUM, t):
            args.append(float(t)); continue
        op = t
        if op == b'q': stack.append(ctm.copy())
        elif op == b'Q': ctm = stack.pop() if stack else np.eye(3)
        elif op == b'cm' and len(args) >= 6: ctm = mat(*args[-6:]) @ ctm
        elif op in (b'm', b'l') and len(args) >= 2: pts.append(np.array([args[-2], args[-1], 1]) @ ctm)
        elif op == b'c' and len(args) >= 6: pts.append(np.array([args[-2], args[-1], 1]) @ ctm)
        elif op in (b'v', b'y') and len(args) >= 4: pts.append(np.array([args[-2], args[-1], 1]) @ ctm)
        elif op == b're' and len(args) >= 4:
            x, y, w, h = args[-4:]
            pts += [np.array([x, y, 1]) @ ctm, np.array([x + w, y + h, 1]) @ ctm]
        args = []
    return np.array([p[:2] for p in pts]) if pts else np.zeros((0, 2))


def lib_points(d):
    nums = [float(v) for v in re.findall(r'-?\d+\.?\d*', d)]
    segs = re.findall(r'([MLC])([^MLCZ]*)', d)
    pts = []
    for cmd, body in segs:
        v = [float(x) for x in body.split()]
        pts.append(v[-2:])
    return np.array(pts) if pts else np.zeros((0, 2))


def normalize(p):
    lo, hi = p.min(0), p.max(0)
    return (p - lo) / np.maximum(hi - lo, 1e-6), hi - lo


def chamfer(a, b):
    d = ((a[:, None, :] - b[None, :, :]) ** 2).sum(-1)
    return np.sqrt(d.min(1)).mean() + np.sqrt(d.min(0)).mean()


def match(form_pts, lib):
    """表单内部坐标与符号库相同（y 向下）；页面调用时以 1 0 0 -1 矩阵翻转。"""
    fp = form_pts
    nf, size = normalize(fp)
    best = []
    for s in lib:
        if len(s['pts']) < 2:
            continue
        ratio = size / np.maximum(s['size'], 1e-6)
        if np.any(ratio < 0.5) or np.any(ratio > 2):
            continue
        best.append((chamfer(nf, s['norm']) + 0.3 * abs(np.log(ratio[0] / ratio[1])), s['name']))
    best.sort()
    return best[0] if best else (9, None)


def main(lib_path, out_path, *pdfs):
    lib = json.load(open(lib_path))
    for s in lib:
        p = lib_points(s['d'] + s.get('sd', ''))
        s['pts'] = p
        if len(p) >= 2:
            s['norm'], s['size'] = normalize(p)
    result = []
    for src in pdfs:
        data = load(src)
        objs = objects(data)
        pages = [int(n) for n in re.findall(rb'%% Page \d+\n%%[^\n]*\n(\d+) 0 obj', data)]
        form_cache = {}

        def walk(dict_bytes, stream, ctm0, out, depth=0):
            xo = resources_xobjects(objs, dict_bytes)
            stack, ctm, args = [], ctm0.copy(), []
            for t in TOK.findall(stream):
                if re.fullmatch(NUM, t):
                    args.append(float(t)); continue
                if t.startswith(b'/'):
                    args.append(t.decode()); continue
                op = t
                if op == b'q': stack.append(ctm.copy())
                elif op == b'Q': ctm = stack.pop() if stack else ctm0.copy()
                elif op == b'cm' and len(args) >= 6: ctm = mat(*args[-6:]) @ ctm
                elif op == b'Do' and args and isinstance(args[-1], str):
                    num = xo.get(args[-1][1:])
                    if num is None or b'/Subtype /Form' not in objs[num][0]:
                        args = []; continue
                    fd, fs = objs[num]
                    m = re.search(rb'/Matrix \[([^\]]*)\]', fd)
                    fm = mat(*map(float, m.group(1).split())) if m else np.eye(3)
                    full = fm @ ctm
                    if num not in form_cache:
                        form_cache[num] = form_points(fs)
                    pts = form_cache[num]
                    if b' Do' in fs and depth < 3 and len(pts) == 0:
                        walk(fd, fs, full, out, depth + 1)   # 纯编组表单：展开
                    elif len(pts):
                        if num not in match_cache:
                            match_cache[num] = match(pts, lib)
                        score, name = match_cache[num]
                        P = np.c_[pts, np.ones(len(pts))] @ full
                        x0, y0 = P[:, 0].min(), P[:, 1].min(); x1, y1 = P[:, 0].max(), P[:, 1].max()
                        sx = np.hypot(full[0, 0], full[0, 1]); sy = np.hypot(full[1, 0], full[1, 1])
                        out.append({'form': num, 'name': name, 'score': round(float(score), 3),
                                    'box': [round(x0, 2), round(y0, 2), round(x1 - x0, 2), round(y1 - y0, 2)],
                                    'scale': [round(sx, 3), round(sy, 3)]})
                args = []

        match_cache = {}
        for pi, pn in enumerate(pages):
            pd, _ = objs[pn]
            mb = [float(v) for v in re.search(rb'/MediaBox \[([^\]]*)\]', pd).group(1).split()]
            H = mb[3]
            cs = re.search(rb'/Contents (\d+) 0 R', pd)
            stream = objs[int(cs.group(1))][1]
            inst = []
            walk(pd, stream, np.eye(3), inst)
            for it in inst:   # 转成 y 向下
                x, y, w, h = it['box']; it['box'] = [x, round(H - y - h, 2), w, h]
            result.append({'pdf': src.split('/')[-1], 'page': pi + 1, 'size': [mb[2], mb[3]], 'items': inst})
            print(src.split('/')[-1], 'p', pi + 1, len(inst), 'instances,',
                  sum(1 for i in inst if i['score'] > 0.08), 'weak matches')
    json.dump(result, open(out_path, 'w'), ensure_ascii=False, indent=0)


if __name__ == '__main__':
    main(*sys.argv[1:])
