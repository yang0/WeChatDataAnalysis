import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const path=new URL('../native/win32-x64/wx_key.dll',import.meta.url);
const data=await readFile(path);
const manifest={source:'H3CoF6/py_wx_key',commit:'f32e146647380a6ee14791cc5d4e279f9c480a41',platform:'win32-x64',sha256:createHash('sha256').update(data).digest('hex')};
await writeFile(new URL('../native/manifest.json',import.meta.url),JSON.stringify(manifest,null,2)+'\n');
console.log(manifest);
