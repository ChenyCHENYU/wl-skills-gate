import path from 'node:path';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {controlledPath,readControlledJson,lockedJson} from './control-store.js';
import {validateJenkinsRegistry,digest,gateRuntimeHash,renderJenkinsEntry} from './jenkins-integration.js';
import {loadCiSourceConfig} from './ci-source.js';
import {selectReleaseReview} from './release-review.js';
import {stableStringify} from './util.js';
import {parseXml} from './xml.js';
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const refName=value=>value.replace(/^(?:refs\/remotes\/origin\/|refs\/heads\/|origin\/)/,'');
const jobRoute=job=>job.split('/').map(p=>'job/'+encodeURIComponent(p)).join('/')+'/';

export function loadBuildDispatch({config,ciConfigFile}) {
  assert(config && Object.keys(config).every(k=>['registryFile','bindingId','userEnv','tokenEnv'].includes(k)),'自动续建配置未知或缺失');
  assert(config.registryFile && config.bindingId,'自动续建缺固定登记和bindingId');
  const registryFile=controlledPath(config.registryFile),raw=readFileSync(registryFile),registry=validateJenkinsRegistry(JSON.parse(raw));
  const b=registry.bindings.find(v=>v.id===config.bindingId),ci=loadCiSourceConfig(ciConfigFile);
  assert(b?.jobs.build && b.review && b.project===ci.project && b.scope===ci.scope && b.branch===refName(ci.ref),'自动续建必须唯一匹配已批准项目/分支/scope和BUILD任务');
  assert(b.runtimeHash===gateRuntimeHash() && digest(readFileSync(controlledPath(b.review.trustFile)))===b.review.trustHash,'续建固定包或Review信任漂移');
  const actor=ci.system==='gitlab'?ci:ci.actorSource;
  assert(actor?.system==='gitlab' || ci.system==='gitlab','续建必须能从GitLab核对当前目标分支HEAD');
  const userEnv=config.userEnv || 'WL_JENKINS_BUILD_USER',tokenEnv=config.tokenEnv || 'WL_JENKINS_BUILD_TOKEN';
  assert([userEnv,tokenEnv].every(v=>/^[A-Z][A-Z0-9_]+$/.test(v)),'续建凭据须引用受控环境变量');
  return {registryFile,registryHash:digest(raw),registry,b,ci,actor,userEnv,tokenEnv};
}

