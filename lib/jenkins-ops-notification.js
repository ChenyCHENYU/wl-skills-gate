import { createHmac } from 'node:crypto';
import { notificationText } from './notification-style.js';
import { formatNotificationTime } from './notification-time.js';

// Operations readiness is independent from quality/admission. Missing project
// configuration must still produce an actionable CI notice, without requiring
// that project's governance config or any source-controlled notification code.
const clean = (value, max = 180) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/https?:\/\/[^\s<>)]+/g, raw => { try { const u = new URL(raw); return `${u.origin}${u.pathname}`; } catch { return '[地址已隐藏]'; } })
  .replace(/\b(token|password|secret|authorization)\s*[:=]\s*\S+/gi, '$1=[已隐藏]').slice(0, max);
const md = value => clean(value).replace(/[\\`*_~\[\]<>]/g, '\\$&');
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) && id !== 'all';
const verifiedPerson = p => !!(p?.name && ['open_id', 'user_id'].includes(p.feishu?.idType) && safeId(p.feishu.id)
  && (p.feishu.idType !== 'open_id' || p.feishu.id.startsWith('ou_'))
  && (p.feishu.verified === true || p.feishu.identityVerified === true));
const category = id => /gate|package|runtime|node|python|java|tool|engine/i.test(id) ? 'Gate／执行环境'
  : /owner|people|person|actor|mention|manager/i.test(id) ? '责任人／提醒'
    : /credential|token|secret|auth|permission/i.test(id) ? '凭据／访问权限'
      : /review|trust|sign/i.test(id) ? 'Review／准入'
        : /hook|trigger|branch|event/i.test(id) ? '触发／分支接线'
          : /registry|binding|config|policy|fleet|source|automation|project|check/i.test(id) ? '项目／检查配置' : '其他接入缺项';
const httpsUrl = value => { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname && !u.username && !u.password && !u.hash ? u : null; } catch { return null; } };

function recipients(project, config) {
  let owner = config.owners?.[project.key] ?? config.owners?.[project.project] ?? {};
  if (typeof owner === 'string') owner = { technicalManager: owner };
  const manager = project.technicalManager || owner.technicalManager;
  const executor = project.executor || owner.executor;
  const same = !!manager && !!executor && (manager === executor || (verifiedPerson(config.people?.[manager]) && verifiedPerson(config.people?.[executor]) && config.people[manager].feishu.id === config.people[executor].feishu.id));
  const observer = same ? project.managerSubmissionNotify || owner.managerSubmissionNotify : null;
  const actors = [...new Set([executor, manager, observer, ...(Array.isArray(owner.recipients) ? owner.recipients : [])].filter(v => typeof v === 'string' && v))];
  return { manager, executor, observer, actors };
}

export function opsNotification(report, { people = {}, owners = {}, fallbackRecipients = [] } = {}) {
  if (report?.kind !== 'jenkins-ops-report' || !Array.isArray(report.projects)
    || report.projects.some(p => !p || !['attention', 'ready', 'unverified'].includes(p.status) || !Array.isArray(p.gaps))
    || (report.globalGaps !== undefined && !Array.isArray(report.globalGaps))) throw new Error('需要真实运维接入检查报告');
  const config = { people, owners }, projects = report.projects;
  const globalGaps = report.globalGaps || [], gaps = [...globalGaps, ...projects.flatMap(p => p.gaps)];
  const pending = projects.filter(p => p.status !== 'ready');
  const unresolved = globalGaps.length > 0 || pending.length > 0 || gaps.length > 0 || report.status === 'attention';
  const recovered = report.recovered === true && !unresolved;
  const mentioned = new Set(), used = new Set(), missing = new Set();
  const person = actor => {
    if (!actor) { missing.add('责任人'); return '责任人待登记'; }
    const p = people[actor];
    if (verifiedPerson(p)) {
      mentioned.add(p.feishu.id);
      if (!used.has(p.feishu.id)) { used.add(p.feishu.id); return `<at id="${p.feishu.id}"></at>`; }
    } else missing.add(actor);
    return md(p?.name || actor);
  };
  const summaryCounts = { attention: projects.filter(p => p.status === 'attention').length, ready: projects.filter(p => p.status === 'ready').length, unverified: projects.filter(p => p.status === 'unverified').length };
  const title = recovered ? '接入缺项已消除｜转入九维检查' : unresolved ? '流水线接入检查｜需处理' : '流水线接入检查｜前置就绪';
  const verdict = recovered ? '接入缺项已消除｜转入现有九维检查与Review准入' : unresolved ? '暂停质量放行｜先补齐接入缺项，修复后自动复检' : '接入前置就绪｜进入现有九维检查与Review准入';
  const elements = [notificationText(verdict, recovered ? 'green' : unresolved ? 'red' : 'blue'),
    { tag: 'markdown', text_size: 'normal', content: `**检查时间**：${formatNotificationTime(report.checkedAt)}\n**项目**：${projects.length}　｜　**待补齐**：${summaryCounts.attention}　｜　**待验证**：${summaryCounts.unverified}　｜　**前置就绪**：${summaryCounts.ready}` }];
  if (gaps.length) {
    const groups = new Map();
    for (const gap of gaps) { const key = category(String(gap.id || '')); groups.set(key, (groups.get(key) || 0) + 1); }
    elements.push(notificationText(`接入缺项 ${gaps.length} 项：${[...groups].map(([name, count]) => `${name} ${count}`).join(' · ')}`, 'orange'));
  }
  if (globalGaps.length) elements.push({ tag: 'markdown', text_size: 'normal', content: `**公共配置**\n${globalGaps.slice(0, 2).map(g => `• ${md(g.message || g.id)}\n  处理：${md(g.action || '按本次归档补齐配置，再重跑检查')}`).join('\n')}${globalGaps.length > 2 ? `\n另有 ${globalGaps.length - 2} 项，详见本次记录。` : ''}` });
  const ordered = [...projects].sort((a, b) => (a.status === 'ready') - (b.status === 'ready'));
  const visible = ordered.slice(0, 3);
  for (const p of visible) {
    const role = recipients(p, config);
    const who = [role.executor ? `执行人 ${person(role.executor)}` : '', `技术经理 ${person(role.manager)}`, role.observer ? `同步 ${person(role.observer)}` : ''].filter(Boolean).join('　｜　');
    const label = p.status === 'ready' ? '前置就绪' : p.status === 'unverified' ? '待验证' : '待补齐';
    const body = p.gaps.length ? p.gaps.slice(0, 2).map(g => `• ${md(g.message || g.id)}\n  处理：${md(g.action || '按本次归档补齐配置，再重跑检查')}`).join('\n') + (p.gaps.length > 2 ? `\n另有 ${p.gaps.length - 2} 项，详见本次记录。` : '') : '接入前置已核对；九维质量、Review授权和构建准入仍须按实际检查执行。';
    elements.push({ tag: 'markdown', text_size: 'normal', content: `**${md(p.project || p.key)} · ${md(p.branch || '分支待识别')} · ${label}**\n${who}\n${body}` });
  }
  // Resolve every affected project's recipients even when the visual preview is
  // capped. Hidden projects must not silently lose their required reminder.
  const reminderActors = [...new Set(projects.flatMap(p => recipients(p, config).actors).concat(fallbackRecipients.filter(v => typeof v === 'string' && v)))];
  const extraReminders = reminderActors.filter(actor => {
    const p = people[actor];
    return !verifiedPerson(p) || !used.has(p.feishu.id);
  }).map(person);
  if (projects.length > visible.length) elements.push(notificationText(`仅展示 ${visible.length}/${projects.length} 个项目；其余 ${projects.length - visible.length} 个项目及完整缺项见本次记录。`, 'grey'));
  const run = httpsUrl(report.runUrl), origin = httpsUrl(report.jenkinsOrigin);
  if (run && origin && run.origin === origin.origin && !run.search) elements.push({ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看本次接入检查与完整缺项' }, behaviors: [{ type: 'open_url', default_url: run.href }] });
  else elements.push(notificationText('详情见本次 Jenkins 归档；尚未提供可验证的 HTTPS 记录地址。', 'grey', 'notation'));
  if (!reminderActors.length && !visible.some(p => recipients(p, config).manager)) missing.add('责任人');
  if (extraReminders.length) elements.push({ tag: 'markdown', text_size: 'normal', content: `**请关注并完成闭环**：${extraReminders.join('、')}\n请补齐接入缺项，完成复检和九维检查，跟进修复与回归结果。` });
  else elements.push(notificationText('请责任人补齐缺项并复检，跟进九维检查、修复与回归闭环。', 'blue'));
  if (missing.size) elements.push(notificationText('责任人或真实 @ 尚未配置；姓名／工号文字不代表已触达，请工程维护者补齐已验证的人员映射。', 'orange', 'notation'));
  elements.push(notificationText('未接入不等于扫描通过。前置就绪仅表示可继续检查；本通知不授予构建、部署或Review签发权限。', 'grey', 'notation'));
  const payload = { msg_type: 'interactive', card: { schema: '2.0', header: { template: recovered ? 'green' : unresolved ? 'orange' : 'blue', padding: '10px 16px 10px 16px', title: { tag: 'plain_text', content: title } }, body: { padding: '10px 16px 12px 16px', vertical_spacing: '6px', elements } } };
  if (Buffer.byteLength(JSON.stringify(payload)) > 20000) throw new Error('运维通知超过飞书卡片预算，请缩小盘点批次');
  return { payload, mentions: [...mentioned], mentionMappingComplete: missing.size === 0 };
}

export async function sendOpsNotification(report, config = {}, { env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const notification = opsNotification(report, config);
  const receipt = (status, reason) => ({ status, reason, mentions: notification.mentions, mentionMappingComplete: notification.mentionMappingComplete, qualityPassed: false, buildAuthorized: false });
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
    return codes.length && codes.every(code => Number.isInteger(code) && code === 0) ? receipt('sent', '飞书已确认接收') : receipt('rejected', '飞书未确认接收；检查CI机器人安全设置');
  } catch { return receipt('unknown', '飞书响应无法校验，送达状态未知；先核对群记录，不自动重发'); }
}
