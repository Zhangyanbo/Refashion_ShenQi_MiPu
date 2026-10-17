"""从已完成作品（gt_chars.py 的输出）学习排版风格，写出 data/style.json，供 jz.js 的风格排版使用。

用法: python3 -I learn_style.py <chars.json> <library.json> <style.json> [--only 获麟.pdf] [--pages data/pages]

--pages：同时读取已校对（✓）减字的微调层，把人工偏移按「角色|指法」取中位数，
         写成 place 中的 adj|<角色>|<指法> = [dx, dy]（pt），排版时叠加到默认位置上。

学到的内容（单位 pt）：
  variants  每个「角色|上下文」最常用的组件及其缩放（中位数）
  height/width  数字类角色在各上下文中的目标高/宽，用于没见过的数字挑选变体（按宽度，因「一」极扁）
  place     部件相对位置：
              弦|<法组件>          弦中心相对指法外框的比例位置 [rx, ry]
              top|<类型>|<法组件>  上半部相对下半部（法∪弦）：[水平中心差, 竖向间隙]
              徽|<指组件>          徽相对指：[徽左 − 指右, 徽中心y − 指中心y]
              分                   分相对徽：[中心x差, 分顶 − 徽底]
              指x|<法> 指y|<法>    指中心相对法中心的水平差；指中心相对下半部顶边的竖向差
              徽x|<法> 徽y         徽右边相对下半部右边；徽顶相对指顶
"""
import json
import re
import sys
from collections import Counter, defaultdict
from statistics import median

RH = ['勾', '挑', '抹', '打', '剔', '摘', '历', '托', '轮', '蠲']
DIGITS = '一二三四五六七八九十'


def fam(n):
    if n == '扁打摘':
        return '摘'
    for r in RH:
        if r in n:
            return r
    return n


def digit(n):
    if len(n) == 1 and n in DIGITS:
        return DIGITS.index(n) + 1
    m = re.match(r'^上(\d+)$', n) or re.match(r'^小(\d)\d?$', n)
    return int(m.group(1)) if m else 0


def union(bs):
    x0 = min(b[0] for b in bs); y0 = min(b[1] for b in bs)
    return [x0, y0, max(b[0] + b[2] for b in bs) - x0, max(b[1] + b[3] for b in bs) - y0]


def keys_for(role, p, ctx):
    """由具体到一般的一串键；排版时按顺序查找。"""
    f, top, d = ctx['fam'], ctx['top'], digit(p['name'])
    if role == '法':
        return [f'法|{f}|{top}', f'法|{f}']
    if role == '弦':
        return [f'弦|{f}|{top}|{d}', f'弦|{f}|{top}', f'弦|{f}']
    if role == '指':
        return [f'指|{p["name"][0]}|{ctx["hui"]}', f'指|{p["name"][0]}']
    if role in ('徽', '分', '数'):
        return [f'{role}|{d}', role]
    return [f'{role}|{p["name"]}', role]


def tweak_offsets(pages_dir):
    """从 .jz 页面中已校对字的微调层收集 角色~dx,dy（页面像素 → pt）。"""
    import glob
    adj = defaultdict(list)
    for path in glob.glob(f'{pages_dir}/*.jz'):
        scale = 1.0
        for line in open(path, encoding='utf-8'):
            m = re.match(r'^scale\s+([\d.]+)', line)
            if m:
                scale = float(m.group(1)); continue
            m = re.match(r'^(\S+)\s+@\S+\s+\|\s*(.*?)(?:\s+✓)', line)
            if not m:
                continue
            sem, tw = m.groups()
            f = next((fam(ch) for ch in sem if fam(ch) in RH), '-')
            for role, dx, dy in re.findall(r'(\S+?)(?:=[^~*\s]+)?~(-?[\d.]+),(-?[\d.]+)', tw):
                adj[f'adj|{role}|{f}'].append((float(dx) / scale, float(dy) / scale))
                adj[f'adj|{role}|*'].append((float(dx) / scale, float(dy) / scale))
    return adj