// One durable, bounded cycle. Transport uncertainty is reconciled by dispatch
// ID, never blindly POSTed again. No signing key or project code runs here.
export async function dispatchApprovedBuilds({config,ciConfigFile,dataDir,send=false,env=process.env,fetchImpl=fetch,now=Date.now(),afterStage=()=>{}}) {
  const c=loadBuildDispatch({config,ciConfigFile}),{b,registry,actor}=c;
  dataDir=controlledPath(dataDir);
  const binding=digest(stableStringify({config,ciConfigFile,registryHash:c.registryHash}));
  return lockedJson(path.join(dataDir,'dispatch-state.json'),{schemaVersion:1,binding,requests:{}},async(state,checkpoint)=>{
    assert(state.schemaVersion===1 && state.binding===binding && state.requests && typeof state.requests==='object' && !Array.isArray(state.requests) && Object.keys(state.requests).length<=10000,'续建配置/状态变化，不能删除旧记录重新触发');
    for(const [id,p] of Object.entries(state.requests))assert(/^[a-f0-9]{64}$/.test(id) && p.id===id && p.project===b.project && p.scope===b.scope && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(p.sha || '') && ['attempting','unknown','queued','observed','canceled','rejected'].includes(p.status) && Number.isSafeInteger(p.attempts) && p.attempts>=1 && p.attempts<=3 && Number.isFinite(Date.parse(p.lastAttemptAt)),'续建状态损坏，停止并保留原件');
    const result={status:'ok',sent:[],reused:[],superseded:[],unknown:[],errors:[],networkExecuted:false};
    const user=env[c.userEnv],token=env[c.tokenEnv];
    assert(typeof user==='string' && user && !/[:\r\n]/.test(user) && typeof token==='string' && token && !/[\r\n]/.test(token),'缺少仅限目标BUILD任务的Jenkins服务凭据');
    const headers={Authorization:'Basic '+Buffer.from(user+':'+token).toString('base64')};
    const request=async(route,options={})=>{
      const url=new URL(route,registry.jenkinsOrigin);assert(url.origin===new URL(registry.jenkinsOrigin).origin && !url.username && !url.password,'续建请求越出批准Jenkins源');
      result.networkExecuted=true;return fetchImpl(url.href,{redirect:'error',signal:AbortSignal.timeout(15000),...options,headers:{...headers,...options.headers}});
    };
    const getJson=async route=>{const r=await request(route);assert(r.status===200,'续建只读查询失败：HTTP '+r.status);const value=await r.json();assert(value && typeof value==='object','续建查询未返回JSON');return value;};
    const parameters=actions=>Object.fromEntries((actions || []).flatMap(a=>a.parameters || []).map(p=>[p.name,p.value]));
    const reconcile=async progress=>{
      const queue=await getJson('queue/api/json?tree=items[id,url,task[url],actions[parameters[name,value]],cancelled,executable[number,url]]');
      assert(Array.isArray(queue.items) && queue.items.length<=10000,'Jenkins队列不完整或超出预算');
      const jobUrl=new URL(jobRoute(b.jobs.build),registry.jenkinsOrigin).href;
      const active=queue.items.filter(item=>item.task?.url===jobUrl && parameters(item.actions).WL_GATE_DISPATCH_ID===progress.id);
      const history=await getJson(jobRoute(b.jobs.build)+'api/json?tree=builds[number,url,building,result,actions[parameters[name,value]]]{0,100}');
      assert(Array.isArray(history.builds) && history.builds.length<=100,'BUILD历史响应不完整');
      const builds=history.builds.filter(item=>parameters(item.actions).WL_GATE_DISPATCH_ID===progress.id);
      assert(active.length<=1 && builds.length<=1,'同一续建ID出现重复执行，保留记录并停止自动操作');
      const rows=[...active,...builds];
      for(const row of rows)assert(parameters(row.actions).WL_REVIEW_SHA===progress.sha,'续建ID被关联到其他SHA');
      if(builds.length){progress.status='observed';progress.buildUrl=builds[0].url;progress.buildNumber=builds[0].number;progress.buildResult=builds[0].result || 'RUNNING';checkpoint();return true;}
      if(active.length){progress.status=active[0].cancelled?'canceled':'queued';progress.queueId=active[0].id;checkpoint();return true;}
      return false;
    };
    const names=readdirSync(controlledPath(b.review.publicationDir)).filter(v=>/^[a-f0-9]{64}\.json$/.test(v));assert(names.length<=10000,'Review交付目录超过预算');
    const candidates=new Set();
    for(const name of names){const m=readControlledJson(path.join(b.review.publicationDir,name));if(m.kind==='published-review-manifest' && m.project===b.project && m.scope===b.scope && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(m.candidateSha || ''))candidates.add(m.candidateSha);}
    // Recover pending POST outcomes even when a later review/branch supersedes them.
    for(const progress of Object.values(state.requests))if(['attempting','unknown','queued'].includes(progress.status)){
      try{if(await reconcile(progress))result.reused.push(progress.id);else {progress.status='unknown';checkpoint();result.unknown.push(progress.id);}}
      catch(error){result.errors.push({id:progress.id,reason:error.message});}
    }
    let currentSha;
    if(candidates.size){
      const branchUrl=new URL(`/api/v4/projects/${actor.projectId}/repository/branches/${encodeURIComponent(b.branch)}`,actor.baseUrl);
      assert(branchUrl.origin===new URL(actor.baseUrl).origin && env[actor.tokenEnv],'缺少目标分支HEAD核对凭据');
      result.networkExecuted=true;const response=await fetchImpl(branchUrl.href,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'PRIVATE-TOKEN':env[actor.tokenEnv]}});
      assert(response.status===200,'不能核对GitLab目标分支当前HEAD');const branch=await response.json();assert(branch.name===b.branch && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(branch.commit?.id || ''),'目标分支HEAD响应身份无效');currentSha=branch.commit.id;
    }
    for(const sha of candidates){
      try{
        if(sha!==currentSha){result.superseded.push(sha);continue;}
        const checked=await selectReleaseReview({configFile:b.review.trustFile,project:b.project,sha,publicationDir:b.review.publicationDir,outDir:path.join(dataDir,'verification',randomUUID()),now:new Date(now),env,fetchImpl});
        assert(checked.preBuildFindingsResolved===true && checked.liveVerified===true && checked.trust.scope===b.scope,'续建缺严格清零或当前CI复验');
        const id=digest(stableStringify([b.id,sha,checked.reviewDigest,checked.bodyDigest,checked.evidenceDigest]));
        const previous=state.requests[id];
        if(previous && !['rejected'].includes(previous.status)){if(!result.reused.includes(id))result.reused.push(id);continue;}
        if(previous?.attempts>=3 || previous && now-Date.parse(previous.lastAttemptAt)<60000)continue;
        const xmlResponse=await request(jobRoute(b.jobs.build)+'config.xml');assert(xmlResponse.status===200,'不能读取BUILD受控配置');
        const xml=await xmlResponse.text();assert(Buffer.byteLength(xml)<=2*1024*1024,'BUILD配置过大');const tree=parseXml(xml),definitions=tree.children.filter(n=>n.name==='definition');
        assert(tree.name==='flow-definition' && definitions.length===1 && definitions[0].attrs.class==='org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition' && definitions[0].children.filter(n=>n.name==='script').length===1 && definitions[0].children.find(n=>n.name==='script').text.trim()===renderJenkinsEntry(registry,c.registryFile).trim(),'BUILD任务没有使用批准的Gate薄入口');
        const descendants=node=>[node,...node.children.flatMap(descendants)];
        assert(tree.children.filter(n=>n.name==='disabled').length===1 && tree.children.find(n=>n.name==='disabled').text==='false' && descendants(tree).filter(n=>n.name==='triggers').every(n=>n.children.length===0),'BUILD任务被禁用或存在绕过续建的自动触发器');
        assert(digest(readFileSync(c.registryFile))===c.registryHash,'续建期间登记变化');
        if(!send){result.sent.push({id,sha,preview:true,job:b.jobs.build});continue;}
        const progress=state.requests[id] ||= {id,sha,project:b.project,scope:b.scope,reviewId:checked.reviewId,recordHash:checked.recordHash,status:'prepared',attempts:0};
        progress.status='attempting';progress.attempts++;progress.lastAttemptAt=new Date(now).toISOString();progress.jobConfigHash=digest(xml);checkpoint();
        await afterStage('build-dispatch-prepared',{id,sha});
        let response;
        try {response=await request(jobRoute(b.jobs.build)+'buildWithParameters',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({WL_REVIEW_SHA:sha,WL_GATE_DISPATCH_ID:id}).toString()});}
        catch {progress.status='unknown';checkpoint();result.unknown.push(id);continue;}
        await afterStage('build-dispatch-posted',{id,sha});
        if(response.status===201){const location=response.headers.get('location');let url;try{url=new URL(location,registry.jenkinsOrigin);}catch{}
          if(url?.origin===new URL(registry.jenkinsOrigin).origin && /^\/queue\/item\/[1-9][0-9]*\/$/.test(url.pathname)){progress.status='queued';progress.queueUrl=url.href;progress.queueId=Number(url.pathname.split('/')[3]);result.sent.push({id,sha,job:b.jobs.build,queueId:progress.queueId});}
          else {progress.status='unknown';result.unknown.push(id);}
        }else if(response.status>=400 && response.status<500 && response.status!==408){progress.status='rejected';result.errors.push({id,reason:'Jenkins明确拒绝续建：HTTP '+response.status});}
        else {progress.status='unknown';result.unknown.push(id);}
        checkpoint();
      }catch(error){result.errors.push({sha,reason:error.message});}
    }
    result.status=result.errors.length || result.unknown.length?'attention':'ok';return result;
  });
}
