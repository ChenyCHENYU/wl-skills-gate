import path from 'node:path';
import {readFileSync} from 'node:fs';
import {loadJenkinsCluster,MAINTENANCE_JOBS} from './jenkins-cluster.js';
import {nativePipelineEntry} from './jenkins-entry-contract.js';
import {fleetClient} from './jenkins-fleet-client.js';
import {jobContract,escapeXml} from './jenkins-job-config.js';
import {gateRuntimeHash,digest} from './jenkins-integration.js';
import {controlledPath,writeExclusiveJson} from './control-store.js';
import {stableStringify} from './util.js';
const assert=(ok,m)=>{if(!ok)throw Error(m);};
export async function planJenkinsBootstrap({configFile,env=process.env,fetchImpl=fetch}={}){
 const c=loadJenkinsCluster(configFile),script=nativePipelineEntry(c.nativeEntry),client=fleetClient({origin:c.jenkinsOrigin,env,fetchImpl});
 assert(c.nativeEntry.runtimeHash===gateRuntimeHash()&&digest(readFileSync(controlledPath(c.nativeEntry.loaderFile)))===c.nativeEntry.loaderHash,'准备公共任务前先修复安装包/入口漂移');
 const entries=[];
 for(const [role,job] of Object.entries(MAINTENANCE_JOBS)){
  const before=await client.config(job);let action='create',reason='';
  if(before!==null){try{const v=jobContract(before);const schedule=role==='node'?'H/5 * * * *':'* * * * *';const ownedSchedule=['node','automation','review'].includes(role)&&v.triggers.length===1&&v.triggers[0].type==='hudson.triggers.TimerTrigger'&&v.triggers[0].fields.spec===schedule;assert(v.script===script.trim()&&v.sandbox==='true'&&v.disabled==='false'&&v.concurrent&&(!v.triggers.length||ownedSchedule),'同名任务存在自定义脚本／触发器或已禁用');action='unchanged';}catch(e){action='blocked';reason=e.message;}}
  // The operator creates this single initial job; never mutate a running self.
  if(role==='fleet'&&before===null){action='blocked';reason='先创建wl-quality-fleet并填入生成的一行入口';}
  entries.push({role,job,action,...(reason?{reason}:{}),beforeHash:before===null?null:digest(before)});
 }
 const plan={schemaVersion:1,kind:'wl-quality-native-bootstrap',clusterHash:c.configHash,runtimeHash:gateRuntimeHash(),entries,businessBuildsTriggered:false};
 return {...plan,planHash:digest(stableStringify(plan)),status:entries.some(e=>e.action==='blocked')?'blocked':'preview'};
}
const renderJob=script=>`<flow-definition plugin="workflow-job"><actions/><description>WL Gate common task</description><keepDependencies>false</keepDependencies><properties><org.jenkinsci.plugins.workflow.job.properties.DisableConcurrentBuildsJobProperty><abortPrevious>false</abortPrevious></org.jenkinsci.plugins.workflow.job.properties.DisableConcurrentBuildsJobProperty></properties><definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition" plugin="workflow-cps"><script>${escapeXml(script)}</script><sandbox>true</sandbox></definition><disabled>false</disabled></flow-definition>\n`;
export async function applyJenkinsBootstrap(options={}){
 const p=await planJenkinsBootstrap(options);assert(options.confirm===true&&p.planHash===options.planHash,'公共任务创建须确认当前预览摘要；配置变化后重新预览');assert(p.status!=='blocked','同名任务存在阻断，不覆盖');
 const c=loadJenkinsCluster(options.configFile),client=fleetClient({origin:c.jenkinsOrigin,env:options.env,fetchImpl:options.fetchImpl,write:true}),script=nativePipelineEntry(c.nativeEntry),entries=[];
 for(const entry of p.entries){if(entry.action==='unchanged'){entries.push({...entry,status:'verified'});continue;}
  try{assert(await client.config(entry.job)===null,'同名Job在预览后已被创建，重新预览');let unknown=null;try{await client.write(entry.job,renderJob(script),true);}catch(e){unknown=e;}
   const actual=await client.config(entry.job);assert(actual!==null,unknown?.message||'写入后任务未出现');const v=jobContract(actual);assert(v.script===script.trim()&&v.sandbox==='true'&&v.disabled==='false'&&!v.triggers.length&&v.concurrent,'公共任务写入未通过回读核验');entries.push({...entry,status:'verified',...(unknown?{writeReconciled:true}:{})});
  }catch(e){entries.push({...entry,status:'attention',reason:e.message});}
 }
 return {status:entries.every(e=>e.status==='verified')?'common-jobs-verified':'attention',entries,businessBuildsTriggered:false,schedulesEnabled:false,remotePermissionsAndBusinessClosureValidated:false};
}
export async function runBootstrapCli(argv){
 const o={};for(let i=0;i<argv.length;i++){const k=argv[i];assert(['--config','--out','--confirm','--plan-hash'].includes(k)&&!Object.hasOwn(o,k),'未知或重复公共任务参数');if(k==='--confirm')o[k]=true;else{const v=argv[++i];assert(v&&!v.startsWith('--'),'参数缺值');o[k]=v;}}
 assert(o['--config'],'需要集群配置');const args={configFile:path.resolve(o['--config']),confirm:o['--confirm'],planHash:o['--plan-hash']},r=o['--confirm']?await applyJenkinsBootstrap(args):await planJenkinsBootstrap(args);if(o['--out'])writeExclusiveJson(path.resolve(o['--out']),r);else console.log(JSON.stringify(r,null,2));return ['attention','blocked'].includes(r.status)?2:0;
}
