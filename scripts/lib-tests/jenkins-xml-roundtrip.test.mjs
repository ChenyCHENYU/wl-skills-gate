import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseXml} from '../../lib/xml.js';
import {jobContract} from '../../lib/jenkins-job-config.js';
import {GATE_VERSION} from '../../lib/jenkins-integration.js';
import {nativePipelineEntry} from '../../lib/jenkins-entry-contract.js';
import {planJenkinsInstallation,applyJenkinsInstallation} from '../../lib/jenkins-installation.js';
import {planJenkinsBootstrap,applyJenkinsBootstrap} from '../../lib/jenkins-node-bootstrap.js';
import {MAINTENANCE_JOBS} from '../../lib/jenkins-cluster.js';

// Jenkins switched its XML output to 1.1 in 2.107.1. A protocol mock which
// echoes createItem's request body never exercises the real config.xml format.
// This fixture independently rebuilds Jenkins-style persisted XML from the
// approved script; it never stores or returns the submitted request body.
const declaration=quote=>`<?xml version=${quote}1.1${quote} encoding=${quote}UTF-8${quote}?>`;
const text=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;').replaceAll('\n','&#xA;');
function persistedJob(script,{quote='"',scriptOverride,sandbox='true',disabled='false',concurrent=true,spec=null}={}) {
 const properties=[
  '<hudson.model.ParametersDefinitionProperty><parameterDefinitions/></hudson.model.ParametersDefinitionProperty>',
  concurrent?'<org.jenkinsci.plugins.workflow.job.properties.DisableConcurrentBuildsJobProperty><abortPrevious>false</abortPrevious></org.jenkinsci.plugins.workflow.job.properties.DisableConcurrentBuildsJobProperty>':'',
  '<org.jenkinsci.plugins.workflow.job.properties.PipelineTriggersJobProperty><triggers>'+(spec===null?'':`<hudson.triggers.TimerTrigger><spec>${text(spec)}</spec></hudson.triggers.TimerTrigger>` )+'</triggers></org.jenkinsci.plugins.workflow.job.properties.PipelineTriggersJobProperty>'
 ].filter(Boolean).reverse().join('\n    ');
 return `${declaration(quote)}\n<flow-definition plugin="workflow-job@1505.fixture">
  <actions/>
  <description>WL Gate common task &amp; regression</description>
  <keepDependencies>false</keepDependencies>
  <properties>
    ${properties}
  </properties>
  <definition plugin='workflow-cps@4218.fixture' class='org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition'>
    <script>${text(scriptOverride??script)}</script>
    <sandbox>${sandbox}</sandbox>
  </definition>
  <triggers/>
  <disabled>${disabled}</disabled>
</flow-definition>\n`;
}
const jobNames=Object.values(MAINTENANCE_JOBS);
function installed(t) {
 const base=mkdtempSync(path.join(realpathSync(tmpdir()),'wl-xml-roundtrip-'));
 t.after(()=>rmSync(base,{recursive:true,force:true}));
 const configDir=path.join(base,'config');mkdirSync(configDir);
 const input={prefix:path.join(base,'install space'),configDir,registryFiles:[path.join(configDir,'bindings.json')],jenkinsOrigin:'https://jenkins.example.invalid/',centralAgentLabel:'central',reviewSignerAgentLabel:'signer'};
 const plan=planJenkinsInstallation(input);
 const node=applyJenkinsInstallation({...input,confirm:true,planHash:plan.planHash});
 const script=nativePipelineEntry(node.nativeEntry),jobs=new Map([['wl-quality-fleet',persistedJob(script)]]);
 const calls=[],created=[],submitted=[];
 const fixture={node,script,jobs,calls,created,submitted,quote:'"',lostReply:false,mutateCreated:null};
 fixture.fetchImpl=async(endpoint,request)=>{
  const url=new URL(endpoint);assert.equal(url.origin,'https://jenkins.example.invalid');
  calls.push({method:request.method,path:url.pathname});
  if(request.method==='GET'){
   const match=/^\/job\/([^/]+)\/config\.xml$/.exec(url.pathname);assert.ok(match,'only expected metadata requests');
   const name=decodeURIComponent(match[1]);
   return jobs.has(name)?new Response(jobs.get(name),{headers:{'Content-Type':'application/xml; charset=UTF-8'}}):new Response('',{status:404});
  }
  assert.equal(request.method,'POST');assert.equal(url.pathname,'/createItem');
  const name=url.searchParams.get('name');assert.ok(jobNames.includes(name));
  assert.ok(!jobs.has(name),'create-only must not overwrite an existing job');
  assert.equal(jobContract(request.body).script,script.trim(),'submit the approved native entry');
  submitted.push(request.body);created.push(name);
  let saved=persistedJob(script,{quote:fixture.quote});
  if(fixture.mutateCreated)saved=fixture.mutateCreated(name,saved);
  assert.notEqual(saved,request.body,'persisted Jenkins response must not echo request XML');
  jobs.set(name,saved);
  if(fixture.lostReply){fixture.lostReply=false;throw Error('fixture response lost after Jenkins saved config');}
  return new Response('',{status:200});
 };
 fixture.options={configFile:node.clusterFile,env:{WL_JENKINS_CONFIG_USER:'fixture-admin',WL_JENKINS_CONFIG_TOKEN:'fixture-not-real'},fetchImpl:fixture.fetchImpl};
 return fixture;
}