def main(src, lib_path, out, *flags):
    chars = json.load(open(src))
    if '--only' in flags:
        keep = flags[flags.index('--only') + 1]
        chars = [c for c in chars if c['pdf'] == keep]
    lib = {s['name']: s for s in json.load(open(lib_path))}
    var = defaultdict(Counter); scl = defaultdict(list); hts = defaultdict(list); wds = defaultdict(list)
    place = defaultdict(list)
    for c in chars:
        P = defaultdict(list)
        for p in c['parts']:
            P[p['role']].append(p)
        rh = P['法'][0] if P['法'] else None
        hui = P['徽'][0] if P['徽'] else None
        ctx = {'fam': fam(rh['name']) if rh else '-',
               'top': 'T' if (P['指'] or P['散'] or P['徽']) else 'N',
               'hui': digit(hui['name']) if hui else 0}
        for role, ps in P.items():
            for p in ps:
                s = round(p['scale'][0], 2)
                for k in keys_for(role, p, ctx):
                    var[k][p['name']] += 1
                    scl[(k, p['name'])].append(s)
                    if digit(p['name']):
                        hts[k].append(p['box'][3]); wds[k].append(p['box'][2])
        if rh:
            R = rh['box']
            for x in P['弦']:
                X = x['box']
                rx = (X[0] + X[2] / 2 - R[0]) / R[2]; ry = (X[1] + X[3] / 2 - R[1]) / R[3]
                place[f'弦|{rh["name"]}'].append((rx, ry)); place[f'弦|{ctx["fam"]}'].append((rx, ry))
            U = union([p['box'] for p in P['法'] + P['弦']])
            topParts = P['指'] + P['徽'] + P['分'] if P['指'] or P['徽'] else P['散']
            if topParts:
                kind = '散' if P['散'] and not P['指'] else ('指' if P['指'] else '徽')
                T = union([p['box'] for p in topParts])
                v = (T[0] + T[2] / 2 - (U[0] + U[2] / 2), U[1] - (T[1] + T[3]))
                place[f'top|{kind}|{rh["name"]}'].append(v); place[f'top|{kind}|{ctx["fam"]}'].append(v)
                place[f'top|{kind}'].append(v)
        if rh and P['指']:   # 上半部基准：离散度最小的锚点（见 JZ.md「风格排版」）
            L = P['指'][0]['box']; F = rh['box']; U = union([p['box'] for p in P['法'] + P['弦']])
            for k in (rh['name'], ctx['fam'], '*'):
                place[f'指x|{k}'].append((L[0] + L[2] / 2 - (F[0] + F[2] / 2), 0))
                place[f'指y|{k}'].append((L[1] + L[3] / 2 - U[1], 0))
                if P['徽']:
                    H = P['徽'][0]['box']
                    place[f'徽x|{k}'].append((H[0] + H[2] - (U[0] + U[2]), 0))
        if P['指'] and P['徽']:
            L, H = P['指'][0]['box'], P['徽'][0]['box']
            place['徽y'].append((H[1] - L[1], 0))
        if P['指'] and P['徽']:
            L, H = P['指'][0]['box'], P['徽'][0]['box']
            v = (H[0] - (L[0] + L[2]), (H[1] + H[3] / 2) - (L[1] + L[3] / 2))
            place[f'徽|{P["指"][0]["name"]}'].append(v); place['徽'].append(v)
        if P['徽'] and P['分']:
            H, F = P['徽'][0]['box'], P['分'][0]['box']
            place['分'].append(((F[0] + F[2] / 2) - (H[0] + H[2] / 2), F[1] - (H[1] + H[3])))
    if '--pages' in flags:
        for k, v in tweak_offsets(flags[flags.index('--pages') + 1]).items():
            place[k] = v
    style = {
        'variants': {k: [[n, cnt, median(scl[(k, n)])] for n, cnt in v.most_common()] for k, v in var.items()},
        'height': {k: round(median(v), 2) for k, v in hts.items()},
        'width': {k: round(median(v), 2) for k, v in wds.items()},
        'place': {k: [round(median(a for a, _ in v), 3), round(median(b for _, b in v), 3), len(v)] for k, v in place.items()},
        'charH': round(median(c['box'][3] for c in chars if c['sem'] and any(p['role'] == '法' for p in c['parts'])), 2),
    }
    json.dump(style, open(out, 'w'), ensure_ascii=False, indent=0)
    print(len(chars), 'chars →', len(style['variants']), 'variant keys,', len(style['place']), 'place keys; charH', style['charH'])


if __name__ == '__main__':
    main(*sys.argv[1:])
