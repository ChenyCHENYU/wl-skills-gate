import path from 'node:path';
import {readFileSync} from 'node:fs';
import {controlledPath,readControlledJson} from './control-store.js';
import {GATE_ROOT,GATE_VERSION,gateRuntimeHash,validateJenkinsRegistry,digest,inside} from './jenkins-integration.js';
import {jobPath} from './jenkins-fleet-client.js';
import {validateNativeEntry,entryPointHash} from './jenkins-entry-contract.js';
const assert=(ok,m)=>{if(!ok)throw Error(m);};
export const MAINTENANCE_JOBS={node:'wl-quality-doctor',verify:'wl-quality-verify',automation:'wl-quality-central',review:'wl-quality-review',fleet:'wl-quality-fleet'};
export const defaultClusterFile=env=>env.WL_QUALITY_CLUSTER_CONFIG||'/srv/wl-quality/config/jenkins-cluster.json';
export function loadJenkinsCluster(file){
 file=controlledPath(path.resolve(file));const c=readControlledJson(file),base=path.dirname(file);
 assert(c.schemaVersion===1&&c.kind==='wl-quality-jenkins-cluster'&&Object.keys(c).every(k=>['schemaVersion','kind','jenkinsOrigin','registryFiles','configDir','nodeBinDir','agents','nativeEntry'].includes(k)),'需要有效的集群接入配置');
 if(c.nodeBinDir!==undefined){assert(typeof c.nodeBinDir==='string'&&path.isAbsolute(c.nodeBinDir)&&!/[\u0000-\u001f'"`$\\]/.test(c.nodeBinDir),'Node目录须为受控绝对路径');c.nodeBinDir=controlledPath(c.nodeBinDir);}
 const u=new URL(c.jenkinsOrigin);assert(u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash,'集群入口须为批准HTTPS origin');c.jenkinsOrigin=u.origin+'/';validateNativeEntry(c.nativeEntry);
 assert(Array.isArray(c.registryFiles)&&c.registryFiles.length>0&&c.registryFiles.length<=1000&&new Set(c.registryFiles).size===c.registryFiles.length,'需要无重复的批准登记路径');c.registryFiles=c.registryFiles.map(v=>{assert(typeof v==='string'&&v,'登记路径无效');return controlledPath(path.resolve(base,v));});
 assert(typeof c.configDir==='string'&&c.configDir,'缺少中央配置目录');c.configDir=controlledPath(path.resolve(base,c.configDir));
 assert(c.agents&&Object.keys(c.agents).every(k=>['central','review'].includes(k))&&['central','review'].every(k=>/^[A-Za-z0-9_.-]{1,100}$/.test(c.agents[k]||'')),'需要明确的中央和独立签发节点标签');
 for(const f of [file,c.configDir,c.nativeEntry.loaderFile,...c.registryFiles])assert(!process.env.WORKSPACE||!inside(path.resolve(process.env.WORKSPACE),f),'集群配置和批准登记须位于业务工作区外');return {...c,file,configHash:digest(readFileSync(file))};
}
export async function resolveJenkinsContext({role='auto',configFile=defaultClusterFile(process.env),env=process.env,verifyEntry=false}={}){
 const c=loadJenkinsCluster(configFile);assert(env.JENKINS_URL===c.jenkinsOrigin&&/^[1-9][0-9]*$/.test(env.BUILD_NUMBER||'')&&env.JOB_NAME,'需要当前批准Jenkins及真实运行编号');assert(env.BUILD_URL===new URL(jobPath(env.JOB_NAME)+env.BUILD_NUMBER+'/',c.jenkinsOrigin).href,'当前运行地址与集群/Job不匹配');
 const actualRole=Object.entries(MAINTENANCE_JOBS).find(([,job])=>job===env.JOB_NAME)?.[0]||'job';if(role==='auto')role=actualRole;assert(role===actualRole,'当前Job不是该受控入口，不能借公共方法取得另一类节点或凭据');
 let registryFile=c.registryFiles[0],agentLabel=role==='review'?c.agents.review:c.agents.central,gateRoot=GATE_ROOT;
 if(role==='job'){
  const matches=[];for(const file of c.registryFiles){const r=validateJenkinsRegistry(readControlledJson(file));assert(r.jenkinsOrigin===c.jenkinsOrigin,'登记来自其他集群');if(r.bindings.some(b=>Object.values(b.jobs).includes(env.JOB_NAME)))matches.push({file,r});}
  assert(matches.length===1,'当前Job必须唯一登记，不按名称猜测项目或分支');const selected=matches[0];registryFile=selected.file;agentLabel=selected.r.agentLabel;gateRoot=selected.r.gateRoot;
  assert(entryPointHash(selected.r.nativeEntry)===entryPointHash(c.nativeEntry),'登记与集群公共入口不一致，先更新批准登记');assert(selected.r.bindings.find(b=>Object.values(b.jobs).includes(env.JOB_NAME)).runtimeHash===gateRuntimeHash(),'跨节点包字节不一致，不能路由到另一套规则');
 }
 if(verifyEntry){assert(c.nativeEntry.runtimeHash===gateRuntimeHash(),'Gate运行时与批准公共入口不一致');assert(digest(readFileSync(controlledPath(c.nativeEntry.loaderFile)))===c.nativeEntry.loaderHash,'服务器公共入口被修改，停止执行');}
 return {schemaVersion:1,kind:'wl-quality-jenkins-context',role,agentLabel,gateRoot,nodeBinDir:c.nodeBinDir||path.dirname(process.execPath),registry:registryFile,configDir:c.configDir,clusterFile:c.file,jenkinsOrigin:c.jenkinsOrigin,nativeEntry:c.nativeEntry,entryVerified:verifyEntry,gateVersion:GATE_VERSION,runtimeHash:gateRuntimeHash(),clusterHash:c.configHash,qualityPassed:false,buildAuthorized:false};
}
