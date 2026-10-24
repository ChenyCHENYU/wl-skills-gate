import path from 'node:path';
import {readFileSync,lstatSync,existsSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {GATE_ROOT,gateRuntimeHash,digest} from './jenkins-integration.js';
import {controlledPath} from './control-store.js';
import {stableStringify} from './util.js';
import {nativePipelineEntry} from './jenkins-entry-contract.js';
import {jenkinsBootstrapHelper} from './jenkins-bootstrap.js';
import {defaultOpsConfiguration} from './jenkins-ops.js';
const assert=(ok,m)=>{if(!ok)throw Error(m);};
const quote=v=>"'"+v.replaceAll("'","'\\''")+"'";
export function planJenkinsInstallation(options={}){
 assert(Object.keys(options).every(k=>['prefix','configDir','jenkinsOrigin','registryFiles','centralAgentLabel','reviewSignerAgentLabel','confirm','planHash'].includes(k)),'未知安装配置，不忽略拼写错误');
 let {prefix,configDir,jenkinsOrigin,registryFiles,centralAgentLabel,reviewSignerAgentLabel}=options;
 assert([prefix,configDir].every(v=>typeof v==='string'&&path.isAbsolute(v)&&!/[\u0000-\u001f'"`$\\]/.test(v)),'安装和中央配置须为受控绝对路径');prefix=controlledPath(prefix);configDir=controlledPath(configDir);
 const u=new URL(jenkinsOrigin);assert(u.protocol==='https:'&&u.pathname==='/'&&!u.username&&!u.password&&!u.search&&!u.hash,'安装需要批准Jenkins HTTPS origin');assert([centralAgentLabel,reviewSignerAgentLabel].every(v=>/^[A-Za-z0-9_.-]{1,100}$/.test(v||'')),'需要现场实际中央及独立签发节点标签');
 registryFiles||=[path.join(configDir,'jenkins-bindings.json')];assert(Array.isArray(registryFiles)&&registryFiles.length>0&&registryFiles.every(v=>path.isAbsolute(v)),'批准登记路径须明确');
 const clusterFile=path.join(configDir,'jenkins-cluster.json'),loaderFile=path.join(prefix,'jenkins/entry.groovy'),aliasFile=path.join(prefix,'bin/wl-quality');
 const nodeBinDir=controlledPath(path.dirname(process.execPath));assert(!/[\u0000-\u001f'"`$\\]/.test(nodeBinDir),'Node安装路径含不支持的字符');
 const loader=jenkinsBootstrapHelper()+readFileSync(path.join(GATE_ROOT,'templates/ci/jenkins-loader.groovy'),'utf8').replaceAll('__WL_GATE_ROOT__',GATE_ROOT).replaceAll('__WL_CLUSTER_FILE__',clusterFile).replaceAll('__WL_RUNTIME_HASH__',gateRuntimeHash()).replaceAll('__WL_NODE_BIN_DIR__',nodeBinDir).replaceAll('__WL_CONFIG_DIR__',configDir).replaceAll('__WL_JENKINS_ORIGIN__',u.origin+'/');
 const nativeEntry={loaderFile,loaderHash:digest(loader),runtimeHash:gateRuntimeHash()};
 const c={schemaVersion:1,kind:'wl-quality-jenkins-cluster',jenkinsOrigin:u.origin+'/',registryFiles,configDir,nodeBinDir,agents:{central:centralAgentLabel,review:reviewSignerAgentLabel},nativeEntry};
 const opsFile=path.join(configDir,'jenkins-ops.json');
 const presentationFile=path.join(configDir,'notification-presentation.json');
 const files=[{file:loaderFile,text:loader,mode:0o644},{file:aliasFile,text:'#!/bin/sh\nset -eu\nPATH='+quote(nodeBinDir)+':"$PATH"\nexport PATH\nexec '+quote(process.execPath)+' '+quote(path.join(GATE_ROOT,'bin/wl-quality.js'))+' "$@"\n',mode:0o755},{file:clusterFile,text:JSON.stringify(c,null,2)+'\n',mode:0o600},{file:opsFile,text:existsSync(opsFile)?readFileSync(controlledPath(opsFile),'utf8'):JSON.stringify(defaultOpsConfiguration(),null,2)+'\n',mode:0o600}].map(f=>{controlledPath(f.file);const before=existsSync(f.file)?readFileSync(f.file,'utf8'):null;return {...f,before,action:before===f.text&&(lstatSync(f.file).mode&0o777)===f.mode?'unchanged':before===null?'create':'update'};});
 controlledPath(presentationFile);
 const displayBefore=existsSync(presentationFile)?readFileSync(presentationFile,'utf8'):null;
 files.push({file:presentationFile,text:displayBefore??readFileSync(path.join(GATE_ROOT,'templates/platform/notification-presentation.json'),'utf8'),mode:0o600,before:displayBefore,action:displayBefore===null?'create':'unchanged'});
 const plan={kind:'wl-quality-installation-plan',prefix,configDir,runtimeHash:gateRuntimeHash(),files,nativeEntry,pipelineScript:nativePipelineEntry(nativeEntry),nodeEnvironment:{'PATH+WLQUALITY':path.join(prefix,'bin'),WL_NODE_BIN_DIR:nodeBinDir,WL_QUALITY_CLUSTER_CONFIG:clusterFile},routerLabel:'wl-quality-router'};return {...plan,planHash:digest(stableStringify(plan)),status:'preview'};
}
export function applyJenkinsInstallation(options={}){
 const plan=planJenkinsInstallation(options);assert(options.confirm===true&&options.planHash===plan.planHash,'准备执行须绑定当前路径、包版本和差异计划');
 for(const f of plan.files){if(f.action==='unchanged')continue;const before=existsSync(f.file)?readFileSync(f.file,'utf8'):null;assert(before===f.before,'安装配置发生并发变化，重新预览');mkdirSync(path.dirname(f.file),{recursive:true,mode:0o700});const temp=f.file+'.'+randomUUID()+'.tmp';writeFileSync(temp,f.text,{flag:'wx',mode:f.mode});renameSync(temp,f.file);}
 return {status:'jenkins-common-entry-prepared',command:path.join(plan.prefix,'bin/wl-quality'),clusterFile:path.join(plan.configDir,'jenkins-cluster.json'),nodeEnvironment:plan.nodeEnvironment,routerLabel:plan.routerLabel,nativeEntry:plan.nativeEntry,pipelineScript:plan.pipelineScript,jenkinsConfigured:false,remoteModified:false};
}
