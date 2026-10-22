import path from 'node:path';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {GATE_ROOT,gateRuntimeHash} from '../lib/jenkins-integration.js';
import {controlledPath} from '../lib/control-store.js';

const args=process.argv.slice(2);
if(args.length && (args.length!==2 || args[0]!=='--out' || !args[1]))throw Error('用法：node scripts/verify-quality-chain.mjs [--out 新验收目录]');
const out=controlledPath(path.resolve(args[1] || `quality-reports/chain-verification-${Date.now()}`));
if(existsSync(out))throw Error('验收目录已存在，禁止覆盖原始回执');
mkdirSync(out,{recursive:true,mode:0o700});
const startedAt=new Date().toISOString(),runtimeFingerprint=gateRuntimeHash();
const tests=['jenkins-full-chain','jenkins-integration','jenkins-fleet','jenkins-native','prevention-project-chain','prevention-governance-chain','build-findings-admission','report-publication','pipeline-notification','setup-central','feishu-members'];
const stages=[['chain-tests',['--test','--test-reporter=tap',...tests.map(name=>`scripts/lib-tests/${name}.test.mjs`)]],['full-system-closure',['--test','--test-reporter=tap','scripts/lib-tests/prevention-full-system.test.mjs']],['rule-fixtures',['scripts/run-fixtures.mjs']],['cli-integration',['scripts/run-integration.mjs']]];
const results=[];
for(const [name,command] of stages){
  process.stdout.write(`${name}：执行中\n`);
  const started=Date.now(),result=spawnSync(process.execPath,command,{cwd:GATE_ROOT,encoding:'utf8',maxBuffer:32*1024*1024,env:{...process.env,WL_FULL_CHAIN_EVIDENCE_DIR:path.join(out,'evidence'),WL_PREVENTION_PROJECT_EVIDENCE_ROOT:path.join(out,'project-producer'),WL_PREVENTION_BRIDGE_WRITE:'1',...(name==='full-system-closure'?{WL_FULL_CHAIN_BRIDGE_INPUT_DIR:path.join(out,'project-producer')}:{})}});
  const log=(result.stdout || '')+(result.stderr || '')+(result.error?`\n${result.error.message}`:'');writeFileSync(path.join(out,name+'.log'),log,{mode:0o600});
  const count=key=>Number([...log.matchAll(new RegExp(`^# ${key} (\\d+)$`,'gm'))].at(-1)?.[1] || 0);
  results.push({name,exitCode:result.status,durationMs:Date.now()-started,...(['chain-tests','full-system-closure'].includes(name)?{tests:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped')}:{}),log:name+'.log'});
  process.stdout.write(`${name}：${result.status===0?'通过':'失败，查看原始日志'}\n`);
  if(result.status!==0)break;
}
const unchanged=gateRuntimeHash()===runtimeFingerprint;
const receipt={schemaVersion:1,kind:'quality-chain-simulation',startedAt,finishedAt:new Date().toISOString(),status:results.length===stages.length && results.every(r=>r.exitCode===0) && unchanged?'passed':'failed',
  runtimeFingerprint,packageUnchangedDuringTests:unchanged,stages:results,
  realExecution:['isolated-git-hooks-frontend-backend','gate-scan','approved-script-repair-and-rescan','nine-dimension-review','oidc-protocol-and-separate-signatures','review-to-build-dispatch','canary-business-build','artifact-zip-verification','central-source-collection','durable-signed-feishu-outbox','independent-verification-and-close'],
  simulation:{externalApisMocked:true,dependencyDownloadsIsolated:true,businessAndPeopleFixtures:true,realChatContacted:false},
  fieldAcceptance:{businessRepositories:false,jenkinsRuntime:false,centralSsoDeployment:false,realMentions:false,groupReportPermissions:false},
  note:'同一候选贯通与前后端Hook/修复/闭环回归均留原件。模拟通过不能代替现场业务覆盖、Jenkins/SSO部署、真实群@及报告权限验收；TCP监听用例在宿主禁止时明确跳过。'};
writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
process.stdout.write(JSON.stringify({status:receipt.status,receipt:path.join(out,'receipt.json'),stages:results},null,2)+'\n');
process.exitCode=receipt.status==='passed'?0:1;
