import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { discoverCiRuns } from '../../lib/ci-discovery.js';
const sha='a'.repeat(40), origin='https://ci.example.invalid', now=Date.parse('2026-10-15T03:00:00Z'), since='2026-10-15T00:00:00Z';
const xml='<flow-definition/>', env={CI_TOKEN:'CREDENTIAL_MUST_NOT_LEAK',CI_USER:'reader'};
function fixture(t,system='gitlab') {
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'wl-ci-discovery-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config={schemaVersion:1,system,project:'produce',scope:'standard',ref:system==='gitlab'?'uat':'origin/uat',baseUrl:origin,tokenEnv:'CI_TOKEN',requiredJobs:system==='gitlab'?['quality','unit']:['produce/build'],artifacts:{job:system==='gitlab'?'quality':'produce/build',paths:['quality/summary.json']},...(system==='gitlab'?{projectId:12,trustedRunnerIds:[77]}:{jobPath:'produce/build',userEnv:'CI_USER',jobConfigHash:createHash('sha256').update(xml).digest('hex')})};
  const pipelines=[{id:45,project_id:12,sha,ref:'uat',status:'success',created_at:'2026-10-15T01:00:00Z',web_url:`${origin}/p/45`,user:{id:8,name:'display-name-is-not-identity'}}];
  const jobs=['quality','unit'].map((name,i)=>({id:60+i,name,pipeline:{id:45},commit:{id:sha,author_email:'must-not-use@example.invalid'},ref:'uat',allow_failure:false,runner:{id:77},status:'success'}));
  const builds=[{number:45,timestamp:Date.parse('2026-10-15T01:00:00Z'),url:`${origin}/job/produce/job/build/45/`,building:false,result:'SUCCESS',actions:[{lastBuiltRevision:{SHA1:sha,branch:[{name:'origin/uat',SHA1:sha}]}},{causes:[{_class:'hudson.model.Cause$UserIdCause',userId:'jenkins-user',userName:'not-an-identity'}]}],artifacts:[]}];
  let modify=(u,v)=>v;const calls=[];const configFile=path.join(root,'source.json');
  const fetchImpl=async(url,init)=>{const u=new URL(url);calls.push({url,init});assert.equal(init.method,'GET');assert.equal(init.redirect,'error');let value;
    if(u.pathname.endsWith('/config.xml'))return new Response(xml);
    if(system==='gitlab'){
      if(u.pathname.endsWith('/pipelines'))value=pipelines.map(p=>({id:p.id}));
      else if(u.pathname.endsWith('/jobs'))value=jobs;
      else value=pipelines.find(p=>u.pathname.endsWith(`/pipelines/${p.id}`));
    }else if(u.pathname==='/job/produce/job/build/api/json')value={builds:builds.map(({number,timestamp})=>({number,timestamp}))};
    else value=builds.find(b=>u.pathname.endsWith(`/${b.number}/api/json`));
    value=modify(u,structuredClone(value));if(value instanceof Response)return value;return new Response(JSON.stringify(value));};
  const run=(overrides={})=>{writeFileSync(configFile,JSON.stringify(config));return discoverCiRuns({configFile,actors:{'8':'employee8','jenkins-user':'employee9'},since,now,env,fetchImpl,...overrides});};
  return {config,pipelines,jobs,builds,calls,run,modify:(fn)=>modify=fn};
}
for(const system of ['gitlab','jenkins'])test(`${system}固定来源发现真实运行，中央映射责任人并绑定稳定revision`,async(t)=>{
  const f=fixture(t,system),r=await f.run();assert.equal(r.complete,true);assert.equal(r.runs.length,1);assert.equal(r.runs[0].runId,45);assert.equal(r.runs[0].sha,sha);assert.equal(r.runs[0].terminal,true);assert.equal(r.runs[0].status,'success');assert.equal(r.runs[0].authorId,system==='gitlab'?'employee8':'employee9');assert.equal(r.runs[0].dueAt,'2026-10-15T02:00:00.000Z');assert.match(r.runs[0].observedRevision,/^[a-f0-9]{64}$/);assert(!JSON.stringify(r).includes(env.CI_TOKEN));assert.equal((await f.run()).runs[0].observedRevision,r.runs[0].observedRevision);
});
test('GitLab未创建和取消的必需作业仍被发现，不能以没有报告跳过',async(t)=>{const f=fixture(t);f.jobs.pop();f.jobs[0].status='canceled';f.pipelines[0].status='canceled';const r=await f.run();assert.equal(r.runs.length,1);assert.deepEqual(r.runs[0].missingJobs,['unit']);assert.equal(r.runs[0].terminal,true);assert.equal(r.runs[0].sourceStatus,'canceled');assert.equal(r.runs[0].status,'incomplete');});
for(const system of ['gitlab','jenkins'])test(`${system}未映射实际用户不冒充成功，commit/参数/显示名不能代替`,async(t)=>{const f=fixture(t,system);if(system==='gitlab')f.pipelines[0].user={id:99,name:'employee8'};else f.builds[0].actions[1].causes=[{_class:'malicious.UserIdCause',userId:'jenkins-user',userName:'employee9'}];const r=await f.run();assert.equal(r.runs[0].authorId,null);assert.equal(r.runs[0].status,'unmapped-actor');});
test('GitLab两种分页按中央ref和since查询完整作业清单',async(t)=>{
  const f=fixture(t);f.config.discovery={pageSize:1};f.modify((u,v)=>{if(u.pathname.endsWith('/pipelines')){assert.equal(u.searchParams.get('ref'),'uat');assert.equal(u.searchParams.get('updated_after'),'2026-10-15T00:00:00.000Z');return new Response(JSON.stringify(u.searchParams.get('page')==='1'?v:[]),{headers:u.searchParams.get('page')==='1'?{'x-next-page':'2'}:{}});}if(u.pathname.endsWith('/jobs')){const first=u.searchParams.get('page')==='1', second=u.searchParams.get('page')==='2';return new Response(JSON.stringify(first?[v[0]]:second?[v[1]]:[]),{headers:first?{'x-next-page':'2'}:{}});}return v;});
  const r=await f.run();assert.equal(r.runs[0].requiredJobs.length,2);assert.equal(r.complete,true);assert(f.calls.some(c=>c.url.includes('page=2')));
});
test('Jenkins列表范围分页、实际SCM和核心Cause逐build复查',async(t)=>{const f=fixture(t,'jenkins');f.config.discovery={pageSize:1};f.modify((u,v)=>u.pathname==='/job/produce/job/build/api/json'&&u.searchParams.get('tree').includes('{1,2}')?{builds:[]}:v);const r=await f.run();assert.equal(r.runs[0].authorId,'employee9');assert(f.calls.some(c=>new URL(c.url).searchParams.get('tree')?.includes('{1,2}')));});
for(const [name,mutate]of[
 ['错误SHA',(f)=>f.pipelines[0].sha='wrong'],['错误ref',(f)=>f.pipelines[0].ref='prd'],['其他项目',(f)=>f.pipelines[0].project_id=99],['外部URL',(f)=>f.pipelines[0].web_url='https://evil.invalid/p/45']
])test(`GitLab单run${name}进入发现错误，不拖垮其他运行`,async(t)=>{const f=fixture(t);const good=structuredClone(f.pipelines[0]);good.id=46;good.web_url=`${origin}/p/46`;f.pipelines.push(good);mutate(f);f.modify((u,v)=>u.pathname.includes('/pipelines/46/jobs')?v.map(j=>({...j,pipeline:{id:46}})):v);const r=await f.run();assert.equal(r.complete,false);assert.equal(r.discoveryErrors.length,1);assert.equal(r.discoveryErrors[0].runId,45);assert.equal(r.runs.length,1);assert.equal(r.runs[0].runId,46);});
test('GitLab必需作业错误Runner/允许失败不能登记为成功',async(t)=>{const f=fixture(t);f.jobs[0].runner.id=99;f.jobs[1].allow_failure=true;const r=await f.run();assert.equal(r.runs[0].status,'incomplete');assert.deepEqual(r.runs[0].missingJobs,['quality','unit']);});
for(const system of ['gitlab','jenkins'])test(`${system}采集时状态漂移保留明确runId错误，不能混用快照`,async(t)=>{const f=fixture(t,system);let reads=0;f.modify((u,v)=>{if(system==='gitlab'&&u.pathname.endsWith('/jobs')&&++reads===2)v[0].id=99;if(system==='jenkins'&&u.pathname.endsWith('/45/api/json')&&++reads===2)v.result='FAILURE';return v;});const r=await f.run();assert.equal(r.runs.length,0);assert.equal(r.discoveryErrors[0].runId,45);assert.match(r.discoveryErrors[0].reason,/改变/);assert.equal(r.discoveryErrors[0].pipelineUrl,system==='gitlab'?`${origin}/p/45`:`${origin}/job/produce/job/build/45/`);});
test('重新发现同run真实重试产生新revision，重复稳定事实不变',async(t)=>{const f=fixture(t);const first=await f.run();f.jobs[0].id=100;const second=await f.run();assert.notEqual(first.runs[0].observedRevision,second.runs[0].observedRevision);});
for(const system of ['gitlab','jenkins'])test(`${system}窗口之前的历史运行不登记新预期`,async(t)=>{const f=fixture(t,system);if(system==='gitlab')f.pipelines[0].created_at='2026-10-14T01:00:00Z';else f.builds[0].timestamp=Date.parse('2026-10-14T01:00:00Z');assert.equal((await f.run()).runs.length,0);});
test('无窗口/未来窗口/不固定HTTPS/分页预算直接拒绝',async(t)=>{const f=fixture(t);await assert.rejects(f.run({since:undefined}),/窗口/);await assert.rejects(f.run({since:'2027-01-01T00:00:00Z'}),/窗口/);f.config.baseUrl='http://ci.example.invalid';await assert.rejects(f.run(),/HTTPS/);f.config.baseUrl=origin;f.config.discovery={maxPages:0};await assert.rejects(f.run(),/预算/);});
test('坏分页不会默默当作抓取完成，凭据不出现在错误和响应证据',async(t)=>{const f=fixture(t);f.modify((u,v)=>u.pathname.endsWith('/pipelines')?new Response(JSON.stringify(v),{headers:{'x-next-page':'99'}}):v);await assert.rejects(f.run(),error=>/分页/.test(error.message)&&!error.message.includes(env.CI_TOKEN));});
test('HTTP重定向/超大响应/服务返回凭据都拒绝保存',async(t)=>{const f=fixture(t);for(const response of [new Response('',{status:302,headers:{location:'https://evil.invalid'}}),new Response('{}',{headers:{'content-length':String(20*1024*1024)}}),new Response(JSON.stringify({token:env.CI_TOKEN}))])await assert.rejects(f.run({fetchImpl:async()=>response}));});
test('Jenkins共享作业中其他真实分支不串入当前ref的预期',async(t)=>{const f=fixture(t,'jenkins');f.builds[0].actions[0].lastBuiltRevision.branch[0].name='origin/prd';const r=await f.run();assert.equal(r.runs.length,0);assert.equal(r.complete,true);});
test('Jenkins参数里的SHA和用户不能顶替真实SCM/UserIdCause',async(t)=>{const f=fixture(t,'jenkins');f.builds[0].actions=[{parameters:[{name:'SHA',value:sha},{name:'userId',value:'jenkins-user'}]}];const r=await f.run();assert.equal(r.runs.length,0);assert.equal(r.discoveryErrors.length,1);assert.match(r.discoveryErrors[0].reason,/真实SCM/);assert.equal(r.discoveryErrors[0].pipelineUrl,`${origin}/job/produce/job/build/45/`);});

