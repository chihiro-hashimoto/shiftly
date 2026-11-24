/** dist/preview を配信する簡易サーバー（ローカル確認・E2E 用。127.0.0.1 のみで待受） */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, normalize, sep } from 'node:path';

const root = resolve(import.meta.dirname, '../dist/preview');
const port = Number(process.env.PORT ?? 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = url.pathname === '/' ? '/preview.html' : decodeURIComponent(url.pathname);
  const p = normalize(resolve(root, `.${rel}`));
  if (!p.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(p);
    res.writeHead(200, { 'Content-Type': types[extname(p)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`preview: http://127.0.0.1:${port}/`));
