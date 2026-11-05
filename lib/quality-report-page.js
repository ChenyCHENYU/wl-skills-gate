import { REPORT_PAGE_STYLES as styles } from './report-page-styles.js';
import { findingCatalog } from './report-catalog.js';
import { formatNotificationTime } from './notification-time.js';
import { pipelineDiagnostics, diagnosticText } from './notification-diagnostics.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const levels = {blocker:'极高',error:'严重',warning:'警告',info:'提示'};
const priority = {blocker:0,error:1,warning:2,info:3};
const duration = ms => Number.isFinite(ms) ? (ms < 1000 ? `${ms} 毫秒` : `${Math.round(ms / 1000)} 秒`) : '未记录';
const range = f => `${f.line || '未定位'}${f.endLine && f.endLine !== f.line ? '–'+f.endLine : ''}`;
const sort = rows => [...rows].sort((a,b) => (priority[a.severity] ?? 4) - (priority[b.severity] ?? 4));

function observation(p) {
  const o = p.observations;
  if (!o) return '<p class="muted">没有可比较的上一轮记录；不推断新增或修复。</p>';
  if (!o.observationOnly || o.repaired !== null || o.closed !== false || !['added','notSeen','remaining'].every(k => Number.isSafeInteger(o[k]) && o[k] >= 0)) throw Error('复检对比不能包含未核验的修复或关闭结论');
  return `<div class="delta"><span>对比 #${esc(o.previousBuild)}</span><b>新增 ${o.added}</b><b>本轮不再检出 ${o.notSeen}</b><b>仍发现 ${o.remaining}</b></div><p class="muted">${o.complete ? '发现数量变化不等于已完成业务回归或正式关闭。' : '仍有检查失效；只比较已有效复检的发现，不认定整体修复通过。'}${o.recheckUnavailable ? ` 另有 ${esc(o.recheckUnavailable)} 项暂不能比较。` : ''}</p>`;
}

function issue(f, catalog, {compact=false}={}) {
  const mapped = findingCatalog({...f,file:f.file || '(process)'},catalog || {});
  return `<article class="${compact?'issue':'finding-preview issue-card'}" data-risk="${esc(f.severity)}"><details${compact ? '' : ' open'}><summary><span class="risk ${esc(f.severity)}">${esc(levels[f.severity] || f.severity)}</span><strong>${esc(f.message || f.ruleId)}</strong><code>${esc(f.file || '流程检查')}${f.line ? ':'+esc(range(f)) : ''}</code></summary><div class="issue-body"><p class="muted">${esc(mapped.module)} · ${esc(f.dimension || '待归类发现')}</p><dl><dt>定位</dt><dd><code>${esc(f.file || '流程检查')} ${f.line ? ':'+esc(range(f)) : '· 无源码行定位'}</code></dd><dt>规则</dt><dd><code>${esc(f.ruleId)}</code>${mapped.standard ? ' · '+esc(mapped.standard) : ''}</dd><dt>修复建议</dt><dd>${esc(f.suggestion || '核对原始规则与业务影响后确定修复方案')}</dd><dt>执行方式</dt><dd>${f.autoFixable ? '已有适配脚本：预览并确认后执行，完成自动复扫' : '需要开发者判断业务语义；修复完成后自动复扫'}</dd>${(f.occurrences?.length || 0)>1 ? `<dt>全部位置</dt><dd>${f.occurrences.map(o=>esc(range(o))).join('、')}</dd>` : ''}${f.relatedLocations?.length ? `<dt>关联位置</dt><dd>${f.relatedLocations.map(o=>esc(`${o.file}:${range(o)}`)).join('；')}</dd>` : ''}</dl></div></details></article>`;
}

function pages(findings, catalog) {
  const sorted=sort(findings),size=100;
  if(sorted.length<=size)return sorted.map(f=>issue(f,catalog,{compact:true})).join('');
  const chunks=[];
  for(let i=0;i<sorted.length;i+=size)chunks.push(`<details class="issue-page"><summary>第 ${i+1}–${Math.min(i+size,sorted.length)} 项 / 共 ${sorted.length} 项</summary>${sorted.slice(i,i+size).map(f=>issue(f,catalog,{compact:true})).join('')}</details>`);
  return chunks.join('');
}

