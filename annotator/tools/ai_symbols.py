"""把 Illustrator 符号库（.ai 或"保留编辑功能"的 PDF）里的命名符号转成 SVG 路径 JSON。

用法: python3 -I ai_symbols.py <输入.ai/.pdf> <输出.json>

Illustrator 的原生数据以 zlib/zstd 压缩的 PostScript 文本存放在 /AIPrivateDataN 流中。
符号块位于 %AI14_BeginSymbol 与 %AI10_EndSymbol 之间，第一行 "(名称)…" 给出符号名。
"""
import json
import re
import subprocess
import sys
import tempfile
import zlib


def private_text(src):
    with tempfile.NamedTemporaryFile(suffix='.pdf') as tmp:
        subprocess.run(['qpdf', '--qdf', '--object-streams=disable', '--stream-data=uncompress',
                        src, tmp.name], check=False)
        data = open(tmp.name, 'rb').read()
    refs = re.findall(rb'/AI(?:PDF)?PrivateData(\d+) (\d+) 0 R', data)
    buf = b''
    for _, obj in sorted(refs, key=lambda r: int(r[0])):
        m = re.search(rb'\n%s 0 obj\n.*?stream\n' % obj, data, re.S)
        buf += data[m.end():data.index(b'\nendstream', m.end())]
    i = buf.find(b'%AI12_CompressedData')
    if i >= 0:   # Illustrator CC 及更早：zlib
        return zlib.decompressobj().decompress(buf[i + len(b'%AI12_CompressedData'):])
    i = buf.find(b'%AI24_ZStandard_Data')
    if i >= 0:   # Illustrator 2020 起：zstd（调用命令行 zstd）
        return subprocess.run(['zstd', '-dc'], input=buf[i + len(b'%AI24_ZStandard_Data'):],
                              capture_output=True, check=True).stdout
    raise ValueError('unsupported private data')


def decode_name(raw):
    for enc in ('utf-8', 'gbk'):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    return raw.decode('latin1')


def fmt(v):
    return f'{v:.2f}'.rstrip('0').rstrip('.')


def parse_symbol(body):
    """返回 dict: 填充路径 d、描边路径 sd 及线宽 sw、fill-rule、bbox。颜色一律忽略（组件为纯黑）。"""
    fill, stroke, seg, pts = [], [], [], []
    cur, evenodd, width = (0, 0), False, 1.0

    def emit(cmd, *xy):
        out = []
        for i in range(0, len(xy), 2):
            pts.append((xy[i], xy[i + 1]))
            out += [fmt(xy[i]), fmt(xy[i + 1])]
        seg.append(cmd + ' '.join(out))

    for line in body.split(b'\n'):
        line = line.strip()
        if not line or line.startswith(b'%'):
            continue
        m = re.search(rb'([\d.]+) w\b', line)
        if m:
            width = float(m.group(1))
        t = line.split()
        op, a = t[-1], t[:-1]
        try:
            n = [float(x) for x in a]
        except ValueError:
            n = None
        if op == b'm' and n and len(n) == 2:
            emit('M', *n); cur = tuple(n)
        elif op in (b'l', b'L') and n and len(n) == 2:
            emit('L', *n); cur = tuple(n)
        elif op in (b'c', b'C') and n and len(n) == 6:
            emit('C', *n); cur = tuple(n[4:])
        elif op in (b'v', b'V') and n and len(n) == 4:
            emit('C', *cur, *n); cur = tuple(n[2:])
        elif op in (b'y', b'Y') and n and len(n) == 4:
            emit('C', n[0], n[1], n[2], n[3], n[2], n[3]); cur = tuple(n[2:])
        elif op in (b'f', b'F', b'b', b'B'):
            fill.extend(seg + ['Z']); seg = []
        elif op in (b's', b'S'):
            stroke.extend(seg + (['Z'] if op == b's' else [])); seg = []
        elif op in (b'n', b'N', b'h', b'H'):
            seg = []
        elif op == b'XR' and n:
            evenodd = n[0] == 1
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    bbox = [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)] if pts else [0, 0, 0, 0]
    out = {'d': ''.join(fill), 'rule': 'evenodd' if evenodd else 'nonzero',
           'bbox': [round(v, 2) for v in bbox]}
    if stroke:
        out.update(sd=''.join(stroke), sw=width)
    return out


def main(src, out):
    text = private_text(src)
    blocks = re.findall(rb'%AI14_BeginSymbol\r?\n(.*?)%AI10_EndSymbol', text, re.S)
    syms = []
    for b in blocks:
        name = decode_name(re.match(rb'\((.*?)\)', b).group(1))
        ref = re.search(rb'\((.*?)\)\s+/SymbolRef', b)
        sym = {'name': name, 'ref': decode_name(ref.group(1))} if ref else \
            {'name': name, **parse_symbol(b.split(b'\n', 1)[1])}
        syms.append(sym)
    by_name = {s['name']: s for s in syms}
    for s in syms:  # 符号实例：沿用被引用符号的几何
        if 'ref' in s:
            s.update({k: v for k, v in by_name[s['ref']].items() if k != 'name'})
    json.dump(syms, open(out, 'w'), ensure_ascii=False, indent=0)
    print(len(syms), 'symbols ->', out)


if __name__ == '__main__':
    main(*sys.argv[1:3])
