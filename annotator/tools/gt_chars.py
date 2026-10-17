"""把 extract_layout.py 提取的部件实例按字分组，并由组件名反推 JZ 语义，得到排版的标准答案集。

用法: python3 -I gt_chars.py <instances.json> <输出.json>

分组：按减字结构（见 groups），而非单纯的距离阈值——字内与字间的间距分布重叠。
角色：左手指（名/大/食）→ 指；右手指法 → 法；落在指法外框内（挑则在其上方）的数字 → 弦；
     其余位于上部的数字 → 徽（两个数字时，较大者为徽、较小者为分）；散 → 散。
"""
import json
import re
import sys

TOL = 1.2
DIGITS = '一二三四五六七八九十'
RH = ['勾', '挑', '抹', '打', '剔', '摘', '历', '托', '轮', '蠲']


def digit(name):
    if len(name) == 1 and name in DIGITS:
        return DIGITS.index(name) + 1
    m = re.match(r'^上(\d+)$', name) or re.match(r'^小(\d)\d?$', name)
    return int(m.group(1)) if m else 0


def kind(name):
    if digit(name):
        return 'num'
    if re.match(r'^(名|大|食)\d$', name):
        return 'lh'
    if name == '扁打摘' or any(r in name for r in RH):
        return 'rh'
    if name == '散':
        return '散'
    return 'word'


def family(name):
    if name == '扁打摘':
        return '摘'
    for r in RH:
        if r in name:
            return r
    m = re.match(r'^(名|大|食)\d$', name)
    return m.group(1) if m else name


def num_text(n):
    return DIGITS[n - 1] if n <= 10 else '十' + DIGITS[n - 11]


def touch(a, b, tol=TOL):
    return not (a[0] > b[0] + b[2] + tol or b[0] > a[0] + a[2] + tol or
                a[1] > b[1] + b[3] + tol or b[1] > a[1] + a[3] + tol)


def union(boxes):
    x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes)
    x1 = max(b[0] + b[2] for b in boxes); y1 = max(b[1] + b[3] for b in boxes)
    return [round(x0, 2), round(y0, 2), round(x1 - x0, 2), round(y1 - y0, 2)]


def xov(a, b):
    return min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])


def yov(a, b):
    return min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])


def groups(items):
    """按减字结构分组：上半部（指+徽[+分] 或 散）挂到正下方的指法单元上。"""
    k = [kind(i['name']) for i in items]
    used = [False] * len(items)
    B = lambda i: items[i]['box']
    # 1. 指法单元：指法 + 其内（挑、蠲：其上）的弦数
    units = []
    for r in [i for i in range(len(items)) if k[i] == 'rh']:
        used[r] = True
        R, fam = B(r), family(items[r]['name'])
        best, bs = None, 0
        for n in [i for i in range(len(items)) if k[i] == 'num' and not used[i]]:
            N = B(n)
            if fam in ('挑', '蠲'):
                ok = xov(N, R) > 0.5 * N[2] and -8 < R[1] - (N[1] + N[3]) < 3 and N[1] + N[3] / 2 < R[1] + R[3] / 2
            else:
                ok = inside(N, R)
            sc = xov(N, R) * max(yov(N, R), 1)
            if ok and sc > bs:
                best, bs = n, sc
        mem = [r] + ([best] if best is not None else [])
        if best is not None:
            used[best] = True
        units.append(mem)
    # 2. 上半部：左手指 + 右侧的徽（+ 其下的分）
    tops = []
    for l in [i for i in range(len(items)) if k[i] == 'lh']:
        used[l] = True
        L, mem = B(l), [l]
        hui = [n for n in range(len(items)) if k[n] == 'num' and not used[n]
               and yov(B(n), L) > 0.3 * min(B(n)[3], L[3]) and -12 < B(n)[0] - (L[0] + L[2]) < 5
               and B(n)[0] + B(n)[2] / 2 > L[0] + L[2] / 2]   # 徽位常与指交叠（实测达 9pt）
        if hui:
            h = min(hui, key=lambda n: B(n)[0]); mem.append(h); used[h] = True
            H = B(h)
            fen = [n for n in range(len(items)) if k[n] == 'num' and not used[n]
                   and xov(B(n), H) > 0.4 * B(n)[2] and -2 < B(n)[1] - (H[1] + H[3]) < 3 and B(n)[3] < H[3] * 1.3]
            if fen:
                f = min(fen, key=lambda n: B(n)[1]); mem.append(f); used[f] = True
        tops.append(mem)
    for sn in [i for i in range(len(items)) if k[i] == '散' and not used[i]]:
        used[sn] = True; tops.append([sn])
    # 2b. 单独的数字若紧贴在指法单元正上方，视为省略左手指的徽位
    for n in [i for i in range(len(items)) if k[i] == 'num' and not used[i]]:
        for u in units:
            U = union([B(i) for i in u])
            if xov(B(n), U) > 0.5 * B(n)[2] and -3 < U[1] - (B(n)[1] + B(n)[3]) < 4 and B(n)[3] < 22:
                used[n] = True; tops.append([n]); break
    # 3. 上半部挂到正下方最近的指法单元
    out, taken = [], set()
    for t in tops:
        T = union([B(i) for i in t])
        cands = []
        for ui, u in enumerate(units):
            if ui in taken:
                continue
            U = union([B(i) for i in u])
            gap = U[1] - (T[1] + T[3])
            if xov(T, U) > 0.3 * min(T[2], U[2]) and -10 < gap < 6:
                cands.append((abs(gap), ui))
        if cands:
            ui = min(cands)[1]; taken.add(ui); out.append(t + units[ui])
        else:
            out.append(t)
    out += [u for ui, u in enumerate(units) if ui not in taken]
    out += [[i] for i in range(len(items)) if not used[i]]
    return [[items[i] for i in g] for g in out]


