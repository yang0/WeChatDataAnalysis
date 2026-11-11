import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for(const path of ['index.mjs',...(await readdir('lib')).filter(x=>x.endsWith('.mjs')).map(x=>'lib/'+x),'gui/app.js','gui/entry.js']){
  const result=spawnSync(process.execPath,['--check',path],{stdio:'inherit'});if(result.status)process.exit(result.status||1);
}
