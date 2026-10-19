import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const port = Number(process.env.PORT) || 4173;
const root = resolve('dist');
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
createServer(async (req,res)=>{
  try {
    const pathname = decodeURIComponent(new URL(req.url||'/',`http://localhost:${port}`).pathname);
    const path = resolve(root,'.'+pathname, pathname.endsWith('/')?'index.html':'');
    if (!path.startsWith(root+'/')) {res.writeHead(403);res.end();return;}
    const file = await readFile(path);
    res.setHeader('Content-Type',types[extname(path)]||'application/octet-stream');
    res.writeHead(200);res.end(file);
  } catch{res.writeHead(404);res.end('Not found');}
}).listen(port,()=>console.log(`打开 http://localhost:${port}`));