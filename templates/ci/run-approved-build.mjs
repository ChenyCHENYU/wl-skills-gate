#!/usr/bin/env node
// The approved, read-only shell script lives outside the candidate workspace.
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {recordJenkinsFailure} from '../../lib/notification-diagnostics.js';
import { controlledPath } from '../../lib/control-store.js';

try {
  const [script, expectedHash, ...extra] = process.argv.slice(2);
  if (!script || !path.isAbsolute(script) || !/^[a-f0-9]{64}$/.test(expectedHash || '') || extra.length) throw new Error('必须提供工作区外批准的构建脚本绝对路径和SHA256');
  const root = realpathSync(process.cwd()), file = realpathSync(controlledPath(script)), relative = path.relative(root, file);
  if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('构建入口不能来自业务候选工作区');
  if (createHash('sha256').update(readFileSync(file)).digest('hex') !== expectedHash) throw new Error('批准构建脚本摘要不匹配');
  const execution = spawn('/bin/sh', [file], { cwd: root, shell: false, stdio: ['inherit','pipe','pipe'], env: process.env });
  let tail='';
  for(const [stream,output] of [[execution.stdout,process.stdout],[execution.stderr,process.stderr]])stream.on('data',chunk=>{output.write(chunk);tail=(tail+chunk.toString()).slice(-8192);});
  const result=await new Promise(resolve=>{execution.once('error',error=>resolve({code:2,message:error.message}));execution.once('close',(code,signal)=>resolve({code:Number.isInteger(code)?code:2,message:signal?`进程被${signal}终止`:''}));});
  process.exitCode=result.code;
  if(result.code){const lines=tail.split(/\r?\n/).filter(line=>/error|fatal|failed|exception|错误|失败/i.test(line));recordJenkinsFailure(`批准业务脚本退出${result.code}：${result.message || lines.slice(-3).join('；') || '业务命令未输出可识别的错误说明'}`,{command:'approved-build'});}
} catch (error) {
  recordJenkinsFailure(error,{command:'approved-build'});
  console.error(`[approved-build] ${error.message}`);
  process.exitCode = 2;
}
