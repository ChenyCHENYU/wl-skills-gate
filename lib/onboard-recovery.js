import path from 'node:path';
import {existsSync,readdirSync,readFileSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {safePath} from './source-state.js';
const hash=v=>createHash('sha256').update(v).digest('hex');
const stable=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function read(root,relative){const f=safePath(root,relative);if(!lstatSync(f).isFile()||lstatSync(f).size>8*1024*1024)throw Error('接入恢复回执不是受控大小的普通文件');return JSON.parse(readFileSync(f,'utf8'));}
function relative(root,file){const r=path.relative(root,file).split(path.sep).join('/');if(!r||r.startsWith('../')||path.isAbsolute(r))throw Error('接入恢复回执路径越界');return r;}

// A failed first installation has no adopted HEAD yet. Recovery recognizes only
// the original package plan AND its immutable execution/session chain, binding
// every project-owned hook, loader and policy byte before allowing a new plan.
// This is local migration evidence, never a CI approval or release signature.
export function recoverIncompleteAdoption({root,kind,manifestText}){
  const folder=safePath(root,'quality-reports/setup');if(!existsSync(folder))return null;
  const manifest=JSON.parse(manifestText);
  if(manifest.kind!=='wl-quality-workspace'||manifest.schemaVersion!==1||manifest.projectKind!==kind)return null;
  const sessions=readdirSync(folder).filter(n=>uuid.test(n));if(sessions.length>1000)throw Error('接入历史过多，先归档后恢复，未自动选择不完整证据');
  for(const id of sessions){
    try{
      const session=read(root,'quality-reports/setup/'+id+'/result.json');
      if(session.schemaVersion!==1||session.kind!=='project-setup-session'||session.sessionId!==id||session.root!==root||session.localValidated===true||!['blocked','approval-required'].includes(session.status))continue;
      for(const step of session.steps||[]){
        if(!step.planFile||!step.receipt)continue;
        const planPath=relative(root,step.planFile),receiptPath=relative(root,step.receipt);
        if(!new RegExp('^quality-reports/setup/'+id+'/plan-[1-9][0-9]*\\.json$').test(planPath)||!/^quality-reports\/onboarding\/executions\/[a-f0-9-]+\.json$/.test(receiptPath))continue;
        const plan=read(root,planPath),execution=read(root,receiptPath),{planHash,...unsigned}=plan;
        if(plan.schemaVersion!==1||execution.schemaVersion!==1||plan.kind!=='project-onboarding'||plan.root!==root||plan.projectKind!==kind||hash(stable(unsigned))!==planHash||execution.kind!=='onboarding-execution'||execution.root!==root||execution.projectKind!==kind||execution.planHash!==planHash||execution.runId!==path.basename(receiptPath,'.json')||execution.localValidated===true)continue;
        if(!['onboarding-execution-blocked','native-approval-required','local-readiness-blocked','lock-approval-required','pom-approval-required'].includes(execution.status))continue;
        if(!/^[a-f0-9]{40,64}$/.test(plan.head||'')||spawnSync('git',['merge-base','--is-ancestor',plan.head,'HEAD'],{cwd:root}).status!==0)continue;
        if(!Array.isArray(plan.files)||plan.files.length>1000)continue;
        const files=new Map();let invalid=false;
        for(const entry of plan.files||[]){
          if(files.has(entry.path)||typeof entry.path!=='string'||typeof entry.afterContent!=='string'||hash(entry.afterContent)!==entry.afterHash){invalid=true;break;}
          const f=safePath(root,entry.path);
          if(!existsSync(f)||hash(readFileSync(f))!==entry.afterHash){invalid=true;break;}
          files.set(entry.path,entry.afterHash);
        }
        if(invalid||files.get('quality/workspace.json')!==hash(manifestText))continue;
        const owned=[...(manifest.managedFiles||[]),...(manifest.hookFiles||[])];
        if(!owned.length||owned.some(f=>files.get(f.path)!==f.sha256)||!files.has('quality/review-policy.json')||!files.has('quality/review-evidence.plan.json')||!['quality/policy.yml','quality/policy.yaml','quality/policy.json'].some(f=>files.has(f)))continue;
        return {manifest,sha256:hash(manifestText),recovery:true,files:Object.fromEntries(files),evidence:{session:id,planFile:planPath,executionFile:receiptPath,planHash,localOnly:true,remoteValidated:false}};
      }
    }catch{/* Incomplete, changed or foreign evidence cannot authorize migration. */}
  }
  return null;
}
