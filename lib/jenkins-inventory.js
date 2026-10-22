import {createHash} from 'node:crypto';
import {fleetClient,jobPath,fleetAssert as assert} from './jenkins-fleet-client.js';
import {parseXml} from './xml.js';
import {isManagedJob,xmlDescendants} from './jenkins-job-config.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const gap=(code,message)=>({code,message});
const nodes=(node,name)=>xmlDescendants(node).filter(v=>v.name===name);
const child=(node,name)=>{const values=node.children.filter(v=>v.name===name);return values.length===1&&!values[0].children.length?values[0].text.trim():null;};
const identifier=value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
const safeBranch=value=>typeof value==='string'&&value.length>0&&value.length<=250&&!/[\s\u0000-\u001f\u007f$\\~^:?\[\]]/.test(value)&&!value.includes('..')&&!value.includes('@{');
const safeCredential=value=>typeof value==='string'&&value.length<=250&&!/[\u0000-\u001f\u007f${}]/.test(value);
function repository(value){
 if(typeof value!=='string'||!value||value.length>2048||/[\s\u0000-\u001f\u007f${}]/.test(value))return null;
 if(/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(value))return value;
 try{const u=new URL(value);if(!['https:','ssh:'].includes(u.protocol)||!u.hostname||u.password||u.search||u.hash||u.pathname==='/'||!u.pathname)return null;if(u.username&&!(u.protocol==='ssh:'&&u.username==='git'))return null;return value;}catch{return null;}
}
const dynamic=value=>{const m=/^(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*))$/.exec(value||'');return m?.[1]||m?.[2]||null;};
function branches(values,gaps){
 const names=[],variables=new Set();
 for(const value of values){const key=dynamic(value);if(key){variables.add(key);continue;}if(safeBranch(value))names.push(value);else gaps.push(gap('unsupported-branch','分支表达式不是可确认的静态引用。'));}
 if(variables.size>1||variables.size&&names.length){gaps.push(gap('ambiguous-branch','同一SCM存在多个分支来源，须明确项目分支映射。'));return {branches:[]};}
 if(variables.size){gaps.push(gap('dynamic-branch','分支取自运行参数；参数默认值不是本轮实际分支。'));return {branches:[],dynamicBranch:[...variables][0]};}
 return {branches:[...new Set(names)]};
}

