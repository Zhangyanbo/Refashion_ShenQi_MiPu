"""减字谱标注器的本地服务器。

    python3 annotator/server.py            # 然后打开 http://localhost:8770

- 静态文件：annotator/ 目录
- /font/main.ttf：直接读取本机已安装的「苏新诗柳楷繁」，字体不进入仓库
- GET  /api/pages        列出 data/pages/*.jz
- POST /api/save?path=…  写入 data/ 下的 .jz / .json，旧版本备份到 data/.history/
"""
import json
import os
import shutil
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'data'
FONT = Path(os.environ.get('JIANZI_FONT', Path.home() / 'Library/Fonts/苏新诗柳楷繁.ttf'))
PORT = int(os.environ.get('PORT', 8770))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/font/main.ttf':
            data = FONT.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'font/ttf')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif url.path == '/api/pages':
            self.send_json(sorted(p.stem for p in (DATA / 'pages').glob('*.jz')))
        else:
            super().do_GET()

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != '/api/save':
            return self.send_json({'error': 'not found'}, 404)
        rel = unquote(parse_qs(url.query).get('path', [''])[0])
        target = (ROOT / rel).resolve()
        if DATA not in target.parents or target.suffix not in ('.json', '.jz'):
            return self.send_json({'error': 'path must be a .json/.jz under data/'}, 400)
        body = self.rfile.read(int(self.headers['Content-Length']))
        if target.suffix == '.json':
            json.loads(body)  # 拒绝写入非法 JSON
        if target.exists():
            hist = DATA / '.history'
            hist.mkdir(exist_ok=True)
            shutil.copy2(target, hist / f'{target.stem}.{time.strftime("%Y%m%d-%H%M%S")}{target.suffix}')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        self.send_json({'ok': True, 'path': rel})


if __name__ == '__main__':
    print(f'http://localhost:{PORT}  (font: {FONT}, exists={FONT.exists()})')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
