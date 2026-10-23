import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('固定Java分发SpotBugs仅映射scope内主定位，保留外部引用并拒绝真歧义与无主定位', {skip:!process.env.WL_JAVA_REFERENCE_TEST_HOME&&'需要批准固定Java分发目录；发布回归须设置WL_JAVA_REFERENCE_TEST_HOME'},()=>{
 const script=fileURLToPath(new URL('../verify-java-reference-spotbugs.py',import.meta.url));
 const r=spawnSync('python3',[script,'--home',process.env.WL_JAVA_REFERENCE_TEST_HOME],{encoding:'utf8',timeout:60000});
 assert.equal(r.status,0,r.stdout+r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.status,'passed');assert.equal(result.tests,7);
});