for(const [name,header] of [
 ['XML 1.0 UTF-8 declaration','<?xml version="1.0" encoding="UTF-8"?>'],
 ['Jenkins XML 1.1 double-quoted declaration',declaration('"')],
 ['Jenkins XML 1.1 single-quoted declaration',declaration("'")]
])test(name,()=>assert.equal(parseXml(header+'\n<root>正常 &amp; safe</root>').text,'正常 & safe'));

for(const [label,header,lineEnding] of [
 ['1.0 CRLF','<?xml version="1.0"?>','\r\n'],
 ['1.1 CRLF',declaration('"'),'\r\n'],
 ['1.1 CR+NEL',declaration('"'),'\r\u0085'],
 ['1.1 NEL',declaration('"'),'\u0085'],
 ['1.1 Unicode line separator',declaration("'"),'\u2028']
])test(`XML physical line endings normalize before contract comparison: ${label}`,()=>{
 assert.equal(parseXml(header+lineEnding+'<root>a'+lineEnding+'b</root>').text,'a\nb');
});
test('XML character references remain explicit characters after physical newline normalization',()=>{
 assert.equal(parseXml(declaration('"')+'<root>a&#13;b&#x85;c&#x2028;d&#10;e</root>').text,'a\rb\u0085c\u2028d\ne');
});

for(const [label,xml] of [
 ['unsupported XML version','<?xml version="1.2"?><root/>'],
 ['unsupported encoding','<?xml version="1.1" encoding="UTF-16"?><root/>'],
 ['second declaration',declaration('"')+declaration('"')+'<root/>'],
 ['external DTD',declaration('"')+'<!DOCTYPE root SYSTEM "file:///not-read"><root/>'],
 ['internal entity declaration',declaration('"')+'<!DOCTYPE root [<!ENTITY x "private">]><root>&x;</root>'],
 ['unknown entity',declaration('"')+'<root>&notDeclared;</root>'],
 ['literal control character',declaration('"')+'<root>\u0001</root>'],
 ['zero character reference',declaration('"')+'<root>&#0;</root>']
])test(`XML 1.1 support stays fail-closed: ${label}`,()=>assert.throws(()=>parseXml(xml)));

