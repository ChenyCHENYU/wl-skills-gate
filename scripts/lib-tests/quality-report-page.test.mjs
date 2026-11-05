import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderPipelineReviewReport,pipelineReviewView} from '../../lib/project-review-report.js';
import {pipelineCheckNotification} from '../../lib/pipeline-notification.js';
import {pipelineDiagnostics} from '../../lib/notification-diagnostics.js';

function input(){return {summary:{run:{project:'ui-test',stage:'ci',tool:'gate@test',commitSha:'a'.repeat(40),startedAt:'2026-10-26T01:00:00Z',durationMs:2300,trace:{branch:'test',commits:[{author:{name:'Git作者'},subject:'fix: 复检'}]}},decision:{status:'invalid',reasons:[]},checks:[{checkId:'FE-KIT',status:'invalid',durationMs:30,reason:'实际错误 <script>bad</script>'}],findings:Array.from({length:102},(_,i)=>({fingerprint:i.toString(16).padStart(64,'0'),dimension:'coding',severity:i===0?'error':'warning',ruleId:'R/'+i,file:'src/a.ts',line:i+1,message:'发现'+i}))},presentation:{buildUrl:'https://jenkins.example.invalid/job/pilot/12/',pipelineLabel:'pilot · #12',submitterName:'执行人甲',technicalManagerName:'经理乙',observations:{previousBuild:'11',added:0,notSeen:3,remaining:102,observationOnly:true,repaired:null,closed:false,complete:false}}};}
test('结果优先、长列表分组展开，九维与全部发现保留；不依赖脚本或外部资源',()=>{
 const x=input(),before=JSON.stringify(x),html=renderPipelineReviewReport(x);
 assert(html.indexOf('为什么没有放行')<html.indexOf('九维证据与完整问题'));
 assert.match(html,/执行人甲/);assert.match(html,/经理乙/);assert.match(html,/新增 0/);assert.match(html,/本轮不再检出 3/);assert.match(html,/仍有检查失效/);
 assert.match(html,/第 101–102 项 \/ 共 102 项/);assert.equal((html.match(/class="issue" data-risk=/g)||[]).length,102);
 assert.match(html,/id="execution-log"/);assert.match(html,/FE-KIT · 30 毫秒/);assert.match(html,/实际错误 &lt;script&gt;bad&lt;\/script&gt;/);
 assert.match(html,/https:\/\/jenkins.example.invalid\/job\/pilot\/12\/console/);
 assert.doesNotMatch(html,/<script\b|<iframe\b|<form\b|src="https?:/i);assert.equal(JSON.stringify(x),before);
 delete x.presentation.submitterName;assert.match(renderPipelineReviewReport(x),/认证执行人未提供/);
 assert.doesNotMatch(renderPipelineReviewReport(x),/执行人 <b>Git作者/);
 x.presentation.observations.repaired=3;assert.throws(()=>renderPipelineReviewReport(x),/未核验/);
});
test('日志按钮定位本轮已验证报告的重点日志，不接受别轮控制台',()=>{
 const x=input();x.presentation={...x.presentation,reportUrl:'https://jenkins.example.invalid/job/pilot/12/wl-quality/ui-test/ci/id/index.html',logUrl:'https://jenkins.example.invalid/job/pilot/12/console',logView:'report-summary',approvedBranch:'test',validationBranch:true,submitterId:'a'};
 const config={projects:{'ui-test':{technicalManager:'b'}},people:{a:{name:'甲',feishu:{idType:'user_id',id:'a'}},b:{name:'乙',feishu:{idType:'user_id',id:'b'}}}};
 const card=pipelineCheckNotification(x,config);const buttons=card.payload.card.body.elements.find(e=>e.tag==='column_set'&&e.columns.length===2);
 assert.equal(buttons.columns[1].elements[0].behaviors[0].default_url,x.presentation.reportUrl+'#execution-log');
 x.presentation.logUrl='https://jenkins.example.invalid/job/pilot/11/console';assert.throws(()=>pipelineCheckNotification(x,config),/同一次/);
 x.presentation.buildUrl='javascript:alert(1)';assert.throws(()=>renderPipelineReviewReport(x),/当前Jenkins/);
});
test('检查原始原因与门禁包装原因不重复展示，不吞掉独立的额外阻断项',()=>{
 const s=input().summary;s.checks[0].reason='字典重复';s.decision.reasons=['检查失效: FE-KIT — 字典重复','Review 还没有通过'];
 const d=pipelineDiagnostics(s);assert.equal(d.length,2);assert.equal(d.filter(x=>x.reason.includes('字典重复')).length,1);assert.match(d[1].reason,/Review/);
});
test('原生UI与交互维度别名准确归入九维UI，未知维度继续保留',()=>{
 const x=input();x.summary.findings=[{dimension:'UI与交互',severity:'warning',file:'src/a.vue',ruleId:'UI/ONE',message:'交互问题'},{dimension:'未知维度',severity:'error',file:'src/b.vue',ruleId:'OTHER',message:'需归类'}];
 const v=pipelineReviewView(x);assert.equal(v.rows.find(d=>d.id==='ui').items.length,1);assert.equal(v.unclassified.length,1);
});
