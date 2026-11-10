import { createServer } from 'node:http';
import { createService } from '../lib/service.mjs';
const service = createService();
await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));
const parent = createServer((_req,res)=>{
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(`<html><body style="margin:0"><iframe title="微信解密" sandbox="allow-scripts" src="http://127.0.0.1:${service.address().port}/ui" style="width:100%;height:100vh;border:0"></iframe></body></html>`);
});
await new Promise(resolve=>parent.listen(0,'127.0.0.1',resolve));
console.log('http://127.0.0.1:'+parent.address().port);
