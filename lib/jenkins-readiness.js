import path from 'node:path';
import {readFileSync} from 'node:fs';
import {loadJenkinsCluster} from './jenkins-cluster.js';
import {loadFleetConfig} from './jenkins-fleet.js';
import {GATE_ROOT,gateRuntimeHash,validateJenkinsRegistry,digest} from './jenkins-integration.js';
import {entryPointHash} from './jenkins-entry-contract.js';
import {readControlledJson,controlledPath} from './control-store.js';
const assert=(ok,m)=>{if(!ok)throw Error(m);};
const placeholder=/REPLACE(?:_|\b)|CHANGE[_ -]?ME|example\.(?:internal|com|org|net)\b/;
// Offline handover checks, deliberately distinct from credentials, provider
// permissions, a real scan, formal Review and actual notification delivery.
export function inspectJenkinsReadiness({clusterFile}={}){
 const steps=[];let c;const check=(id,owner,fn)=>{try{const detail=fn();steps.push({id,owner,status:'passed',detail});return true;}catch(e){steps.push({id,owner,status:'blocked',detail:e.message});return false;}};
 const json=file=>{const v=readControlledJson(file);assert(!placeholder.test(JSON.stringify(v)),`${path.basename(file)}仍含模板占位值，需工程维护者交付批准配置`);return v;};
 if(check('节点公共入口','运维',()=>{c=loadJenkinsCluster(clusterFile);assert(c.nativeEntry.runtimeHash===gateRuntimeHash()&&digest(readFileSync(controlledPath(c.nativeEntry.loaderFile)))===c.nativeEntry.loaderHash,'公共入口或Gate包字节不匹配，重新准备节点');return '包字节、公共入口与集群配置一致';})){
  check('项目登记','工程维护者',()=>{let total=0;for(const f of c.registryFiles){const r=validateJenkinsRegistry(json(f));assert(r.jenkinsOrigin===c.jenkinsOrigin&&r.gateRoot===GATE_ROOT&&entryPointHash(r.nativeEntry)===entryPointHash(c.nativeEntry),'登记与当前集群、Gate或公共入口不一致');for(const b of r.bindings){assert(b.runtimeHash===c.nativeEntry.runtimeHash,'项目登记仍引用旧Gate');total++;}}return `已登记${total}个项目分支范围`;});
  check('批量接入清单','工程维护者',()=>{const file=path.join(c.configDir,'jenkins-fleet.json');json(file);const f=loadFleetConfig(file);assert(f.jenkinsOrigin===c.jenkinsOrigin&&f.registryFiles.every(v=>c.registryFiles.includes(v)),'批量清单引用另一集群或未批准登记');assert(f.approvers.length>0,'批量清单未设置批准人');json(f.automationConfigFile);return `批准项目${f.selection.projects.join('、')}；分支${f.selection.branches.join('、')}`;});
  check('采集与审核配置','工程维护者',()=>{const required={'automation-config.json':['sources','dataDir'],'governance-config.json':['projects','publicKeyFile'],'control-config.json':['identity','authorizationIssuer'],'review-publish-config.json':['projects','reviewPrivateKeyEnv']};for(const [name,keys] of Object.entries(required)){const v=json(path.join(c.configDir,name));assert(v.schemaVersion===1&&keys.every(k=>v[k]&&(!Array.isArray(v[k])||v[k].length)),name+'缺少必要结构；空对象不算已交付配置');}return '4类中央配置已提供且无模板占位值；运行时仍由Jenkins严格预检';});
 }
 return {schemaVersion:1,kind:'jenkins-offline-handover-check',status:steps.every(s=>s.status==='passed')?'handover-files-ready':'blocked',steps,networkExecuted:false,credentialVerification:'pending-jenkins',businessClosure:'pending-field-acceptance'};
}
