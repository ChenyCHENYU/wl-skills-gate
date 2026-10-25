import path from 'node:path';
import {existsSync,mkdirSync,writeFileSync,renameSync,readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {controlledPath,readControlledJson} from './control-store.js';
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
export function validateOpsDirectory(value){
 assert(value?.schemaVersion===1&&value.kind==='wl-ops-responsibility-directory'&&object(value.people)&&object(value.owners),'运行责任目录格式无效');
 for(const [id,p] of Object.entries(value.people)){assert(/^[A-Za-z0-9_.-]{1,128}$/.test(id)&&object(p)&&typeof p.name==='string'&&p.name.trim(),'责任目录人员无效');if(p.feishu)assert(['user_id','open_id'].includes(p.feishu.idType)&&/^[A-Za-z0-9_-]{1,128}$/.test(p.feishu.id)&&p.feishu.id!=='all','责任目录飞书身份无效');}
 for(const owner of Object.values(value.owners))assert(object(owner)&&['technicalManager','executor','managerSubmissionNotify'].every(k=>!owner[k]||Object.hasOwn(value.people,owner[k])),'项目责任人引用不存在');
 for(const id of value.approvedCorrections?.people||[])assert(Object.hasOwn(value.people,id),'修订人员引用不存在');
 for(const change of value.approvedCorrections?.technicalManagers||[])assert(typeof change.from==='string'&&Object.hasOwn(value.people,change.to),'经理修订引用无效');
 assert(!value.defaults?.managerSubmissionNotify||Object.hasOwn(value.people,value.defaults.managerSubmissionNotify),'默认同步人引用不存在');
 assert(!value.publicTasks||Array.isArray(value.publicTasks.recipients)&&value.publicTasks.recipients.every(id=>Object.hasOwn(value.people,id)),'公共任务提醒人引用不存在');
 assert(!value.networkAccess||['intranet-vpn','public','unknown'].includes(value.networkAccess),'报告网络条件无效');return value;
}
export function loadOpsDirectory(configDir){const file=path.join(configDir,'ops-responsibility-directory.json');return existsSync(file)?validateOpsDirectory(readControlledJson(file)):null;}
export function mergeOpsDirectory(config, directory){
 if(!directory)return config;validateOpsDirectory(directory);
 const owners={};for(const key of new Set([...Object.keys(directory.owners),...Object.keys(config.owners||{})])){const seed=directory.owners[key],live=config.owners?.[key];owners[key]={...directory.defaults,...(typeof seed==='string'?{technicalManager:seed}:seed),...(typeof live==='string'?{technicalManager:live}:live)};}
 const people={...directory.people,...config.people};for(const id of directory.approvedCorrections?.people||[])people[id]={...people[id],...directory.people[id]};
 for(const owner of Object.values(owners))for(const change of directory.approvedCorrections?.technicalManagers||[])if(owner.technicalManager===change.from)owner.technicalManager=change.to;
 return {...config,people,owners,publicTasks:config.publicTasks||directory.publicTasks,networkAccess:config.networkAccess||directory.networkAccess};
}
export function prepareOpsDirectory({configDir,seedFile,confirm=false}){
 assert(confirm===true,'责任目录接入需要明确执行确认');configDir=controlledPath(path.resolve(configDir));seedFile=controlledPath(path.resolve(seedFile));const seed=validateOpsDirectory(readControlledJson(seedFile)),file=controlledPath(path.join(configDir,'ops-responsibility-directory.json'));
 const before=existsSync(file)?readFileSync(file,'utf8'):null;const old=loadOpsDirectory(configDir);const next=old?{...seed,...old,people:{...seed.people,...old.people},owners:{...seed.owners,...old.owners}}:seed;
 if(seed.approvedCorrections){next.approvedCorrections=seed.approvedCorrections;const corrected=mergeOpsDirectory({people:next.people,owners:next.owners},seed);next.people=corrected.people;next.owners=corrected.owners;}
 const text=JSON.stringify(next,null,2)+'\n';if(existsSync(file)&&readFileSync(file,'utf8')===text)return {status:'unchanged',file,people:Object.keys(next.people).length};
 mkdirSync(configDir,{recursive:true,mode:0o700});const temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,text,{flag:'wx',mode:0o600});assert((existsSync(file)?readFileSync(file,'utf8'):null)===before,'责任目录已并发变化，未覆盖；重跑即可复用新配置');renameSync(temp,file);
 return {status:old?'supplemented':'created',file,people:Object.keys(next.people).length,owners:Object.keys(next.owners).length,seedHash:createHash('sha256').update(readFileSync(seedFile)).digest('hex'),existingPeoplePreserved:!!old,grantsReviewAuthority:false};
}