test('GitLab超过默认1000条历史返回可续游标，后续批次推进完整水位而不永久超预算',async(t)=>{
  const f=fixture(t), template=structuredClone(f.pipelines[0]); f.pipelines.splice(0,f.pipelines.length,...Array.from({length:1001},(_,index)=>({...structuredClone(template),id:45+index,web_url:`${origin}/p/${45+index}`})));
  f.modify((u,v)=>{if(u.pathname.endsWith('/pipelines')){const page=Number(u.searchParams.get('page')),size=Number(u.searchParams.get('per_page')),rows=v.slice((page-1)*size,page*size);return new Response(JSON.stringify(rows),{headers:page*size<v.length?{'x-next-page':String(page+1)}:{}});}if(u.pathname.endsWith('/jobs')){const runId=Number(u.pathname.match(/pipelines\/(\d+)\/jobs/)[1]);return v.map((job,index)=>({...job,id:runId*10+index,pipeline:{id:runId}}));}return v;});
  const first=await f.run();assert.equal(first.runs.length,1000);assert.equal(first.partial,true);assert.equal(first.watermark,null);assert.equal(first.nextCursor.page,11);
  const second=await f.run({cursor:first.nextCursor,now:now+60000});assert.equal(second.runs.length,1);assert.equal(second.runs[0].runId,1045);assert.equal(second.windowComplete,true);assert.equal(second.watermark,new Date(now).toISOString());assert.equal(second.nextCursor,null);
});
test('增量窗口与显式重查不重新遍历历史，单坏run可保留并推进完整窗口水位',async(t)=>{
  const f=fixture(t);let listWindow;f.modify((u,v)=>{if(u.pathname.endsWith('/pipelines')){listWindow=u.searchParams.get('updated_after');return [];}return v;});
  const updatedSince='2026-10-15T02:00:00Z',r=await f.run({updatedSince,recheckRunIds:[45]});assert.equal(listWindow,'2026-10-15T02:00:00.000Z');assert.equal(r.runs.length,1);assert.equal(r.windowComplete,true);
  f.pipelines[0].sha='invalid';const failed=await f.run({updatedSince,recheckRunIds:[45]});assert.equal(failed.discoveryErrors[0].runId,45);assert.equal(failed.windowComplete,true);assert.equal(failed.complete,false);assert.equal(failed.watermark,new Date(now).toISOString());
});
test('Jenkins高水位跳过历史，未完成运行仍可按真实ID显式复查',async(t)=>{
  const f=fixture(t,'jenkins');const first=await f.run({afterRunId:45});assert.equal(first.runs.length,0);assert.equal(first.windowComplete,true);
  const second=await f.run({afterRunId:45,recheckRunIds:[45]});assert.equal(second.runs.length,1);assert.equal(second.runs[0].runId,45);assert.equal(second.highWatermarkRunId,45);
});
test('分页游标不能切换配置/起始范围，非法列表ID整次拒绝而非错误推进水位',async(t)=>{
  const f=fixture(t);f.config.discovery={maxRuns:1,pageSize:1};f.modify((u,v)=>u.pathname.endsWith('/pipelines')?new Response(JSON.stringify(v),{headers:{'x-next-page':'2'}}):v);
  const first=await f.run();assert.equal(first.partial,true);await assert.rejects(f.run({cursor:{...first.nextCursor,configHash:'0'.repeat(64)}}),/游标/);
  f.modify((u,v)=>u.pathname.endsWith('/pipelines')?[{id:'wrong'}]:v);await assert.rejects(f.run(),/运行ID/);
});

