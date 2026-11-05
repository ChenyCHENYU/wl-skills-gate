import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {renderOpsReportPage,OPS_REPORT_STYLES} from '../../lib/ops-report-page.js';
import {opsGapCategory} from '../../lib/ops-report-model.js';
import {archiveOpsReportPage} from '../../lib/ops-report-archive.js';
import {opsNotification} from '../../lib/jenkins-ops-notification.js';

const report=()=>({kind:'jenkins-ops-report',runId:'11111111-1111-4111-8111-111111111111',checkedAt:'2026-10-27T16:00:00Z',status:'attention',jenkinsOrigin:'https://jenkins.example.invalid/',runUrl:'https://jenkins.example.invalid/job/doctor/3/',execution:{job:'doctor',number:'3'},trigger:{id:'worker',name:'执行人'},responsibility:{publicOwners:[{id:'owner',name:'公共负责人'}],people:{manager:{name:'技术经理'}}},globalGaps:[],projects:[{key:'p1',project:'wl-ui-produce',branch:'test',jobs:['produce/CHECK'],technicalManager:'manager',gaps:[{id:'PROJECT-GATE',message:'缺少 quality/workspace.json',action:'接入并提交后复检'}],status:'attention'}]});
test('接入报告使用质量页的布局语言，分类不冒充代码四级风险',()=>{
 const html=renderOpsReportPage(report());
 for(const id of ['overview','diagnostics','projects','execution-log','category-project'])assert(html.includes(`id="${id}"`));
 assert.match(html,/<h1>wl-ui-produce<\/h1>/);assert.match(html,/公共负责人/);assert.match(html,/技术经理/);
 assert.match(html,/离线保存/);assert.match(html,/前置就绪不等于九维通过/);
 assert(!html.includes('极高'));assert(!html.includes('严重'));assert(html.includes(OPS_REPORT_STYLES));
 assert(!/<script\b|<form\b|<iframe\b|https?:\/\/[^"<> ]+\.(?:js|css)/.test(html));
});
test('认证失败没有取得项目时，不把空范围显示为零风险或前置就绪',()=>{
 const r=report();r.projects=[];r.globalGaps=[{id:'JENKINS-AUTH',message:'HTTP 401',action:'核对登录账号'},{id:'REGISTRY',message:'项目登记未齐',action:'生成登记'}];
 const html=renderOpsReportPage(r);assert.match(html,/公共巡检｜业务项目未检查/);assert.match(html,/先恢复 Jenkins 读取/);
 assert(!html.includes('识别仓库<b>0'));assert(!html.includes('前置就绪<b>0'));assert.match(html,/尚未取得可检查的业务项目/);
});
test('未知仓库不从 Job 名猜项目，定时来源不显示为人工执行人',()=>{
 const r=report();r.trigger={type:'timer'};r.projects[0].project=null;r.projects[0].branch=null;
 const html=renderOpsReportPage(r);assert.match(html,/仓库待识别/);assert.match(html,/分支待确认/);assert.match(html,/定时巡检/);
 assert.match(html,/Job：produce\/CHECK/);assert(!html.includes('<h1>produce/CHECK'));
});
test('报告对凭据和 HTML 注入做脱敏转义，控制台只允许本轮同源链接',()=>{
 const r=report();r.runUrl='https://attacker.invalid/job/doctor/3/';r.projects[0].gaps[0].message='<img src=x onerror=boom()> token=PRIVATE https://open.feishu.cn/hook/private';
 const html=renderOpsReportPage(r);assert(!html.includes('<img'));assert(!html.includes('PRIVATE'));assert(!html.includes('/hook/private'));assert(!html.includes('attacker.invalid'));assert.match(html,/已隐藏/);
});
test('归档同时保存内嵌样式和同源 CSS，不覆盖历史原件或接受符号链接',t=>{
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'ops-report-page-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const r=report(),directory=path.join(root,'run'),a=archiveOpsReportPage({report:r,directory});
 assert.equal(archiveOpsReportPage({report:r,directory}).htmlSha256,a.htmlSha256);
 assert.equal(readFileSync(path.join(directory,'report.css'),'utf8'),OPS_REPORT_STYLES);
 assert.match(readFileSync(path.join(directory,'index.html'),'utf8'),/rel="stylesheet" href="report.css"/);
 writeFileSync(path.join(directory,'index.html'),'changed');assert.throws(()=>archiveOpsReportPage({report:r,directory}),/不可覆盖/);
 symlinkSync(directory,path.join(root,'link'));assert.throws(()=>archiveOpsReportPage({report:r,directory:path.join(root,'link')}),/符号链接/);
});
test('流水线与仓库定位缺项归入明确分类，卡片日志定位同一份报告',()=>{
 assert.equal(opsGapCategory({id:'SCM-LOCATION'}).label,'流水线接线');assert.equal(opsGapCategory({id:'UNCONTROLLED-JOB'}).label,'流水线接线');
 const r=report(),url=new URL('artifact/wl-ops-public/index.html',r.runUrl).href;
 r.links={status:'verified',reportUrl:url,logUrl:url+'#execution-log',logView:'report-summary'};
 const text=JSON.stringify(opsNotification(r).payload);assert(text.includes(url+'#execution-log'));
 r.links.logUrl='https://attacker.invalid/';assert(!JSON.stringify(opsNotification(r).payload).includes('open_url'));
});
test('大量流水线按仓库和范围折叠，重点日志首屏保留十条且完整数据不丢失',()=>{
 const r=report();r.projects=Array.from({length:61},(_,i)=>({...r.projects[0],key:`p-${i}`,jobs:[`job-${i}`],gaps:[{id:'UNCONTROLLED-JOB',message:`diagnostic-${i}-end`,action:'补齐接入'}]}));
 const html=renderOpsReportPage(r);
 assert.equal((html.match(/class="repository-group"/g)||[]).length,1);
 assert.match(html,/第 51–61 项 \/ 共 61 项/);
 assert.match(html,/展开其余 51 条诊断记录/);
 assert.match(html,/第 61–61 条 \/ 共 61 条/);
 const log=html.split('<section class="panel" id="execution-log">')[1];
 for(let i=0;i<61;i++)assert.equal(log.split(`diagnostic-${i}-end`).length-1,1);
 assert.match(html,/href="#save-report"/);
});
