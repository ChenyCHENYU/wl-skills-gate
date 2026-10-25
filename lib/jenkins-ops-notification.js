import { createHmac } from 'node:crypto';
import { notificationText } from './notification-style.js';
import { formatNotificationTime } from './notification-time.js';
import { notificationRecipients, validNotificationPerson } from './notification-people.js';
import { applyNotificationPresentation } from './notification-presentation.js';

// Operations readiness is independent from quality/admission. Missing project
// configuration must still produce an actionable CI notice, without requiring
// that project's governance config or any source-controlled notification code.
const clean = (value, max = 180) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/https?:\/\/[^\s<>)]+/g, raw => { try { const u = new URL(raw); return `${u.origin}${u.pathname}`; } catch { return '[地址已隐藏]'; } })
  .replace(/\b(token|password|secret|authorization)\s*[:=]\s*\S+/gi, '$1=[已隐藏]').slice(0, max);
const md = value => clean(value).replace(/[\\`*_~\[\]<>]/g, '\\$&');
const verifiedPerson = p => validNotificationPerson(p, { requireVerified: true });
const category = id => /PROJECT-GATE|PROJECT-CONFIG|DECLARED-/i.test(id) ? '项目接入缺项' : /gate|package|runtime|node|python|java|tool|engine/i.test(id) ? 'Gate／执行环境'
  : /owner|people|person|actor|mention|manager/i.test(id) ? '责任人／提醒'
    : /credential|token|secret|auth|permission|inventory/i.test(id) ? '凭据／访问权限'
      : /review|trust|sign/i.test(id) ? 'Review／准入'
        : /hook|trigger|branch|event/i.test(id) ? '触发／分支接线'
          : /registry|binding|config|policy|fleet|source|automation|project|check/i.test(id) ? '项目／检查配置' : '其他接入缺项';
const httpsUrl = value => { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname && !u.username && !u.password && !u.hash ? u : null; } catch { return null; } };

function recipients(project, config) {
  let owner = config.owners?.[project.key] ?? config.owners?.[project.project] ?? {};
  if (typeof owner === 'string') owner = { technicalManager: owner };
  const manager = project.technicalManager || owner.technicalManager;
  const executor = project.executor || owner.executor;
  const plan = notificationRecipients(executor, { technicalManager: manager, managerSubmissionNotify: project.managerSubmissionNotify || owner.managerSubmissionNotify }, config.people, { requireVerified: true });
  return { ...plan, actors: [...new Set([...plan.actors, ...(Array.isArray(owner.recipients) ? owner.recipients : [])].filter(v => typeof v === 'string' && v))] };
}

export function opsNotification(report, { people = {}, owners = {}, fallbackRecipients = [], publicTasks = {}, networkAccess = report?.networkAccess } = {}) {
  if (report?.kind !== 'jenkins-ops-report' || !Array.isArray(report.projects)
    || report.projects.some(p => !p || !['attention', 'ready', 'unverified'].includes(p.status) || !Array.isArray(p.gaps))
    || (report.globalGaps !== undefined && !Array.isArray(report.globalGaps))) throw new Error('需要真实运维接入检查报告');
  const config = { people, owners }, projects = report.projects;
  const priority=g=>/JENKINS-AUTH|JENKINS-PERMISSION|INVENTORY/.test(g.id)?0:g.id==='NO-TARGETS'?1:2;
  const globalGaps = [...(report.globalGaps || [])].sort((a,b)=>priority(a)-priority(b)), gaps = [...globalGaps, ...projects.flatMap(p => p.gaps)];
  const pending = projects.filter(p => p.status !== 'ready');
  const unresolved = globalGaps.length > 0 || pending.length > 0 || gaps.length > 0 || report.status === 'attention';
  const recovered = report.recovered === true && !unresolved;
  const mentioned = new Set(), used = new Set(), missing = new Set(), mentionMissing = [];
  const plans = projects.map(project => ({ project, plan: recipients(project, config) }));
  for (const { project, plan } of plans) for (const item of plan.missing) {
    mentionMissing.push({ ...item, project: project.project || project.key });
    missing.add(`${project.project || project.key} / ${item.role}`);
  }
  const person = actor => {
    if (!actor) { missing.add('责任人'); return '责任人待登记'; }
    const p = people[actor];
    if (verifiedPerson(p)) {
      mentioned.add(p.feishu.id);
      if (!used.has(p.feishu.id)) { used.add(p.feishu.id); return `<at id="${p.feishu.id}"></at>`; }
    } else {
      missing.add(actor);
      if (!mentionMissing.some(item => item.actor === actor)) mentionMissing.push({ role: '通知责任人', actor, reason: '缺少已验证的飞书身份映射' });
    }
    return md(p?.name || actor);
  };
  const summaryCounts = { attention: projects.filter(p => p.status === 'attention').length, ready: projects.filter(p => p.status === 'ready').length, unverified: projects.filter(p => p.status === 'unverified').length };
  const authFailure=globalGaps.some(g=>g.id==='JENKINS-AUTH'||/HTTP 401/.test(g.message||''));
  const permissionFailure=globalGaps.some(g=>g.id==='JENKINS-PERMISSION'||/HTTP 403/.test(g.message||''));
  const noProjects=projects.length===0;
  const accessBlocked=noProjects&&(authFailure||permissionFailure);
  // A failed read is the cause; NO-TARGETS and pending governance files are
  // downstream facts. Keep every fact in the report without counting them as
  // separate repairs in the access-failure card.
  const title=accessBlocked?(authFailure?'公共巡检｜账号认证失败':'公共巡检｜任务读取受限'):noProjects?'公共巡检｜业务项目未检查':recovered?'接入缺项已消除｜转入九维检查':unresolved?'项目接入巡检｜需处理':'项目接入巡检｜前置就绪';
  const verdict=noProjects?(authFailure?'Jenkins巡检账号认证失败（HTTP 401）':permissionFailure?'Jenkins巡检账号无任务读取权限（HTTP 403）':'未识别到可检查的业务项目｜本轮尚未完成检查'):recovered?'接入缺项已消除｜转入现有九维检查与Review准入':unresolved?'发现接入缺项｜补齐后自动复检':'接入前置就绪｜进入九维检查与Review准入';
  const elements=[notificationText(verdict,noProjects?'red':recovered?'green':unresolved?'orange':'blue')];
  if(report.execution?.number)elements.push(notificationText('检查来源：公共巡检 · 第'+clean(report.execution.number)+'次','grey','notation'));
  const trigger=report.trigger;
  const actor=trigger?(people[trigger.id]?.name||trigger.name||trigger.id||({timer:'定时巡检',upstream:'上游任务',event:'自动事件'}[trigger.type])||'来源未核验'):'来源未核验';
  elements.push({tag:'markdown',text_size:'normal',content:'**触发人**：'+md(actor)+(trigger?.id&&trigger.id!==actor?'（'+md(trigger.id)+'）':'')+'　｜　'+formatNotificationTime(report.checkedAt)});
  if(noProjects)elements.push(notificationText((accessBlocked?'本轮未读取业务项目':'尚未识别可检查的业务项目')+'，未检查项目Gate，未执行九维质量检查。','orange'));
  else elements.push(notificationText('识别仓库 '+new Set(projects.map(p=>p.project).filter(Boolean)).size+' 个 · 检查范围 '+projects.length+' 项 · 需处理 '+pending.length+' 项 · 接入就绪 '+summaryCounts.ready+' 项','default'));
  if(accessBlocked){
    if(report.inventory?.readerAccount)elements.push(notificationText('当前巡检登录账号：'+clean(report.inventory.readerAccount),'default'));
    elements.push({tag:'markdown',text_size:'normal',content:authFailure?'**现在处理**：运行增量更新入口，填写真实Jenkins登录用户名及该账号生成的API Token；验证通过后自动重新巡检。\n可复用已有账号，无需新建；请勿填写内部凭据编号或Git账号。':'**现在处理**：为巡检账号开通目标Folder／Job的Read、ExtendedRead及归档读取权限，再运行同一增量入口复检。'});
  }
  if (gaps.length&&!accessBlocked) {
    const groups = new Map();
    for (const gap of gaps) { const key = category(String(gap.id || '')); groups.set(key, (groups.get(key) || 0) + 1); }
    elements.push(notificationText(`接入缺项 ${gaps.length} 项：${[...groups].map(([name, count]) => `${name} ${count}`).join(' · ')}`, 'orange'));
  }
  if (globalGaps.length&&!accessBlocked) elements.push({ tag: 'markdown', text_size: 'normal', content: `**阻断原因与处理**\n${globalGaps.slice(0, 3).map(g => `• ${md(String(g.message || g.id || '接入异常').replaceAll('wl-jenkins-ci-readonly','Jenkins巡检账号'))}\n  处理：${md(g.action || '按本次归档补齐配置，再重跑检查')}`).join('\n')}${globalGaps.length > 3 ? `\n另有 ${globalGaps.length - 3} 项，详见本次记录。` : ''}` });
  const ordered = [...projects].sort((a, b) => (a.status === 'ready') - (b.status === 'ready'));
  const visible = ordered.slice(0, 3);
  for (const p of visible) {
    const role = recipients(p, config);
    const who = [`执行人 ${person(role.executor)}`, `技术经理 ${person(role.manager)}`, role.observer ? `同步 ${person(role.observer)}` : ''].filter(Boolean).join('　｜　');
    const label = p.status === 'ready' ? '前置就绪' : p.status === 'unverified' ? '待验证' : '待补齐';
    const body = p.gaps.length ? p.gaps.slice(0, 2).map(g => `• ${md(g.message || g.id)}\n  处理：${md(g.action || '按本次归档补齐配置，再重跑检查')}`).join('\n') + (p.gaps.length > 2 ? `\n另有 ${p.gaps.length - 2} 项，详见本次记录。` : '') : '接入前置已核对；九维质量、Review授权和构建准入仍须按实际检查执行。';
    elements.push({ tag: 'markdown', text_size: 'normal', content: `**${md(p.project || '仓库待识别')} · ${md(p.branch || '分支待识别')} · ${label}**\n${who}\n${body}` });
  }
  // Resolve every affected project's recipients even when the visual preview is
  // capped. Hidden projects must not silently lose their required reminder.
  const publicRecipients = globalGaps.length || !projects.length ? (publicTasks.recipients || []) : [];
  const reminderActors = [...new Set(projects.flatMap(p => recipients(p, config).actors).concat(publicRecipients, fallbackRecipients.filter(v => typeof v === 'string' && v)))];
  const extraReminders = reminderActors.filter(actor => {
    const p = people[actor];
    return !verifiedPerson(p) || !used.has(p.feishu.id);
  }).map(person);
  if (projects.length > visible.length) elements.push(notificationText(`仅展示 ${visible.length}/${projects.length} 个项目；其余 ${projects.length - visible.length} 个项目及完整缺项见本次记录。`, 'grey'));
  const run = httpsUrl(report.runUrl), origin = httpsUrl(report.jenkinsOrigin);
  const links=report.links;
  const detail=httpsUrl(links?.reportUrl),log=httpsUrl(links?.logUrl);
  if (links?.status==='verified'&&run&&origin&&detail&&log&&run.origin===origin.origin&&detail.href===new URL('artifact/wl-ops-public/index.html',run).href&&log.href===new URL('console',run).href) {
    const button = (label, target) => ({tag:'button',type:'default',width:'fill',text:{tag:'plain_text',content:label},behaviors:[{type:'open_url',default_url:target}]});
    elements.push({tag:'column_set',horizontal_spacing:'8px',columns:[{tag:'column',width:'weighted',weight:1,elements:[button('详情',detail.href)]},{tag:'column',width:'weighted',weight:1,elements:[button('日志',log.href)]}]});
  }else elements.push(notificationText(accessBlocked?'账号访问恢复后自动验证详情和日志；当前不显示未验证按钮。':'报告链接暂未验证：'+clean(links?.reason||'先完成本轮归档与读取校验；本条不提供未验证按钮'),'orange','notation'));
  if(networkAccess==='intranet-vpn')elements.push(notificationText('需公司内网／VPN，并登录具有该任务读取权限的Jenkins账号。','grey','notation'));
  if (!reminderActors.length && !visible.some(p => recipients(p, config).manager)) {
    missing.add('责任人');
    if (!mentionMissing.length) mentionMissing.push({ role: '责任人', actor: null, reason: '未登记' });
  }
  if (extraReminders.length) elements.push({ tag: 'markdown', text_size: 'normal', content: `**请关注并完成闭环**：${extraReminders.join('、')}\n${accessBlocked?'请协助恢复巡检账号访问并确认复检结果；识别项目后继续检查Gate接入及九维质量。':'请补齐接入缺项，完成复检和九维检查，跟进修复与回归结果。'}` });
  else elements.push(notificationText('请责任人补齐缺项并复检，跟进九维检查、修复与回归闭环。', 'blue'));
  if (missing.size) elements.push(notificationText(`责任人或真实 @ 尚未配置；通知尚未完成：${[...missing].slice(0, 5).map(md).join('、')}${missing.size > 5 ? `等 ${missing.size} 项` : ''}。姓名／工号文字不代表已触达，请补齐已验证的人员映射。`, 'orange', 'notation'));
  elements.push(notificationText('未接入不等于扫描通过。前置就绪仅表示可继续检查；本通知不授予构建、部署或Review签发权限。', 'grey', 'notation'));
  const payload = { msg_type: 'interactive', card: { schema: '2.0', header: { template: noProjects?'red':recovered ? 'green' : unresolved ? 'orange' : 'blue', padding: '10px 16px 10px 16px', title: { tag: 'plain_text', content: title } }, body: { padding: '10px 16px 12px 16px', vertical_spacing: '6px', elements } } };
  if (missing.size && !noProjects) payload.card.header.template = 'orange';
  if (Buffer.byteLength(JSON.stringify(payload)) > 20000) throw new Error('运维通知超过飞书卡片预算，请缩小盘点批次');
  return { payload, mentions: [...mentioned], mentionMappingComplete: missing.size === 0, mentionMissing, notificationComplete: missing.size === 0 };
}

export async function sendOpsNotification(report, config = {}, { env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const notification = opsNotification(report, config);
  const {payload,...notificationPresentation}=applyNotificationPresentation(notification.payload,{profileFile:config.presentationFile});
  notification.payload=payload;
  const receipt = (status, reason) => ({ status, reason,
    providerAccepted: status === 'sent', notificationComplete: status === 'sent' && notification.mentionMappingComplete,
    notificationStatus: status === 'sent' ? notification.mentionMappingComplete ? 'complete' : 'attention' : status,
    mentionDeliveryConfirmed: false, mentions: notification.mentions, mentionMappingComplete: notification.mentionMappingComplete,
    mentionMissing: notification.mentionMissing, notificationPresentation, qualityPassed: false, buildAuthorized: false });
  const webhook = env.WL_FEISHU_CI_WEBHOOK, secret = env.WL_FEISHU_CI_SECRET;
  const url = httpsUrl(webhook);
  if (!url || url.hostname !== 'open.feishu.cn' || url.port || url.search || url.hash || !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+$/.test(url.pathname) || typeof secret !== 'string' || !secret) return receipt('not-sent', '缺少批准的流水线机器人地址或签名凭据；请配置CI机器人，不能使用项目机器人替代');
  const instant = typeof now === 'function' ? now() : now;
  if (!Number.isFinite(instant)) throw new Error('通知时间无效');
  const timestamp = String(Math.floor(instant / 1000));
  const body = { ...notification.payload, timestamp, sign: createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64') };
  let response;
  try { response = await fetchImpl(url.href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) }); }
  catch { return receipt('unknown', '网络或超时，送达状态未知；先核对群记录，不自动重发'); }
  if (response.status !== 200) return receipt('rejected', '飞书返回HTTP错误；本次未确认送达');
  try {
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > 65536) return receipt('unknown', '响应过大，无法确认送达；先核对群记录');
    // Read a bounded stream when available. Test/provider adapters may only
    // implement text(); their result is still checked before parsing.
    let raw = '';
    if (response.body?.[Symbol.asyncIterator]) {
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += Buffer.byteLength(chunk); if (bytes > 65536) return receipt('unknown', '响应过大，无法确认送达；先核对群记录'); chunks.push(Buffer.from(chunk)); }
      raw = Buffer.concat(chunks).toString('utf8');
    } else if (typeof response.text === 'function') raw = await response.text();
    else if (typeof response.json === 'function') raw = JSON.stringify(await response.json());
    if (Buffer.byteLength(raw) > 65536) return receipt('unknown', '响应过大，无法确认送达；先核对群记录');
    const result = JSON.parse(raw), codes = ['code', 'StatusCode'].filter(k => Object.hasOwn(result || {}, k)).map(k => result[k]);
    return codes.length && codes.every(code => Number.isInteger(code) && code === 0) ? receipt('sent', notification.mentionMappingComplete ? '飞书已确认接收；已包含配置的责任人@，个人触达仍需群内核验' : '飞书已确认接收；责任人提醒尚未完成，请补齐回执中的人员身份缺项') : receipt('rejected', '飞书未确认接收；检查CI机器人安全设置');
  } catch { return receipt('unknown', '飞书响应无法校验，送达状态未知；先核对群记录，不自动重发'); }
}
