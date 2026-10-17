"""比对 JZ 排版结果与标准答案（eval_predict.js 的输出）。

用法: python3 -I eval_compare.py <library.json> <pred.json> [对照图.png]

两个层次：
  元素层  每个部件：变体是否相同、中心偏差（pt）、尺寸比
  像素层  整字光栅化后的墨迹 IoU（两边以各自字框中心对齐）
"""
import json
import re
import sys
from collections import defaultdict

import numpy as np
from PIL import Image, ImageDraw

RES = 8  # 每 pt 像素数


def flatten(d):
    """SVG path（M L C Z）→ 多边形列表。"""
    polys, cur, pts = [], None, []
    for cmd, body in re.findall(r'([MLCZ])([^MLCZ]*)', d):
        v = [float(x) for x in body.split()]
        if cmd == 'M':
            if len(pts) > 2: polys.append(pts)
            pts = [tuple(v[:2])]; cur = tuple(v[:2])
        elif cmd == 'L':
            pts.append(tuple(v[:2])); cur = tuple(v[:2])
        elif cmd == 'C':
            p0, p1, p2, p3 = np.array(cur), np.array(v[0:2]), np.array(v[2:4]), np.array(v[4:6])
            for t in np.linspace(0, 1, 9)[1:]:
                pts.append(tuple((1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3))
            cur = tuple(v[4:6])
        elif cmd == 'Z':
            if len(pts) > 2: polys.append(pts)
            pts = []
    if len(pts) > 2: polys.append(pts)
    return polys


def draw(img, lib, name, box, origin):
    s = lib.get(name)
    if not s or not s['d']:
        return
    bx, by, bw, bh = s['bbox']
    sx, sy = box[2] / bw, box[3] / bh
    dr = ImageDraw.Draw(img)
    for poly in flatten(s['d']):
        dr.polygon([((box[0] + (x - bx) * sx - origin[0]) * RES, (box[1] + (y - by) * sy - origin[1]) * RES) for x, y in poly], fill=255)


def render(lib, parts, origin, size):
    """非零填充近似：逐个多边形填充（组件多为单一外轮廓，足够比对）。"""
    img = Image.new('L', (int(size[0] * RES), int(size[1] * RES)), 0)
    for p in parts:
        layer = Image.new('L', img.size, 0)
        draw(layer, lib, p['name'], p['box'], origin)
        img = Image.fromarray(np.maximum(np.array(img), np.array(layer)))
    return np.array(img) > 127


def main(lib_path, pred_path, sheet=None):
    lib = {s['name']: s for s in json.load(open(lib_path))}
    chars = json.load(open(pred_path))
    same = tot = 0
    vr = defaultdict(lambda: [0, 0])
    err = defaultdict(list)
    ious, aligned = [], []
    rows = []
    for c in chars:
        if c.get('err'):
            continue
        gt = defaultdict(list)
        for p in c['parts']:
            gt[p['role']].append(p)
        for p in c['pred']:
            role = p['role'].rstrip('十') if p['role'] not in ('十',) else p['role']
            g = gt.get(p['role']) or gt.get(role)
            if not g:
                continue
            g = g[0]
            tot += 1; same += g['name'] == p['name']
            vr[role][0] += g['name'] == p['name']; vr[role][1] += 1
            ga = next((q['box'] for q in c['parts'] if q['role'] == '法'), [0, 0])
            pa = next((q['box'] for q in c['pred'] if q['role'] == '法'), [0, 0])
            gc = np.array([g['box'][0] + g['box'][2] / 2 - ga[0], g['box'][1] + g['box'][3] / 2 - ga[1]])
            pc = np.array([p['box'][0] + p['box'][2] / 2 - pa[0], p['box'][1] + p['box'][3] / 2 - pa[1]])
            err[role].append(float(np.linalg.norm(gc - pc)))
        B = c['box']
        pad = 6
        origin = (B[0] - pad, B[1] - pad); size = (B[2] + 2 * pad, B[3] + 2 * pad)
        a = render(lib, c['parts'], origin, size); b = render(lib, c['pred'], origin, size)
        iou = (a & b).sum() / max((a | b).sum(), 1)
        best = iou   # 允许整字平移 ±3pt：只看字内部比例
        for dx in range(-3 * RES, 3 * RES + 1, RES // 2):
            for dy in range(-3 * RES, 3 * RES + 1, RES // 2):
                bb = np.roll(np.roll(b, dy, 0), dx, 1)
                best = max(best, (a & bb).sum() / max((a | bb).sum(), 1))
        if any(p['role'] == '法' for p in c['parts']):   # 只统计完整减字，单独的数/术语两边必然相同
            ious.append(iou); aligned.append(best)
            rows.append((iou, c, a, b))
    print(f'完整减字 {len(ious)}；变体一致 {same}/{tot} = {same / max(tot, 1):.1%}（' +
          '，'.join(f'{r} {a}/{n}' for r, (a, n) in sorted(vr.items(), key=lambda kv: -kv[1][1])) + '）')
    print('部件中心偏差（相对指法左上角，pt，中位 / 90%）：' + '，'.join(
        f'{r} {np.median(v):.2f}/{np.percentile(v, 90):.2f}' for r, v in sorted(err.items(), key=lambda kv: -len(kv[1]))))
    print(f'像素 IoU：中位 {np.median(ious):.3f}，均值 {np.mean(ious):.3f}；整字对齐后：中位 {np.median(aligned):.3f}，均值 {np.mean(aligned):.3f}，最差 10% 分位 {np.percentile(aligned, 10):.3f}')
    if sheet:
        rows.sort(key=lambda r: r[0])   # 按未对齐 IoU 由差到好
        pick = rows[:24]
        W = max(r[2].shape[1] for r in pick); H = max(r[2].shape[0] for r in pick)
        cols = 8
        canvas = Image.new('RGB', (cols * (W + 6), ((len(pick) + cols - 1) // cols) * (H + 6)), 'white')
        for i, (iou, c, a, b) in enumerate(pick):
            rgb = np.full(a.shape + (3,), 255, np.uint8)
            rgb[a & ~b] = (40, 40, 40); rgb[b & ~a] = (230, 40, 30); rgb[a & b] = (150, 60, 160)
            canvas.paste(Image.fromarray(rgb), ((i % cols) * (W + 6), (i // cols) * (H + 6)))
        canvas.save(sheet)


if __name__ == '__main__':
    main(*sys.argv[1:])
