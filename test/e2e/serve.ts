// Minimal static file server for browser tests and local preview.
import {createServer, type Server} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.svg': 'image/svg+xml',
};

export async function serve(root: string, port = 0): Promise<{server: Server; url: string}> {
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = path.join(root, urlPath.endsWith('/') ? `${urlPath}index.html` : urlPath);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store'});
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const addr = server.address();
  return {server, url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}`};
}