function automaticJenkins(f, mutation=(value)=>value) {
  f.config.actorSource={system:'gitlab',baseUrl:'https://gitlab.example.invalid',projectId:12,ref:'uat',tokenEnv:'GITLAB_TOKEN'};
  f.builds[0].actions[1].causes=[{_class:'hudson.triggers.SCMTrigger$SCMTriggerCause'}];
  const mr={id:800,iid:2,project_id:12,target_project_id:12,state:'merged',target_branch:'uat',merge_commit_sha:sha,squash_commit_sha:null,author:{id:8}};
  return async(url,init)=>{const u=new URL(url);let value;if(u.origin==='https://gitlab.example.invalid'){assert.equal(init.headers['PRIVATE-TOKEN'],'separate-gitlab-read-secret');assert.equal(init.headers.Authorization,undefined);value=u.pathname.endsWith(`/commits/${sha}/merge_requests`)?[mr]:mr;value=mutation(structuredClone(value),u);}else{assert.ok(init.headers.Authorization.startsWith('Basic '));assert.equal(init.headers['PRIVATE-TOKEN'],undefined);if(u.pathname.endsWith('/config.xml'))return new Response(xml);value=u.pathname==='/job/produce/job/build/api/json'?{builds:f.builds.map(({number,timestamp})=>({number,timestamp}))}:f.builds.find(b=>u.pathname.endsWith(`/${b.number}/api/json`));}return new Response(JSON.stringify(value));};
}
test('Jenkins自动SCM触发以唯一已合并MR真实SHA/作者绑定身份，凭据按官方来源隔离',async(t)=>{
  const f=fixture(t,'jenkins'),fetchImpl=automaticJenkins(f);const r=await f.run({fetchImpl,actors:{'gitlab:8':'actual-author'},env:{...env,GITLAB_TOKEN:'separate-gitlab-read-secret'}});assert.equal(r.runs[0].authorId,'actual-author');assert.equal(r.runs[0].actorSource.mechanism,'merged-commit-association');assert.equal(r.runs[0].actorSource.mappingKey,'gitlab:8');assert.equal(r.runs[0].status,'success');assert(!JSON.stringify(r).includes('separate-gitlab-read-secret'));
});
for(const [name,mutate]of[
 ['未合并',(v)=>Array.isArray(v)?v.map(m=>({...m,state:'opened'})):v],['其他目标分支',(v)=>Array.isArray(v)?v.map(m=>({...m,target_branch:'prd'})):v],['不同合并SHA',(v)=>Array.isArray(v)?v.map(m=>({...m,merge_commit_sha:'b'.repeat(40)})):v],['多份MR关联',(v)=>Array.isArray(v)?[...v,{...v[0],id:801,iid:3}]:v],['其他项目',(v)=>Array.isArray(v)?v.map(m=>({...m,project_id:99,target_project_id:99})):v]
])test(`Jenkins自动触发${name}不能冒充认证作者`,async(t)=>{const f=fixture(t,'jenkins'),fetchImpl=automaticJenkins(f,mutate);const r=await f.run({fetchImpl,actors:{'gitlab:8':'actual-author'},env:{...env,GITLAB_TOKEN:'separate-gitlab-read-secret'}});assert.equal(r.runs[0].authorId,null);assert.equal(r.runs[0].status,'unmapped-actor');});
test('上游MR详情作者漂移被拒绝，数字Jenkins映射不会误当GitLab用户身份',async(t)=>{
  const f=fixture(t,'jenkins'),fetchImpl=automaticJenkins(f,(value)=>Array.isArray(value)?value:{...value,author:{id:9}});const r=await f.run({fetchImpl,actors:{'gitlab:8':'author'},env:{...env,GITLAB_TOKEN:'separate-gitlab-read-secret'}});assert.equal(r.runs.length,0);assert.match(r.discoveryErrors[0].reason,/作者/);
  const plain=fixture(t,'jenkins'),other=await plain.run({fetchImpl:automaticJenkins(plain),actors:{'8':'jenkins-numeric-user'},env:{...env,GITLAB_TOKEN:'separate-gitlab-read-secret'}});assert.equal(other.runs[0].authorId,null);
});

