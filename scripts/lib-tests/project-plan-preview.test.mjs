import test from 'node:test';
import assert from 'node:assert/strict';
import {repairPlanPreviewLines} from '../../lib/project-actions.js';

test('7991条人工建议只展示3例与总数，所有机械修复及允许文件完整展示，实际计划不变',()=>{
 const manual=Array.from({length:7991},(_,i)=>({action:'manual',ruleId:'MANUAL-'+i,file:'src/Example'+i+'.java',message:'人工建议 '+i}));
 const commands=[{action:'command',ruleId:'MECHANICAL-FIRST',file:'src/A.java',message:'确定修复A',allowedFiles:['src/A.java','src/A.test.java']},{action:'command',ruleId:'MECHANICAL-LAST',file:'src/Z.java',message:'确定修复Z',allowedFiles:['src/Z.java']}];
 const plan={planHash:'a'.repeat(64),items:[commands[0],...manual,commands[1]]},before=JSON.stringify(plan),file='/project/quality-reports/repair/fix-plan.json',lines=repairPlanPreviewLines(plan,file),text=lines.join('\n');
 assert.ok(lines.length<=12,'终端输出必须有界，不能随人工发现数膨胀');assert.equal(lines.filter(l=>l.includes('人工处理 [')).length,3);
 assert.match(text,/人工项 7991/);assert.match(text,/另有 7988 项/);assert.ok(text.includes(file));
 for(const item of commands){assert.ok(text.includes(item.ruleId));for(const allowed of item.allowedFiles)assert.ok(text.includes(allowed));}
 assert.ok(!text.includes('[MANUAL-3]'));assert.equal(JSON.stringify(plan),before);assert.equal(plan.items.length,7993);
});
test('无人工项或仅2项时正常展示，不省略机械授权或虚报更多项',()=>{
 for(const count of [0,2]){const plan={planHash:'b'.repeat(64),items:Array.from({length:count},(_,i)=>({action:'manual',ruleId:'RULE-'+i,file:'src/A'+i+'.java',message:'review'}))};const text=repairPlanPreviewLines(plan,'/project/plan.json').join('\n');assert.equal((text.match(/人工处理 \[/g)||[]).length,count);assert.ok(!text.includes('另有'));assert.match(text,/仅脚本项可执行/);}
});
