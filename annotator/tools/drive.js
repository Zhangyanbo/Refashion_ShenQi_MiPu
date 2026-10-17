// 用 Chrome 调试协议驱动编辑器做交互测试（不写盘：拦截 /api/save）。
// 用法: node drive.js <脚本.js>   脚本内可用 await ev(表达式)、await mouse(type,x,y)、await shot(路径)
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const URL = process.env.URL || 'http://127.0.0.1:8770/?page=sample-01';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jzdrive-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${dir}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    let tabs;
    for (let i = 0; i < 50; i++) {
      try { tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    const page = tabs.find((t) => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0; const pend = {};
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result.result.value;
    };
    const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
    const key = (k) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k });
    const shot = async (p) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(p, Buffer.from(r.result.data, 'base64')); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: URL });
    for (let i = 0; i < 60 && !(await ev('document.body && document.body.dataset.ready')); i++) await sleep(200);
    await ev(`window.fetch = ((f) => (u, o) => String(u).includes('/api/save') ? Promise.resolve(new Response('{"ok":true}')) : f(u, o))(window.fetch)`);
    const script = fs.readFileSync(process.argv[2], 'utf8');
    await new Function('ev', 'mouse', 'key', 'shot', 'sleep', `return (async () => { ${script} })()`)(ev, mouse, key, shot, sleep);
  } catch (e) {
    console.error('ERR', e.message);
    process.exitCode = 1;
  } finally {
    if (ws) ws.close();
    chrome.kill();
  }
})();
