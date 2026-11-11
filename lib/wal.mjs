// SQLite WAL checksums cover the encrypted payload, not decrypted pages.
export function checksum(data, little, state = [0, 0]) {
  if (data.length % 8) throw new Error('WAL 校验区间无效');
  let [a,b] = state;
  for (let i=0;i<data.length;i+=8) {
    const x=little?data.readUInt32LE(i):data.readUInt32BE(i);
    const y=little?data.readUInt32LE(i+4):data.readUInt32BE(i+4);
    a=(a+x+b)>>>0; b=(b+y+a)>>>0;
  }
  return [a,b];
}
export async function readExact(file, length, position) {
  const data=Buffer.alloc(length); let at=0;
  while(at<length) { const {bytesRead}=await file.read(data,at,length-at,position+at); if(!bytesRead) throw new Error('数据库或 WAL 文件截断，请获取稳定副本后重试'); at+=bytesRead; }
  return data;
}
export async function indexWal(file, bytes, pageSize, basePages, checkCanceled = ()=>{}) {
  const info={committed_frames:0,applied_pages:0,ignored_tail_bytes:0,database_pages:basePages};
  const result={pages:new Map(),basePages,size:basePages,info};
  if(!file || !bytes) return result;
  if(bytes<32) throw new Error('WAL 文件头不完整，请退出微信后重试');
  const head=await readExact(file,32,0);
  const magic=head.readUInt32BE(0);
  if(![0x377f0682,0x377f0683].includes(magic)||head.readUInt32BE(4)!==3007000||head.readUInt32BE(8)!==pageSize) throw new Error('WAL 文件头、版本或页大小不匹配');
  const little=magic===0x377f0682;
  let state=checksum(head.subarray(0,24),little);
  if(state[0]!==head.readUInt32BE(24)||state[1]!==head.readUInt32BE(28)) throw new Error('WAL 文件头校验失败');
  let pending=new Map(),committed=new Map(),commitEnd=32;
  for(let offset=32;offset+24+pageSize<=bytes;offset+=24+pageSize) {
    checkCanceled();
    const frame=await readExact(file,24+pageSize,offset);
    if(!frame.subarray(8,16).equals(head.subarray(16,24))) break;
    const pg=frame.readUInt32BE(0),size=frame.readUInt32BE(4);
    if(!pg||pg>0xfffffffe||size>0xfffffffe) throw new Error('WAL 页号无效');
    state=checksum(frame.subarray(24),little,checksum(frame.subarray(0,8),little,state));
    if(state[0]!==frame.readUInt32BE(16)||state[1]!==frame.readUInt32BE(20)) throw new Error('WAL 帧校验失败，请重新获取稳定副本');
    pending.set(pg,offset+24);
    if(size) {
      for(const [n,at] of pending) committed.set(n,at);
      pending=new Map();
      for(const n of committed.keys()) if(n>size) committed.delete(n);
      result.basePages=Math.min(result.basePages,size);
      let extensions=0;for(const n of committed.keys()) if(n>result.basePages) extensions++;
      if(size-result.basePages!==extensions) throw new Error('WAL 提交缺少数据库扩展页');
      result.size=size;
      commitEnd=offset+24+pageSize;
      info.committed_frames=(commitEnd-32)/(24+pageSize);
    }
  }
  result.pages=committed;
  info.applied_pages=committed.size;info.database_pages=result.size;info.ignored_tail_bytes=bytes-commitEnd;
  return result;
}