for(const quote of ['"',"'"])test(`real bootstrap plan/apply verifies all five normalized Jenkins jobs (${quote} declaration) and reuses them`,async t=>{
 const f=installed(t);f.quote=quote;
 f.jobs.set('wl-quality-fleet',persistedJob(f.script,{quote}));
 assert.equal(JSON.parse(readFileSync(new URL('../../package.json',import.meta.url))).version,GATE_VERSION);
 let p=await planJenkinsBootstrap(f.options);
 assert.equal(p.status,'preview');assert.equal(p.entries.filter(e=>e.action==='create').length,4);
 let result=await applyJenkinsBootstrap({...f.options,confirm:true,planHash:p.planHash});
 assert.equal(result.status,'common-jobs-verified',JSON.stringify(result));
 assert.equal(result.entries.length,5);assert.ok(result.entries.every(e=>e.status==='verified'));
 assert.equal(result.businessBuildsTriggered,false);assert.equal(result.schedulesEnabled,false);
 assert.equal(f.created.length,4);assert.equal(f.jobs.size,5);
 for(const xml of f.jobs.values())assert.ok(xml.startsWith(declaration(quote)));
 const persisted=[...f.jobs];p=await planJenkinsBootstrap(f.options);
 assert.ok(p.entries.every(e=>e.action==='unchanged'));
 result=await applyJenkinsBootstrap({...f.options,confirm:true,planHash:p.planHash});
 assert.equal(result.status,'common-jobs-verified');assert.equal(f.created.length,4);assert.deepEqual([...f.jobs],persisted);
 assert.ok(f.calls.every(c=>c.method==='GET'||c.path==='/createItem'),'no overwrite, build, credential, or secret endpoint');
});
test('Jenkins-normalized readback reconciles a lost create response without duplicating the saved job',async t=>{
 const f=installed(t);f.lostReply=true;
 const p=await planJenkinsBootstrap(f.options),result=await applyJenkinsBootstrap({...f.options,confirm:true,planHash:p.planHash});
 assert.equal(result.status,'common-jobs-verified',JSON.stringify(result));
 assert.equal(result.entries.filter(e=>e.writeReconciled).length,1);assert.equal(f.created.length,4);
});
test('owned maintenance schedules survive normalized property/trigger serialization without extra writes',async t=>{
 const f=installed(t);
 for(const [role,name] of Object.entries(MAINTENANCE_JOBS))f.jobs.set(name,persistedJob(f.script,{spec:role==='node'?'H/5 * * * *':['review','automation'].includes(role)?'* * * * *':null}));
 const p=await planJenkinsBootstrap(f.options);assert.equal(p.status,'preview',JSON.stringify(p));
 const r=await applyJenkinsBootstrap({...f.options,confirm:true,planHash:p.planHash});
 assert.equal(r.status,'common-jobs-verified');assert.equal(f.created.length,0);
});
for(const [label,changes] of [
 ['changed executable script',{scriptOverride:"println 'unexpected owner'"}],
 ['sandbox disabled',{sandbox:'false'}],
 ['job disabled',{disabled:'true'}],
 ['concurrency protection removed',{concurrent:false}],
 ['unapproved timer trigger',{spec:'H * * * *'}]
])test(`existing normalized job stays blocked for ${label}`,async t=>{
 const f=installed(t),original=persistedJob(f.script,changes);f.jobs.set('wl-quality-fleet',original);
 const p=await planJenkinsBootstrap(f.options);assert.equal(p.status,'blocked',JSON.stringify(p));
 await assert.rejects(applyJenkinsBootstrap({...f.options,confirm:true,planHash:p.planHash}),/阻断/);
 assert.equal(f.jobs.get('wl-quality-fleet'),original);assert.equal(f.created.length,0);
});
test('a genuinely changed script after create is attention, never a verified bootstrap or automatic overwrite',async t=>{
 const f=installed(t);f.mutateCreated=(name,saved)=>name==='wl-quality-doctor'?persistedJob(f.script,{scriptOverride:"println 'changed after save'"}):saved;
 const p=await planJenkinsBootstrap(f.options),result=await applyJenkinsBootstrap({...f.options,confirm:true,planHash:p.planHash});
 assert.equal(result.status,'attention');assert.equal(result.entries.find(e=>e.job==='wl-quality-doctor').status,'attention');
 assert.equal(result.businessBuildsTriggered,false);assert.equal(result.schedulesEnabled,false);
 const writes=f.created.length,next=await planJenkinsBootstrap(f.options);assert.equal(next.status,'blocked');
 await assert.rejects(applyJenkinsBootstrap({...f.options,confirm:true,planHash:next.planHash}),/阻断/);assert.equal(f.created.length,writes);
});
