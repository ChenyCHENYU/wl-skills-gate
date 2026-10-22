import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {GATE_ROOT,GATE_VERSION,digest,planJenkinsBinding,applyJenkinsBinding,inspectJenkinsBinding,assertBoundCheckout,verifyJenkinsJobs} from '../../lib/jenkins-integration.js';
import {planOnboarding,applyOnboarding} from '../../lib/onboard.js';
import {stableStringify} from '../../lib/util.js';

export const git=(r,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-C',r,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
export const put=(r,f,value)=>{const file=path.join(r,f);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');return file;};
export const commit=r=>{git(r,'add','.');git(r,'commit','-qm','test: approved fixture');git(r,'update-ref','refs/remotes/origin/test',git(r,'rev-parse','HEAD'));};
export function fixture(t,{build=false,scoped=false,project="wl-produce",reviewPolicy}={}) {
  const base=mkdtempSync(path.join(realpathSync(tmpdir()),'wl-jenkins-thin-')),root=path.join(base,'source');mkdirSync(root);
  t.after(()=>rmSync(base,{recursive:true,force:true}));git(root,'init','-q','-b','test');git(root,'config','user.name','fixture');git(root,'config','user.email','fixture@example.invalid');
  const repo='https://gitlab.example.invalid/produce.git';git(root,'remote','add','origin',repo);
  put(root,'pom.xml','<project><modelVersion>4.0.0</modelVersion><artifactId>fixture</artifactId></project>\n');put(root,'wl-produce-pl/wl-produce-pl-service/pom.xml','<project><artifactId>fixture</artifactId></project>\n');commit(root);
  const adoption=planOnboarding({root,registry:'https://registry.example.invalid/'});applyOnboarding({root,registry:'https://registry.example.invalid/',planHash:adoption.planHash,confirm:true});
  put(root,'quality-tools/package-lock.json',{lockfileVersion:3,packages:{}});
  if(reviewPolicy)put(root,'quality/review-policy.json',reviewPolicy);
  const evidencePlan=JSON.parse(readFileSync(path.join(root,'quality/review-evidence.plan.json')));evidencePlan.project=project;put(root,'quality/review-evidence.plan.json',evidencePlan);
  const policy={schemaVersion:1,project,checks:[{id:'FIXTURE',tool:'cmd-json',command:'node scan.mjs',captureStdout:true,file:'quality-reports/fixture.json',versionCommand:'node --version',profiles:['standard']}]};
  put(root,'quality/policy.yml',JSON.stringify(policy));put(root,'src/Order.java','class Order {}\n');
  put(root,'scan.mjs',"import {readFileSync} from 'node:fs'; console.log(JSON.stringify({toolVersion:'fixture',findings:readFileSync('src/Order.java','utf8').includes('BAD')?[{ruleId:'FIXTURE/RISK',severity:'error',message:'fixture risk',file:'src/Order.java',line:1}]:[]}));\n");
  put(root,'quality/rules.lock.json',{lockVersion:1,'wl-skills-gate':GATE_VERSION,tools:{FIXTURE:process.version}});
  if(scoped) {put(root,'quality/scopes/pl/policy.json',policy);put(root,'quality/scopes/pl/evidence.plan.json',{schemaVersion:1,project:'wl-produce',requiredTestCheckIds:[],evidence:[]});}
  commit(root);
  const reports=path.join(base,'reports');mkdirSync(reports);
  const seed={schemaVersion:1,kind:'wl-gate-jenkins-seed',gateRoot:GATE_ROOT,jenkinsOrigin:'https://jenkins.example.invalid/',binding:{id:'produce-pl-test',project,scope:'test',branch:'test',validationBranch:true,repository:repo,scmCredentialId:'scm-readonly',jobs:{check:'produce/CHECK'},reports:{archiveRoot:reports}}};
  if(scoped) {seed.binding.policyFile='quality/scopes/pl/policy.json';seed.binding.evidencePlanFile='quality/scopes/pl/evidence.plan.json';}
  const seedFile=path.join(base,'seed.json'),registryFile=path.join(base,'bindings.json');
  put(base,'seed.json',seed);
  if(build) {
    const check=planJenkinsBinding({root,seedFile,registryFile}),pins=check.config.bindings[0].pins;
    const reviewKey=generateKeyPairSync('ed25519'),authKey=generateKeyPairSync('ed25519');
    put(base,'review-public.pem',reviewKey.publicKey.export({type:'spki',format:'pem'}));put(base,'auth-public.pem',authKey.publicKey.export({type:'spki',format:'pem'}));
    const trust=path.join(base,'trust.json'),publicationDir=path.join(base,'publications');mkdirSync(publicationDir);mkdirSync(path.join(base,'evidence'));
    put(base,'trust.json',{schemaVersion:1,kind:'release-review-trust',projects:{[project]:{reviewers:['lead','reviewer'],technicalManager:'lead',requireTechnicalManagerReview:true,requireResolvedFindings:true,authorizationIssuer:'fixture-identity',scope:'test',profile:'standard',publicKeyFile:path.join(base,'review-public.pem'),authorizationPublicKeyFile:path.join(base,'auth-public.pem'),collectorConfigFile:path.join(base,'collector.json'),controlCatalogFile:path.join(base,'catalog.json'),evidenceRoots:[path.join(base,'evidence')],...Object.fromEntries(['policyHash','rulesHash','baselineHash','waiversHash','reviewPolicyHash'].map(k=>[k,pins[k]]))}}});
    const script=put(base,'build.sh','#!/bin/sh\nmkdir -p dist\nprintf built > dist/built.txt\n');
    Object.assign(seed.binding,{jobs:{check:'produce/CHECK',build:'produce/BUILD'},review:{trustFile:trust,publicationDir},build:{scriptFile:script,artifactGlob:'dist/**'}});put(base,'seed.json',seed);
  }
  const options={root,seedFile,registryFile};
  const environment=mode=>({JENKINS_URL:'https://jenkins.example.invalid/',JOB_NAME:`produce/${mode}`,BUILD_NUMBER:'12',BUILD_URL:`https://jenkins.example.invalid/job/produce/job/${mode}/12/`,WL_REVIEW_SHA:git(root,'rev-parse','HEAD')});
  return {base,root,seed,seedFile,registryFile,options,environment};
}
export async function bind(f){const p=planJenkinsBinding(f.options);return applyJenkinsBinding({...f.options,confirm:true,planHash:p.planHash});}