// A deliberately small lexical reader, never a Groovy interpreter. Strings are
// opaque, comments are discarded, and only direct environment literals and
// named git arguments are considered. Unsupported expressions stay unknown.
function tokens(script){
 const out=[];let i=0;
 while(i<script.length){
  const c=script[i];
  if(c==='\r'||c==='\n'){out.push({type:'break',value:'\n'});i++;continue;}
  if(/\s/.test(c)){i++;continue;}
  if(script.startsWith('//',i)){const end=script.indexOf('\n',i+2);i=end<0?script.length:end;continue;}
  if(script.startsWith('/*',i)){const end=script.indexOf('*/',i+2);if(end<0)return null;i=end+2;continue;}
  if(script.startsWith('$/',i)){const end=script.indexOf('/$',i+2);if(end<0)return null;out.push({type:'opaque',value:''});i=end+2;continue;}
  if(c==='"'||c==="'"){
   const triple=script.startsWith(c.repeat(3),i),delimiter=triple?c.repeat(3):c,start=i+delimiter.length;let j=start,escaped=false;
   while(j<script.length){if(script[j]==='\\'){escaped=true;j+=2;continue;}if(script.startsWith(delimiter,j))break;j++;}
   if(j>=script.length)return null;
   const value=script.slice(start,j);out.push({type:triple||escaped||value.includes('$')?'opaque':'string',value:triple||escaped||value.includes('$')?'':value});i=j+delimiter.length;continue;
  }
  // Slashy Groovy strings may contain fake calls. Treat the entire literal as
  // opaque rather than accidentally discovering its text as executable code.
  if(c==='/'&&['=','(',':',',','['].includes(out.at(-1)?.value)){
   let j=i+1;while(j<script.length){if(script[j]==='\\'){j+=2;continue;}if(script[j]==='/')break;j++;}if(j>=script.length)return null;out.push({type:'opaque',value:''});i=j+1;continue;
  }
  const word=/^[A-Za-z_][A-Za-z0-9_]*/.exec(script.slice(i));if(word){out.push({type:'word',value:word[0]});i+=word[0].length;continue;}
  out.push({type:'punct',value:c});i++;
 }
 return out;
}
function inlineScm(script,gaps){
 const t=tokens(script);if(!t){gaps.push(gap('unsupported-inline-script','内联脚本语法不能安全静态识别，未执行脚本。'));return [];}
 const literal=new Map(),assigned=new Set();let depth=0,environmentDepth=null;
 for(let i=0;i<t.length;i++){
  if(t[i].value==='{'&&t[i-1]?.value==='environment')environmentDepth=depth+1;
  if(t[i].value==='{')depth++;
  if(environmentDepth===depth&&['GIT_URL','GIT_CREDENTIAL_ID'].includes(t[i].value)&&t[i+1]?.value==='='){
   const key=t[i].value,end=t[i+3],valid=t[i+2]?.type==='string'&&(!end||end.type==='break'||[';','}'].includes(end.value));
   if(assigned.has(key)||!valid)literal.set(key,null);else literal.set(key,t[i+2].value);assigned.add(key);
  }
  if(t[i].value==='}'){if(environmentDepth===depth)environmentDepth=null;depth--;}
 }
 const candidates=[];
 for(let i=0;i<t.length;i++){
  if(t[i].type!=='word'||t[i].value!=='git'||['.','def'].includes(t[i-1]?.value))continue;
  let j=i+1,paren=false;if(t[j]?.value==='('){paren=true;j++;}if(t[j]?.type!=='word'||t[j+1]?.value!==':')continue;
  const args=new Map();let valid=true;
  while(j<t.length){
   while(t[j]?.type==='break')j++;
   if(t[j]?.type!=='word'||t[j+1]?.value!==':'){valid=false;break;}
   const key=t[j].value;j+=2;let value;
   if(t[j]?.type==='string'){value={literal:t[j].value};j++;}
   else if(t[j]?.value==='env'&&t[j+1]?.value==='.'&&t[j+2]?.type==='word'){value={env:t[j+2].value};j+=3;}
   else{valid=false;break;}
   if(args.has(key)){valid=false;break;}args.set(key,value);
   if(t[j]?.value===','){j++;continue;}
   if(paren){while(t[j]?.type==='break')j++;if(t[j]?.value!==')')valid=false;}
   else if(t[j]&&t[j].type!=='break'&&![';','}'].includes(t[j].value))valid=false;
   break;
  }
  const url=args.get('url'),credential=args.get('credentialsId'),branch=args.get('branch');
  const resolve=(v,key)=>v?.literal??(v?.env===key?literal.get(key):undefined);
  const repo=repository(resolve(url,'GIT_URL')),cred=resolve(credential,'GIT_CREDENTIAL_ID');
  if(!valid||!repo||credential&&!safeCredential(cred)||!branch||branch.env&&!identifier(branch.env)||branch.literal!==undefined&&!safeBranch(branch.literal)){
   gaps.push(gap('unsupported-inline-checkout','内联git检出不是唯一完整的字面参数，须明确仓库、凭据及分支映射。'));continue;
  }
  const b=branch.env?{branches:[],dynamicBranch:branch.env}:{branches:[branch.literal]};
  candidates.push({repository:repo,credentialId:credential?cred:'',...b});
  if(branch.env)gaps.push(gap('dynamic-branch','分支取自运行参数；参数默认值不是本轮实际分支。'));
 }
 if(!candidates.length)gaps.push(gap('scm-unknown','未发现可安全识别的SCM配置，未执行内联Groovy。'));
 else gaps.push(gap('inline-candidate-unapproved','内联脚本仅静态提取候选，实际运行及接入范围仍须确认。'));
 return candidates;
}
function scm(tree,gaps){
 const candidates=[],gitScms=xmlDescendants(tree).filter(n=>n.attrs.class==='hudson.plugins.git.GitSCM'||n.name==='hudson.plugins.git.GitSCM');
 for(const node of gitScms){
  const remotes=nodes(node,'hudson.plugins.git.UserRemoteConfig');
  if(remotes.length!==1){gaps.push(gap('ambiguous-repository','一个SCM包含多个或缺失仓库，未自动选择。'));continue;}
  const remote=remotes[0],repo=repository(child(remote,'url')),credentialId=child(remote,'credentialsId')??'';
  if(!repo||!safeCredential(credentialId)){gaps.push(gap('invalid-repository','仓库地址包含凭据、动态表达式或不支持的格式，未保留地址。'));continue;}
  const specs=nodes(node,'hudson.plugins.git.BranchSpec').map(n=>child(n,'name'));
  if(!specs.length)gaps.push(gap('branch-unknown','SCM未明确声明分支，未使用默认分支推断。'));
  candidates.push({repository:repo,credentialId,...branches(specs,gaps)});
 }
 if(!gitScms.length&&tree.name==='flow-definition'){
  const definitions=tree.children.filter(n=>n.name==='definition');
  if(definitions.length===1&&definitions[0].attrs.class==='org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition'){
   const scripts=definitions[0].children.filter(n=>n.name==='script');
   if(scripts.length===1&&!scripts[0].children.length)candidates.push(...inlineScm(scripts[0].text,gaps));
  }
 }
 const unique=[...new Map(candidates.map(v=>[JSON.stringify(v),v])).values()];
 if(new Set(unique.map(v=>v.repository)).size>1){gaps.push(gap('ambiguous-repository','任务含多个仓库候选，须明确业务仓库映射，未自动选择。'));return [];}
 if(!unique.length&&!gaps.length)gaps.push(gap('scm-unknown','未发现可安全识别的Git SCM配置。'));
 return unique;
}
function parameterDefaults(tree,candidates,gaps){
 const names=new Set(candidates.map(v=>v.dynamicBranch).filter(Boolean)),values=[];
 for(const name of names){
  const matches=xmlDescendants(tree).filter(n=>/ParameterDefinition$/.test(n.name)&&child(n,'name')===name);
  if(matches.length===1){const value=child(matches[0],'defaultValue');if(value&&safeBranch(value))values.push({name,defaultValue:value});}
  else if(matches.length>1)gaps.push(gap('ambiguous-parameter','分支参数重复声明，未采纳参数默认值。'));
 }
 return values;
}