// No scripts, remote assets, forms, or privileged actions. Works with Jenkins CSP.
export function renderQualityReportPage(v,{stage}) {
  const ci=stage==='ci',s=v.summary,p=v.presentation,counts=v.counts;
  const codeFindings=v.findings.filter(f=>f.ruleId!=='GOV/CHECK-INVALID');
  const diagnostics=pipelineDiagnostics(s),catalog=s.policy?.reportCatalog;
  const changedIds=new Set((p.changeFindings||[]).map(f=>f.fingerprint));
  const changed=sort(codeFindings.filter(f=>changedIds.has(f.fingerprint)));
  const first=sort(codeFindings).slice(0,3);
  const who=p.submitterName || (ci ? '认证执行人未提供' : v.commit?.author?.name || '提交人待核验');
  const manager=p.technicalManagerName || '中央责任表未提供';
  let rawLog=null;
  if(p.buildUrl){const u=new URL(p.buildUrl);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!/^\/(?:job\/[^/]+\/)+[1-9][0-9]*\/$/.test(u.pathname))throw Error('日志必须绑定当前Jenkins构建');rawLog=new URL('console',u).href;}
  const invalid=s.decision?.status==='invalid';
  const conclusion=v.blocked ? (invalid ? '检查未有效完成，构建继续阻断' : '发现阻断问题，构建不放行') : '机器检查结果已生成，等待正式复核';
  const sections=v.rows.map(d=>`<section class="dimension-section" id="dimension-${d.id}"><details><summary><span class="order">${String(d.index).padStart(2,'0')}</span><strong>${esc(d.name)}</strong><span class="state ${d.state}">${esc(d.stateLabel)}</span><span class="muted">${d.items.length} 项发现</span></summary><div class="dimension-body"><p>${esc(d.fact?.note || '尚无本维度完整证据，不能据此认定通过。')}</p>${d.fact?.missingTypes?.length ? `<p class="muted">待补：${d.fact.missingTypes.map(esc).join('、')}</p>` : ''}${d.fact?.evidenceIds?.length ? `<p class="muted">证据索引：${d.fact.evidenceIds.map(esc).join(' / ')}</p>` : ''}${d.items.length ? pages(d.items,catalog) : '<p class="muted">本维度暂无已列发现；仍须核对执行证据和独立复核。</p>'}</div></details></section>`).join('');
  const failed=(s.checks||[]).filter(c=>!['ok','passed'].includes(c.status));
  const checkRows=(s.checks||[]).map(c=>`<tr><td><code>${esc(c.checkId)}</code></td><td><span class="state ${['ok','passed'].includes(c.status)?'ready':'blocked'}">${['ok','passed'].includes(c.status)?'执行完成':esc(c.status==='invalid'?'检查失效':c.status)}</span></td><td>${duration(c.durationMs)}</td><td>${esc(diagnosticText(c.reason || c.note || (c.status==='ok'?'执行完成；质量结论另见问题列表':'没有具体原因记录')))}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(s.run.project)} · ${ci?'流水线':'项目'}质量检查</title><link rel="stylesheet" href="report.css"><style>${styles}</style></head><body>
  <header class="bar"><a href="#overview" class="brand">WL <span>质量检查</span></a><nav><a href="#overview">本轮结果</a><a href="#issues">问题详情</a><a href="#coverage">九维证据</a><a href="#execution-log">重点日志</a></nav><span class="muted">${ci?'第二道 · CI构建准入':'第一道 · 项目内检查'}</span></header>
  <main id="overview">${p.simulation ? `<div class="preview">模拟验证 · 本页为演示数据，${ci?'未执行真实CI、构建或部署':'未执行真实项目检查、构建或部署'}。</div>` : ''}${p.templatePreview ? '<div class="preview">页面预览 · 使用已归档的真实结果重新排版；没有重新执行检查，也未替换线上历史报告。</div>' : ''}
  <section class="hero"><div class="report-tools"><a class="button" href="#save-report">离线保存</a></div><div class="eyebrow">${esc(p.domain || '')}${p.domain?' / ':''}${ci?'流水线质量检查':'项目内质量检查'}</div><div class="hero-top"><h1>${esc(s.run.project)}</h1><span class="verdict ${v.blocked?'blocked':'attention'}">${esc(conclusion)}</span></div><p class="subtitle"><b>${esc(v.trace.branch || v.trace.sourceBranch || '分支未提供')}</b> · ${esc(p.pipelineLabel || (ci?'本轮作业未提供':'本地代码检查'))} · ${esc(formatNotificationTime(s.run.finishedAt || s.run.startedAt))}</p><div class="meta"><span>${ci?'执行人':'提交人'} <b>${esc(who)}</b>${p.submitterId?`（${esc(p.submitterId)}）`:''}</span><span>技术经理 <b>${esc(manager)}</b></span><span>耗时 <b>${duration(s.run.durationMs)}</b></span><span>Gate <code>${esc(s.run.tool || '版本未提供')}</code></span></div><p class="commit">${esc(v.commit?.subject || '未提供提交说明')}<br><code>${esc(s.run.commitSha || '尚未生成提交')}</code></p></section>
  <section class="result"><div><h2>${v.blocked?'为什么没有放行':'本轮结论'}</h2>${diagnostics.length?diagnostics.slice(0,3).map(d=>`<div class="reason"><b>${esc(d.label)}</b><p>${esc(d.reason)}</p><p class="action">处理：${esc(d.action)}</p></div>`).join(''):v.blocked?`<p class="reason">本轮仍有 ${counts.blocker+counts.error} 项极高／严重发现，修复并复扫后再核对准入。</p>`:'<p>机器检查已经生成结果；正式 Review、构建和部署须分别核验。</p>'}${diagnostics.length>3?'<a href="#execution-log">查看其余原始检查原因 ↓</a>':''}</div><div class="next"><h3>接下来谁来处理</h3><p><b>${esc(who)}</b><br>修复当前发现，恢复失效检查，再提交复检。</p><p><b>${esc(manager)}</b><br>核对复检与回归证据，完成当前版本正式 Review。</p><small>未执行构建／部署；本报告不代签 Review，不关闭问题。</small></div></section>
  <div class="metrics">${Object.entries(levels).map(([k,label])=>`<a class="metric ${k}" href="#issues"><span>${label}</span><b>${counts[k]}</b><small>${k==='blocker'||k==='error'?'必须处理':k==='warning'?'评估并处理':'建议与追溯'}</small></a>`).join('')}</div>${invalid?'<p class="warning">检查失效：数量仅为已产生的发现，不代表完整扫描或零风险结论。</p>':''}
  <section class="panel"><div class="heading"><h2>与上一轮相比</h2><span class="muted">只展示可核验的变化</span></div>${observation(p)}</section>
  ${changed.length?`<section class="panel"><h2>本次变更相关发现 <small>${changed.length} 项</small></h2>${changed.slice(0,5).map(f=>issue(f,catalog)).join('')}${changed.length>5?'<a href="#issues">其余发现见完整问题详情 ↓</a>':''}</section>`:''}
  <section class="panel"><div class="heading"><h2>优先处理</h2><span class="muted">按风险排序 · 展示 ${first.length}/${codeFindings.length} 项</span></div>${first.length?first.map(f=>issue(f,catalog)).join(''):'<p class="muted">本轮没有列出代码发现；仍须核对是否完成全部检查。</p>'}</section>
  <section class="panel" id="execution-log"><div class="heading"><div><span id="pipeline-stages"></span><h2>重点日志</h2><p class="muted">原始检查结果提要 · ${failed.length} 项未有效完成 / 共 ${(s.checks||[]).length} 项检查</p></div>${rawLog?`<a class="button" href="${esc(rawLog)}">完整控制台 ↗</a>`:''}</div>${failed.map(c=>`<div class="reason"><b>${esc(c.checkId)} · ${duration(c.durationMs)}</b><pre>${esc(diagnosticText(c.reason || c.note || '检查未有效完成，未提供具体原因',{},2000))}</pre></div>`).join('')}${(s.checks||[]).length?`<details><summary>展开全部检查的状态、耗时与原始原因</summary><div class="table-wrap"><table><thead><tr><th>检查</th><th>执行状态</th><th>耗时</th><th>原始结果</th></tr></thead><tbody>${checkRows}</tbody></table></div></details>`:'<p class="muted">本报告未提供检查命令的执行记录，不能标记成功。</p>'}<p class="muted">“执行完成”表示工具已返回有效结果，不代表代码质量合格。完整控制台保留原始上下文；本页不推测未记录的错误。</p></section>
  <section id="coverage"><div class="heading"><h2>九维证据与完整问题</h2><span class="muted">点击展开维度，再展开具体问题</span></div><p class="muted">${esc(v.pendingMessage || '已有检查记录不等于审核通过。')} 代码审核由技术经理确认，结果以正式审核记录为准。</p><span id="issues"></span>${sections}${v.unclassified.length?`<section class="panel"><h2>待归类发现 <small>${v.unclassified.length} 项</small></h2><p class="muted">原问题保留，未映射维度不能当作已通过。</p>${pages(v.unclassified,catalog)}</section>`:''}</section>
  <section class="panel" id="save-report"><h2>离线保存</h2><p>使用浏览器菜单“另存为”，保存当前 HTML；页面内含完整内容与样式，之后可直接打开阅读。</p><p class="muted">无需运行本机预览服务。在线报告及完整控制台仍需公司内网／VPN与任务读取权限。</p></section><footer><b>本轮只读证据</b> · 发现不再出现 ≠ 已关闭；扫描完成 ≠ 获准构建或发布。${p.networkAccess==='intranet-vpn'?'<br>报告和控制台需公司内网／VPN，并登录具有本任务读取权限的 Jenkins 账号。':''}</footer></main></body></html>`;
}

