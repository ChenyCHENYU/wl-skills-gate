import path from 'node:path';
import {globSync,lstatSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {safePath} from './source-state.js';
import {createHash} from 'node:crypto';
const sha256=value=>createHash('sha256').update(value).digest('hex');

export const BUILD_RESULT_PATH='quality-reports/ci-integration/build-result.json';
export const BUILD_ARCHIVE_PATH='quality-reports/ci-integration/business-artifacts.zip';
const MAX_BYTES=256*1024*1024,MAX_FILES=5000;
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const table=Array.from({length:256},(_,i)=>{let c=i;for(let n=0;n<8;n++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc32=bytes=>{let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;};

// A deterministic ZIP with ordinary stored files; no shell, package download,
// platform-specific archiver or executable metadata. The collector downloads
// exactly this fixed artifact, rather than trusting a workspace glob remotely.
export function archiveBuildArtifacts({root,artifactGlob}) {
  const names=new Set();let matched=0;
  for(const pattern of artifactGlob.split(',').map(v=>v.trim()))for(const file of globSync(pattern,{cwd:root})) {
    assert(++matched<=MAX_FILES*4,'制品匹配超过预算，请收紧批准范围');
    const relative=file.split(path.sep).join('/');
    assert(!relative.split('/').some(p=>['.git','node_modules','quality-reports'].includes(p)),'制品范围不能夹带Git、依赖或门禁记录');
    const stat=lstatSync(safePath(root,relative));assert(!stat.isSymbolicLink(),'制品不能含符号链接');
    if(stat.isFile())names.add(relative);else assert(stat.isDirectory(),'制品包含特殊文件');
  }
  assert(names.size && names.size<=MAX_FILES,'批准范围没有实际制品或超过5000文件预算');
  const local=[],central=[],entries=[];let offset=0,total=0,centralSize=0;
  for(const name of [...names].sort()) {
    const stat=lstatSync(safePath(root,name));assert(stat.size<=MAX_BYTES-total,'制品超过256MiB预算，请拆分批准构建范围');
    const bytes=readFileSync(safePath(root,name));total+=bytes.length;
    assert(bytes.length===stat.size && total<=MAX_BYTES,'制品读取期间变化或超过预算');
    const filename=Buffer.from(name),crc=crc32(bytes);assert(filename.length<=65535,'制品文件名过长');
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(0x21,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(filename.length,26);
    const index=Buffer.alloc(46);index.writeUInt32LE(0x02014b50);index.writeUInt16LE(20,4);index.writeUInt16LE(20,6);index.writeUInt16LE(0x800,8);index.writeUInt16LE(0x21,14);index.writeUInt32LE(crc,16);index.writeUInt32LE(bytes.length,20);index.writeUInt32LE(bytes.length,24);index.writeUInt16LE(filename.length,28);index.writeUInt32LE(offset,42);
    local.push(header,filename,bytes);central.push(index,filename);centralSize+=46+filename.length;offset+=30+filename.length+bytes.length;
    entries.push({path:name,bytes:bytes.length,sha256:sha256(bytes)});
  }
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);
  assert(offset+centralSize+22<=MAX_BYTES,'制品ZIP超过256MiB采集预算');
  const archive=Buffer.concat([...local,...central,end]),file=safePath(root,BUILD_ARCHIVE_PATH);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,archive,{flag:'wx',mode:0o600});
  return {path:BUILD_ARCHIVE_PATH,sha256:sha256(archive),bytes:archive.length,entries};
}
