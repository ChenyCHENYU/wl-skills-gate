import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {javaDistributionHome,javaDistribution,JAVA_REFERENCE_VERSION} from '../../lib/java-distribution.js';
const root=mkdtempSync(path.join(os.tmpdir(),'wl-java-incremental-'));
test.after(()=>rmSync(root,{recursive:true,force:true}));
test('legacy explicit home stays unchanged before an exact target snapshot is prepared',()=>{
 const home=path.join(root,'legacy');mkdirSync(home);assert.equal(javaDistributionHome({WL_JAVA_SCAN_HOME:home}),home);
 mkdirSync(path.join(home,'.wl-releases','f'.repeat(64)),{recursive:true});assert.equal(javaDistributionHome({WL_JAVA_SCAN_HOME:home}),home);
});
test('exact current lock selects the approved child while retaining the legacy home',()=>{
 const home=path.join(root,'prepared'),target=path.join(home,'.wl-releases',JAVA_REFERENCE_VERSION.split(':')[1]);mkdirSync(target,{recursive:true});writeFileSync(path.join(home,'old-runtime'),'retain');
 assert.equal(javaDistributionHome({WL_JAVA_SCAN_HOME:home}),target);
});
test('a folder named for the approved lock never substitutes for analyzer byte verification',async()=>{
 const home=path.join(root,'invalid'),target=path.join(home,'.wl-releases',JAVA_REFERENCE_VERSION.split(':')[1]);mkdirSync(target,{recursive:true});
 await assert.rejects(()=>javaDistribution({env:{...process.env,WL_JAVA_SCAN_HOME:home}}),/Java分发完整性/);
});
