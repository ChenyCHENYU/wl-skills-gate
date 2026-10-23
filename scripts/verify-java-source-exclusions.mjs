import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {javaSourceExcludes} from '../lib/adapters/java-scan.js';
const distribution=process.argv[2];
assert.ok(distribution&&existsSync(path.join(distribution,'scripts/evidence.py')),'provide verified fixed Java distribution');
const root=mkdtempSync(path.join(realpathSync(os.tmpdir()),'wl-java-output-scope-'));
const put=rel=>{const f=path.join(root,rel);mkdirSync(path.dirname(f),{recursive:true});writeFileSync(f,'class ScopeFixture {}\n');};
const excludes=javaSourceExcludes(root,[]);
const collect=()=>{
 const r=spawnSync('python3',['-B','-c',`import sys,json\nsys.path.insert(0,sys.argv[1])\nfrom evidence import collect_java\nprint(json.dumps(collect_java(sys.argv[2],json.loads(sys.argv[3]))))`,path.join(distribution,'scripts'),root,JSON.stringify(excludes)],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).map(p=>path.relative(root,p).split(path.sep).join('/'));
};
try{
 const expected=['module/src/main/java/Business.java','module/src/main/java/quality-reports/BusinessNamesake.java','quality-reports-business/src/main/java/AlsoBusiness.java','.quality-onboarding-backups-business/Visible.java'];expected.forEach(put);
 const first=collect();assert.deepEqual(first,[...expected].sort());
 put('quality-reports/repair/snapshots/plan-1/module/src/main/java/Business.java');put('.quality-onboarding-backups/plan-1/module/src/main/java/Business.java');put('quality-reports/Direct.java');
 const second=collect();assert.deepEqual(second,first,'second scan must not read prior Gate snapshots');
 put('quality-reports/repair/snapshots/plan-2/StillIgnored.java');assert.deepEqual(collect(),first);
 assert.ok(excludes.every(e=>e.startsWith(root+'/')&&e.endsWith('/')));assert.throws(()=>javaSourceExcludes(root+',comma',[]),/逗号/);
 console.log(JSON.stringify({status:'passed',collector:'actual fixed distribution evidence.collect_java',scans:3,businessFiles:first,reservedExclusions:excludes,generatedSnapshotsRemainOnDisk:true},null,2));
}finally{rmSync(root,{recursive:true,force:true});}
