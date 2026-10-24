import { mkdirSync, lstatSync, readFileSync, writeSync, existsSync, openSync, closeSync, fstatSync, ftruncateSync, constants } from 'node:fs';
import path from 'node:path';
import { REVIEW_DIMENSIONS } from './review.js';

// Presentation diagnostics only. Classification never changes policy or grants admission.
const categories = [
  ['sandbox','Jenkins沙箱兼容性','cicd',/Scripts not permitted|RejectedAccessException|JsonSlurper|No such DSL method.*readJSON/i,'运维使用当前增量包更新受控入口；确认Pipeline Utility Steps已启用。不要关闭Sandbox或逐项批准旧JsonSlurper方法。'],
  ['project-integration','项目接入缺项','governance',/workspace\.json|项目.*(?:未.*接入|清单)|PROJECT-GATE|GATE-VERSION|INSTALLED-|DECLARED-/i,'技术经理通过项目增量／接入入口补齐配置和固定依赖，提交后重新检查。'],
  ['local-evidence','本地门槛未核验','submission',/local.*hook|本地.*(?:检查|回执)|--no-verify/i,'核对当前提交的本地检查回执；缺失不能证明使用了--no-verify，由服务端独立复查。'],
  ['review','Review／授权未通过','review',/review|复核|审核|授权|签发|签名|authorization|reviewer/i,'技术经理核对本轮SHA、九维证据、复核人和有效授权；重新复核后签发，不沿用旧记录。'],
  ['source','候选／批准配置不一致','branch',/SHA|源码|分支|checkout|检出|sourceDigest|漂移|摘要|本轮.*(?:项目|版本)|登记.*(?:变化|不匹配)/i,'核对目标分支、当前SHA与批准摘要；重新生成本轮检查，配置变更由维护者审阅批准。'],
  ['access','凭据／访问失败','cicd',/凭据|credential|403|401|permission|权限|token|ECONN|ENOTFOUND|网络|TLS|certificate/i,'运维核对指定凭据ID、只读／触发权限、网络和内网CA；不要关闭校验或在群中提供密钥。'],
  ['dependencies','固定依赖准备失败','governance',/ci-prepare|依赖|lockfile|pnpm|npm|maven|prepare|preparation/i,'核对固定锁文件、批准安装源和节点工具；修复原失败项后重跑增量复验，不删除锁或绕过门禁。'],
  ['tests','测试检查未通过','tests',/junit|单测|测试|TEST\b/i,'执行人修复失败用例或测试环境并重跑；技术经理核对原始测试记录。'],
  ['scan','检查失效／结果缺失','scan',/扫描|检查|report|报告|summary|CHECK-|执行失效|未完成|missing/i,'恢复具体检查和报告生成；必须取得当前SHA的有效结果，不能把检查失效记成零问题。'],
  ['environment','节点环境未就绪','cicd',/node|python|java|命令|PATH|ENOENT|ENOSPC|EACCES|Gate.*(?:目录|入口|版本)|运行时|runtime/i,'运维在实际执行节点核对工具版本、路径、权限和固定Gate快照，再运行增量复验。'],
];
export function diagnosticText(value, env = process.env, max = 600) {
  let text=String(value ?? '').replace(/\x1b\[[0-9;]*m/g,'').replace(/[\u0000-\u001f\u007f]/g,' ');
  for(const [key,secret] of Object.entries(env))if(/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTHORIZATION|CREDENTIAL/i.test(key)&&typeof secret==='string'&&secret.length>=4)text=text.replaceAll(secret,'[已隐藏]');
  return text.replace(/https?:\/\/[^\s<>)]+/g,raw=>{try{const u=new URL(raw);return `${u.origin}${u.pathname.includes('/hook/')?'/[机器人地址已隐藏]':u.pathname}`;}catch{return '[地址已隐藏]';}})
    .replace(/\b(?:npm_[A-Za-z0-9]+|Bearer\s+\S+)/gi,'[已隐藏]')
    .replace(/\b(token|password|secret|authorization)\s*[:=]\s*[^\s;,]+/gi,'$1=[已隐藏]').slice(0,max);
}
export function failureDiagnostic(reason,{stage='',command='',env=process.env,dimension}={}) {
  const safe=diagnosticText(reason,env),match=categories.find(row=>row[3].test(safe+' '+command));
  const [category,label,id,,action]=match || ['execution','阶段执行失败','cicd',null,'运维与执行人核对本阶段命令、退出码和原始记录；补齐具体失败记录后重跑，不能放行后续构建。'];
  return {category,label,dimension:REVIEW_DIMENSIONS.some(d=>d.id===dimension)?dimension:id,stage:diagnosticText(stage,env,100),reason:safe||'本阶段未产生可用的失败说明',action};
}
export function pipelineDiagnostics(summary) {
  const entries=(summary.checks||[]).filter(c=>!['ok','passed'].includes(c.status)).map(c=>failureDiagnostic(`${c.checkId}：${c.reason || c.note || '必需检查没有有效结果'}`,{stage:'质量检查',command:c.tool||''}));
  if(summary.decision?.status!=='passed')for(const reason of summary.decision?.reasons||[])if(!entries.some(d=>d.reason.includes(reason)))entries.push(failureDiagnostic(reason,{stage:'门禁判定'}));
  if(!entries.length&&summary.decision?.status==='invalid')entries.push(failureDiagnostic('本轮必需检查失效，但未记录具体checkId与失败原因',{stage:'质量检查'}));
  return [...new Map(entries.map(d=>[d.category+':'+d.reason,d])).values()];
}
export function findingDimensions(findings) {
  return REVIEW_DIMENSIONS.map(d=>({...d,counts:Object.fromEntries(['blocker','error','warning','info'].map(level=>[level,findings.filter(f=>f.dimension===d.id||f.dimension===d.name).filter(f=>f.severity===level).length]))})).filter(d=>Object.values(d.counts).some(Boolean));
}