// First-use read-only discovery intentionally has no dependency on project
// bindings, fleet approval files, Gate installation or central automation.
export async function discoverJenkinsJobs({jenkinsOrigin,inventory={},env=process.env,fetchImpl=fetch}={}){
 assert(inventory&&typeof inventory==='object'&&!Array.isArray(inventory)&&Object.keys(inventory).every(k=>['roots','maxJobs','maxDepth'].includes(k)),'盘点参数无效');
 const options={roots:[''],maxJobs:1000,maxDepth:8,...inventory};
 assert(Array.isArray(options.roots)&&options.roots.length>0&&options.roots.length<=100&&options.roots.every(r=>typeof r==='string'),'需要明确的盘点根目录');
 assert(Number.isInteger(options.maxJobs)&&options.maxJobs>0&&options.maxJobs<=2000&&Number.isInteger(options.maxDepth)&&options.maxDepth>0&&options.maxDepth<=12,'盘点数量或深度预算无效');
 for(const root of options.roots)if(root)jobPath(root);
 const client=fleetClient({origin:jenkinsOrigin,env,fetchImpl}),queue=[...new Set(options.roots)].map(root=>({root,depth:0})),seen=new Set(),visited=new Set(),jobs=[],errors=[];let budget=false;
 while(queue.length&&!budget){
  const {root,depth}=queue.shift();if(visited.has(root))continue;visited.add(root);
  try{
   const data=await client.json((root?jobPath(root):'')+'api/json?tree=jobs[name,_class]');assert(Array.isArray(data.jobs),'盘点接口未返回任务列表');
   for(const item of data.jobs){
    if(!item||typeof item.name!=='string'||item.name.includes('/')){errors.push({root,code:'invalid-job',reason:'盘点返回无效任务名称，未继续该项。'});continue;}
    const job=root?root+'/'+item.name:item.name;try{jobPath(job);}catch{errors.push({root,code:'invalid-job',reason:'盘点返回不支持的任务名称，未继续该项。'});continue;}
    if(seen.has(job))continue;if(seen.size>=options.maxJobs){errors.push({root,code:'job-budget-exceeded',reason:'任务数超过盘点预算，结果不完整。'});budget=true;break;}seen.add(job);
    const type=typeof item._class==='string'&&/^[A-Za-z_$][A-Za-z0-9_.$]{0,249}$/.test(item._class)?item._class:'unknown';
    if(/(?:^|\.)(?:Folder|OrganizationFolder|WorkflowMultiBranchProject)$/.test(type)){
     if(depth>=options.maxDepth)errors.push({job,code:'depth-budget-exceeded',reason:'目录超过盘点深度，结果不完整。'});else queue.push({root:job,depth:depth+1});continue;
    }
    const record={job,type,status:'unreadable',managed:false,configHash:null,scmCandidates:[],discoveryGaps:[]};
    try{
     const xml=await client.config(job);assert(xml!==null,'盘点期间任务已消失：HTTP 404');record.configHash=hash(xml);const tree=parseXml(xml);record.managed=isManagedJob(xml);record.scmCandidates=scm(tree,record.discoveryGaps);const defaults=parameterDefaults(tree,record.scmCandidates,record.discoveryGaps);if(defaults.length)record.parameterDefaults=defaults;record.status=record.discoveryGaps.length?'attention':'read';
    }catch(error){record.discoveryGaps.push(gap('job-unreadable',String(error.message).replace(/https?:\/\/[^\s]+/g,'[URL omitted]').slice(0,300)));}
    record.discoveryGaps=[...new Map(record.discoveryGaps.map(v=>[v.code,v])).values()];jobs.push(record);
   }
  }catch(error){errors.push({root,code:'root-unreadable',reason:String(error.message).replace(/https?:\/\/[^\s]+/g,'[URL omitted]').slice(0,300)});}
 }
 return {kind:'jenkins-ops-inventory',status:errors.length||jobs.some(v=>v.status!=='read')?'attention':'inventoried',jobs,errors,remoteModified:false};
}