test('总时间预算在页内耗尽保留当前offset，不给未完成运行造失败或完整水位',async(t)=>{
  const f=fixture(t);f.config.discovery={maxDurationMs:100};const good=structuredClone(f.pipelines[0]);good.id=46;good.web_url=`${origin}/p/46`;f.pipelines.push(good);let elapsed=0,first=true;
  const fetchImpl=async(url,init)=>{const u=new URL(url);if(u.pathname.endsWith('/pipelines'))return new Response(JSON.stringify([{id:45},{id:46}]));if(u.pathname.endsWith('/pipelines/46')){elapsed=100;return new Response(JSON.stringify(good));}if(u.pathname.endsWith('/jobs'))return new Response(JSON.stringify(f.jobs));if(u.pathname.endsWith('/pipelines/45'))return new Response(JSON.stringify(f.pipelines[0]));throw new Error('unexpected');};
  const r=await f.run({fetchImpl,monotonicNow:()=>elapsed});assert.equal(r.runs.length,1);assert.equal(r.runs[0].runId,45);assert.equal(r.partial,true);assert.equal(r.watermark,null);assert.equal(r.nextCursor.page,1);assert.equal(r.nextCursor.offset,1);assert.deepEqual(r.discoveryErrors,[]);assert.deepEqual(r.attemptedRecheckRunIds,[]);
});
test('重查耗尽只返回实际尝试ID，尚未尝试ID不推进轮转',async(t)=>{
  const f=fixture(t);f.config.discovery={maxDurationMs:50};let elapsed=0,calls=0;
  const r=await f.run({recheckRunIds:[45,46,47],monotonicNow:()=>elapsed,fetchImpl:async(url)=>{calls++;elapsed=50;return new Response(JSON.stringify(f.pipelines[0]));}});
  assert.equal(calls,1);assert.deepEqual(r.attemptedRecheckRunIds,[45]);assert.deepEqual(r.discoveryErrors,[]);assert.equal(r.partial,true);assert.equal(r.nextCursor.offset,0);assert.equal(r.watermark,null);
});
test('时间耗尽前无实际请求不把重查ID算作尝试',async(t)=>{
  const f=fixture(t);f.config.discovery={maxDurationMs:1};let clockCalls=0,calls=0;
  const r=await f.run({recheckRunIds:[45],monotonicNow:()=>clockCalls++===0?0:2,fetchImpl:async()=>{calls++;throw new Error('should not fetch');}});
  assert.equal(calls,0);assert.deepEqual(r.attemptedRecheckRunIds,[]);assert.equal(r.partial,true);assert.equal(r.watermark,null);
});
test('Jenkins预算在最终配置复验耗尽时不交付未最终验证快照',async(t)=>{
  const f=fixture(t,'jenkins');f.config.discovery={maxDurationMs:100};let elapsed=0,xmlCalls=0;
  const fetchImpl=async(url)=>{const u=new URL(url);if(u.pathname.endsWith('/config.xml')){if(++xmlCalls===2)elapsed=100;return new Response(xml);}if(u.pathname==='/job/produce/job/build/api/json')return new Response(JSON.stringify({builds:f.builds.map(({number,timestamp})=>({number,timestamp}))}));return new Response(JSON.stringify(f.builds[0]));};
  const r=await f.run({fetchImpl,monotonicNow:()=>elapsed});assert.equal(r.partial,true);assert.equal(r.runs.length,0);assert.equal(r.watermark,null);assert.equal(r.nextCursor.page,0);assert.equal(r.nextCursor.offset,0);assert.deepEqual(r.discoveryErrors,[]);
});
test('单源挂起即使fetch忽略Abort也在整体截止返回，后续项目继续',async(t)=>{
  const slow=fixture(t),healthy=fixture(t);slow.config.discovery={maxDurationMs:10};let signal;
  const start=performance.now();const first=await slow.run({fetchImpl:async(url,init)=>{signal=init.signal;return new Promise(()=>{});}});const second=await healthy.run();
  assert.equal(first.partial,true);assert.equal(first.watermark,null);assert.equal(signal.aborted,true);assert.equal(second.runs.length,1);assert.equal(second.complete,true);assert(performance.now()-start<1000);
});
test('响应体挂起也受整体预算约束，不留下永不完成的读取',async(t)=>{
  const f=fixture(t);f.config.discovery={maxDurationMs:10};const r=await f.run({fetchImpl:async()=>new Response(new ReadableStream({start(){}}))});assert.equal(r.partial,true);assert.equal(r.watermark,null);assert.deepEqual(r.discoveryErrors,[]);
});
test('配置时间预算必须有界且默认20秒，不把fetch异常凭据回显',async(t)=>{
  const f=fixture(t);assert.equal((await f.run()).durationBudgetMs,20000);for(const value of [0,60001,1.5,'100']){f.config.discovery={maxDurationMs:value};await assert.rejects(f.run(),/时间预算/);}f.config.discovery={maxDurationMs:60000};await assert.rejects(f.run({fetchImpl:async()=>{throw new Error('CI bad '+env.CI_TOKEN);}}),error=>!error.message.includes(env.CI_TOKEN));
});
test('取请求参数后到真正fetch前已过截止，也不虚增已尝试重查ID',async(t)=>{
  const f=fixture(t);f.config.discovery={maxDurationMs:2};let clockCalls=0,requests=0;const r=await f.run({recheckRunIds:[45],monotonicNow:()=>clockCalls++<3?0:2,fetchImpl:async()=>{requests++;return new Response('{}');}});assert.equal(requests,0);assert.deepEqual(r.attemptedRecheckRunIds,[]);assert.equal(r.partial,true);assert.equal(r.watermark,null);
});