// Capture the real CLI error while it is available, rather than asking a later
// post handler to infer it from an exit code. Never used as quality evidence.
export function recordJenkinsFailure(error,{env=process.env,root=process.cwd(),command='',stage=env.WL_GATE_PHASE||''}={}) {
  if(!env.JOB_NAME||!/^\d+$/.test(env.BUILD_NUMBER||'')||!env.JENKINS_URL)return false;
  let fd;
  try {
    const relative=`quality-reports/ci-integration/failure-${env.BUILD_NUMBER}.json`;let current=path.resolve(root);
    for(const part of relative.split('/').slice(0,-1)){current=path.join(current,part);if(existsSync(current)){if(!lstatSync(current).isDirectory()||lstatSync(current).isSymbolicLink())return false;}else mkdirSync(current,{mode:0o700});}
    const file=path.join(root,relative);let prior=[];
    if(existsSync(file)&&lstatSync(file).isSymbolicLink())return false;
    fd=openSync(file,constants.O_RDWR|constants.O_CREAT|(constants.O_NOFOLLOW||0),0o600);
    const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>16384)return false;
    if(stat.size){const v=JSON.parse(readFileSync(fd,'utf8'));if(v.job!==env.JOB_NAME||v.buildNumber!==env.BUILD_NUMBER)return false;prior=v.diagnostics||[];if(!Array.isArray(prior))return false;}
    const diagnostic=failureDiagnostic(error?.message||error,{stage,command,env});
    const result={schemaVersion:1,kind:'wl-jenkins-failure',job:env.JOB_NAME,buildNumber:env.BUILD_NUMBER,createdAt:new Date().toISOString(),diagnostics:[...prior,diagnostic].slice(0,3),qualityPassed:false,buildAuthorized:false};
    ftruncateSync(fd,0);const bytes=Buffer.from(JSON.stringify(result,null,2)+'\n');
    let offset=0;while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset,offset);
    return true;
  }catch{return false;}finally{if(fd!==undefined)closeSync(fd);}
}