def inside(inner, outer, pad=0.0):
    cx, cy = inner[0] + inner[2] / 2, inner[1] + inner[3] / 2
    return outer[0] - pad <= cx <= outer[0] + outer[2] + pad and outer[1] - pad <= cy <= outer[1] + outer[3] + pad


def decompile(parts):
    """返回 (语义, 每个部件的角色)；无法套入模板时返回 (None, None)。"""
    k = [kind(p['name']) for p in parts]
    roles = [None] * len(parts)
    rh = [i for i in range(len(parts)) if k[i] == 'rh']
    lh = [i for i in range(len(parts)) if k[i] == 'lh']
    nums = [i for i in range(len(parts)) if k[i] == 'num']
    san = [i for i in range(len(parts)) if k[i] == '散']
    words = [i for i in range(len(parts)) if k[i] == 'word']
    if len(parts) == 1 and words:
        return parts[0]['name'], ['字']
    if words or len(rh) > 1 or len(lh) > 1 or len(san) > 1:
        return None, None
    sem = ''
    if san:
        roles[san[0]] = '散'; sem += '散'
    xian = None
    if rh:
        R = parts[rh[0]]['box']
        fam = family(parts[rh[0]]['name'])
        cand = [i for i in nums if (inside(parts[i]['box'], R) if fam != '挑'
                                    else parts[i]['box'][1] + parts[i]['box'][3] / 2 < R[1] + R[3] and
                                    parts[i]['box'][1] + parts[i]['box'][3] > R[1] - 2)]
        if len(cand) > 1:
            cand = [max(cand, key=lambda i: parts[i]['box'][1])]
        if cand:
            xian = cand[0]
    top_nums = [i for i in nums if i != xian]
    if lh:
        roles[lh[0]] = '指'; sem += family(parts[lh[0]]['name'])
    if top_nums:
        if not lh and not rh and len(top_nums) == 1:
            roles[top_nums[0]] = '数'
            return num_text(digit(parts[top_nums[0]]['name'])), roles
        if len(top_nums) > 2:
            return None, None
        top_nums.sort(key=lambda i: parts[i]['box'][1])
        hui = top_nums[0]
        roles[hui] = '徽'; sem += num_text(digit(parts[hui]['name']))
        if len(top_nums) == 2:
            roles[top_nums[1]] = '分'; sem += num_text(digit(parts[top_nums[1]]['name'])) + '分'
    elif lh:
        pass
    if rh:
        roles[rh[0]] = '法'; sem += family(parts[rh[0]]['name'])
        if xian is not None:
            roles[xian] = '弦'; sem += num_text(digit(parts[xian]['name']))
    if not sem or any(r is None for r in roles):
        return None, None
    return sem, roles


def main(src, out):
    pages = json.load(open(src))
    chars, skipped = [], 0
    for pg in pages:
        items = [i for i in pg['items'] if i['name'] and i['score'] < 0.06]
        for g in groups(items):
            g.sort(key=lambda p: (p['box'][1], p['box'][0]))
            sem, roles = decompile(g)
            rec = {'pdf': pg['pdf'], 'page': pg['page'], 'box': union([p['box'] for p in g]),
                   'sem': sem, 'parts': [{'name': p['name'], 'role': r, 'box': p['box'], 'scale': p['scale']}
                                         for p, r in zip(g, roles or [None] * len(g))]}
            if sem is None:
                skipped += 1
            chars.append(rec)
    json.dump(chars, open(out, 'w'), ensure_ascii=False, indent=0)
    print(len(chars), 'chars,', skipped, 'not decompiled')


if __name__ == '__main__':
    main(*sys.argv[1:3])
