#!/usr/bin/env node
// 接入程序复制到 <项目>/scripts/quality；只调用项目内固定版本 Gate，不启动 AI。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, realpathSync, rmSync, lstatSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const reportDir = path.join(root, 'quality-reports');
const summaryFile = path.join(reportDir, 'quality-summary.json');
const planFile = path.join(reportDir, 'repair', 'fix-plan.json');
const receiptFile = path.join(reportDir, 'repair', 'preview-confirmation.json');
const confirmToken = '确认已预览的机械修复';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function reviewPath(base, relative) {
  if (base !== root && (lstatSync(base).isSymbolicLink() || !realpathSync(base).startsWith(realpathSync(root) + path.sep))) throw new Error('报告目录不能越出项目或指向符号链接');
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\')
    || relative.split('/').some(part => ['', '.', '..'].includes(part))) throw new Error('草稿索引路径失效');
  let file = base;
  for (const part of relative.split('/')) {
    file = path.join(file, part);
    if (lstatSync(file).isSymbolicLink()) throw new Error('草稿索引不接受符号链接');
  }
  if (!lstatSync(file).isFile() || !realpathSync(file).startsWith(realpathSync(base) + path.sep)) throw new Error('草稿必须是报告目录中的普通文件');
  return file;
}

function currentReview(summary) {
  const review = readJson(reviewPath(reportDir, 'review-latest.json'));
  if (![1, 2].includes(review.schemaVersion) || review.approved !== false || review.eventId !== summary.run?.eventId
    || review.project !== summary.run?.project || !/^[A-Za-z0-9-]{1,128}$/.test(review.eventId || '')) throw new Error('草稿与本轮报告不匹配');
  const base = review.schemaVersion === 2 ? reportDir : root;
  const destination = path.join(reportDir, 'reviews', review.eventId);
  const body = reviewPath(base, review.bodyFile), recordFile = reviewPath(base, review.recordFile), copy = reviewPath(base, review.summaryFile);
  if (body !== path.join(destination, 'draft/review.md') || recordFile !== path.join(destination, 'draft/review-draft.json')
    || copy !== path.join(destination, 'quality-summary.json')) throw new Error('草稿索引未指向本轮独立记录');
  if (review.summaryHash !== sha256(readFileSync(summaryFile)) || review.summaryHash !== sha256(readFileSync(copy))) throw new Error('草稿原始报告摘要不匹配');
  const record = readJson(recordFile);
  if (record.schemaVersion !== 2 || record.kind !== 'review-draft' || record.decision !== 'pending-confirmation'
    || record.content?.project !== summary.run.project || record.content?.candidateSha !== summary.run.commitSha
    || record.content?.reviewId !== review.eventId || record.bodyFile !== 'draft/review.md'
    || record.bodyDigest !== sha256(readFileSync(body)) || record.reviewDigest !== sha256(stable(record.content))
    || record.evidenceDigest !== sha256(stable(record.content.evidence))
    || ['repairAuthorized', 'promotionAuthorized', 'deploymentAuthorized', 'closureAuthorized'].some(key => record[key] !== false)) throw new Error('草稿记录或正文已变化');
  const evidence = record.content.evidence.filter(item => item.type === 'gate-summary' && item.role === 'current');
  if (evidence.length !== 1 || evidence[0].sha256 !== review.summaryHash || evidence[0].file !== 'quality-summary.json') throw new Error('草稿缺少本轮原始报告证据');
  if (!Array.isArray(record.content.dimensions) || record.content.dimensions.length !== 9) throw new Error('草稿九维记录无效');
  return { review, body, pendingDimensions: record.content.dimensions.filter(item => item.status !== 'evidence-ready').length };
}

function summaryState() {
  if (!existsSync(summaryFile)) return { digest: null, eventId: null, summary: null };
  const bytes = readFileSync(summaryFile);
  let summary;
  try { summary = JSON.parse(bytes.toString('utf8')); } catch { summary = null; }
  return { digest: sha256(bytes), eventId: summary?.run?.eventId || null, summary };
}

function gate(args) {
  const cli = [
    path.join(root, 'node_modules/@agile-team/wl-skills-gate/bin/wl-skills-gate.js'),
    path.join(root, 'quality-tools/node_modules/@agile-team/wl-skills-gate/bin/wl-skills-gate.js'),
  ].find(existsSync);
  if (!cli) throw new Error('项目缺少固定版本 Gate，请由接入负责人修复安装；检查不会跳过。');
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, shell: false, stdio: 'inherit' });
  if (result.error || result.signal) {
    console.error(`[quality] Gate 执行失效：${result.error?.message || result.signal}`);
    return 2;
  }
  return Number.isInteger(result.status) ? result.status : 2;
}

function showReport({ failure = false, current = false } = {}) {
  const htmlFile = path.join(reportDir, 'quality-report.html');
  console.log(`[quality] 报告：${existsSync(htmlFile) ? htmlFile : summaryFile}`);
  if (!existsSync(summaryFile)) return;
  const summary = readJson(summaryFile);
  console.log(`[quality] ${current ? '本轮' : '历史报告'}结论：${summary.decision?.status || '未知'}；版本：${summary.run?.commitSha || '未知'}`);
  const reviewIndex = path.join(reportDir, 'review-latest.json');
  if (existsSync(reviewIndex)) {
    try {
      const { body, pendingDimensions } = currentReview(summary);
      console.log(`[quality] 九维 Review（待确认）：${body}；待补 ${pendingDimensions} 维。草稿不授予修复或发布权限。`);
    } catch { console.log('[quality] 当前扫描没有可核验的九维草稿，请接入负责人检查本轮记录。'); }
  }
  const findings = Array.isArray(summary.findings) ? summary.findings : [];
  const visible = failure ? findings.filter((f) => ['blocker', 'error'].includes(f.severity)) : findings;
  for (const finding of visible.slice(0, 5)) {
    console.log(`  ${finding.file}${finding.line ? `:${finding.line}` : ''} [${finding.ruleId}] ${finding.message}`);
    if (finding.suggestion) console.log(`  建议：${finding.suggestion}`);
  }
  if (visible.length > 5) console.log(`  另有 ${visible.length - 5} 项，详见报告。`);
  for (const check of (summary.checks || []).filter((c) => c.status !== 'ok').slice(0, 5)) {
    console.log(`  检查失效：${check.checkId} ${check.reason || check.note || check.status}`);
  }
}

function completeStandard(summary) {
  return summary.run?.profile === 'standard' && !summary.run.scope && !summary.run.base
    && ['passed', 'blocked'].includes(summary.decision?.status)
    && Array.isArray(summary.checks) && summary.checks.length > 0 && summary.checks.every((c) => c.status === 'ok');
}

function loadPlan() {
  const bytes = readFileSync(planFile, 'utf8');
  const plan = JSON.parse(bytes);
  if (plan.schemaVersion !== 2 || !/^[a-f0-9]{64}$/.test(plan.planHash || '')
    || path.resolve(plan.root || '') !== root || !Array.isArray(plan.items)
    || plan.items.some((item) => !['command', 'manual'].includes(item.action))) {
    throw new Error('修复计划格式或项目不匹配，请重新预览。');
  }
  return { plan, bytes, digest: sha256(bytes) };
}

function showPlan(plan) {
  console.log(`[quality] 实际 planHash：${plan.planHash}`);
  console.log(`[quality] 计划文件：${planFile}`);
  for (const item of plan.items) {
    console.log(`  ${item.action === 'command' ? '脚本修复' : '人工处理'} [${item.ruleId}] ${item.file}：${item.message || ''}`);
    if (item.action === 'command') console.log(`  允许修改：${(item.allowedFiles || []).join(', ')}`);
  }
  const mechanical = plan.items.filter((item) => item.action === 'command').length;
  console.log(`[quality] 脚本项 ${mechanical}；人工项 ${plan.items.length - mechanical}。请核对以上实际摘要与报告后确认；仅脚本项可执行。`);
}

function createPlan({ acknowledgePreview = false } = {}) {
  const summary = readJson(summaryFile);
  if (!completeStandard(summary)) throw new Error('只有完整有效的 standard 报告可生成机械计划；先解决检查失效。');
  const code = gate(['fix', '--plan', summaryFile]);
  if (code !== 0) return code;
  const { plan, digest } = loadPlan();
  showPlan(plan);
  if (acknowledgePreview) {
    writeFileSync(receiptFile, JSON.stringify({ schemaVersion: 1, root, planHash: plan.planHash, planDigest: digest }, null, 2));
  }
  console.log('[quality] 已生成预览，未修改业务源码。');
  return 0;
}

function runCurrentCheck(profile, scope) {
  const before = summaryState();
  let code;
  try { code = gate(['run', '--root', root, '--profile', profile, ...(scope ? ['--scope', scope] : [])]); }
  catch (error) { console.error(`[quality] ${error.message}`); code = 2; }
  const after = summaryState();
  const fresh = after.digest !== null && after.digest !== before.digest
    && typeof after.eventId === 'string' && after.eventId.length > 0 && after.eventId !== before.eventId;
  if (!fresh) {
    console.error('[quality] 本次未产生有效报告；不能放行或使用历史报告生成修复计划，请交接入负责人处理。');
    if (existsSync(summaryFile)) console.log(`[quality] 历史报告仅供参考：${summaryFile}`);
    return { code: code === 0 ? 2 : code, fresh: false };
  }
  // 退出 0 还必须有本次 passed 事实，避免错误执行器返回成功。
  if (code === 0 && after.summary?.decision?.status !== 'passed') code = 2;
  return { code, fresh: true };
}

function runCheck(profile, scope) {
  const { code, fresh } = runCurrentCheck(profile, scope);
  if (!fresh) return code;
  if (code !== 0) {
    try { showReport({ failure: true, current: true }); } catch (error) { console.error(`[quality] 报告不可读：${error.message}`); }
    if (profile === 'standard' && code === 1) {
      try {
        if (completeStandard(readJson(summaryFile))) createPlan();
      } catch (error) { console.error(`[quality] 机械预览暂不可用：${error.message}`); }
    }
    console.error('[quality] 请查看报告；需要脚本修复时选择编辑器“预览脚本修复”。检查失效交接入负责人处理。');
  }
  // 预览结果不能把本轮 Hook 的失败改为成功，也不能掩盖原退出码。
  return code;
}

function previewRepair() {
  rmSync(receiptFile, { force: true });
  const { code, fresh } = runCurrentCheck('standard');
  if (!fresh) return code;
  if (![0, 1].includes(code)) { showReport({ failure: true, current: true }); return code; }
  showReport({ failure: code === 1, current: true });
  return createPlan({ acknowledgePreview: true });
}

function reviewedPlanState() {
  if (!existsSync(planFile) || !existsSync(receiptFile)) throw new Error('尚未通过预览任务查看机械计划；请先选择“预览脚本修复”。');
  const { plan, bytes, digest } = loadPlan();
  const receiptBytes = readFileSync(receiptFile);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  if (receipt.root !== root || receipt.planHash !== plan.planHash || receipt.planDigest !== digest) {
    throw new Error('计划已在预览后改变；本次零写入，请重新预览后另行确认。');
  }
  return { plan, bytes, planHash: plan.planHash, planDigest: digest, receiptDigest: sha256(receiptBytes) };
}

// 可注入交互用于隔离验证；实际入口只使用真实 TTY，不接受 pipe 中的确认。
export async function confirmReviewedPlan({ interactive, readReview, showReview, ask, applyReviewed, onCancel }) {
  if (!interactive) { onCancel('非交互终端，已取消修复。'); return 0; }
  const captured = readReview();
  showReview(captured);
  const answer = await ask();
  if (String(answer).trim() !== '1') { onCancel('已取消修复。'); return 0; }
  const latest = readReview();
  if (['planHash', 'planDigest', 'receiptDigest'].some((key) => captured[key] !== latest[key])) {
    throw new Error('确认期间计划或预览回执已变化；本次零写入，请重新预览并确认。');
  }
  return applyReviewed(captured);
}

async function confirmRepair() {
  let terminal;
  try {
    return await confirmReviewedPlan({
      interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
      readReview: reviewedPlanState,
      showReview: ({ plan }) => showPlan(plan),
      ask: async () => {
        terminal = createInterface({ input: process.stdin, output: process.stdout });
        return terminal.question('仅应用以上已预览的机械计划：输入 1 确认，直接 Enter 取消：');
      },
      applyReviewed: (review) => applyRepair(confirmToken, review.planHash, review.planDigest, review.receiptDigest),
      onCancel: (message) => console.log(`[quality] ${message}未调用写入命令。`),
    });
  } finally { terminal?.close(); }
}

function applyRepair(token, expectedHash, expectedDigest, expectedReceiptDigest) {
  if (token !== confirmToken) {
    console.log('[quality] 已取消修复，未调用写入命令。');
    return 0;
  }
  if (!/^[a-f0-9]{64}$/.test(expectedHash || '') || !/^[a-f0-9]{64}$/.test(expectedDigest || '')) {
    throw new Error('确认必须绑定实际 planHash 和计划文件摘要；固定确认文字不能单独授权修复。');
  }
  const review = reviewedPlanState();
  const { plan, bytes } = review;
  if (review.planHash !== expectedHash || review.planDigest !== expectedDigest
    || (expectedReceiptDigest !== undefined && review.receiptDigest !== expectedReceiptDigest)) {
    throw new Error('确认对应的计划或预览回执已变化；本次零写入，请重新预览并确认。');
  }
  showPlan(plan);
  if (!plan.items.some((item) => item.action === 'command')) {
    console.log('[quality] 计划没有可机械修复项，请按报告处理人工项。');
    return 0;
  }
  // 不自动刷新失效计划再套用旧确认；漂移由 Gate 重新核验并拒绝。
  const fixFile = path.join(reportDir, 'repair', 'fix-report.json');
  const beforeFixDigest = existsSync(fixFile) ? sha256(readFileSync(fixFile)) : null;
  const beforeSummaryDigest = existsSync(summaryFile) ? sha256(readFileSync(summaryFile)) : null;
  // 固定计划名可被另一次预览覆盖；给 Gate 读取本次已确认的独立副本。
  const reviewedPlanFile = path.join(path.dirname(planFile), `fix-plan-reviewed-${randomUUID()}.json`);
  writeFileSync(reviewedPlanFile, bytes, { flag: 'wx' });
  rmSync(receiptFile, { force: true });
  const code = gate(['fix', '--apply', reviewedPlanFile, '--confirm']);
  const freshFix = existsSync(fixFile) && sha256(readFileSync(fixFile)) !== beforeFixDigest;
  if (freshFix) {
    const fix = readJson(fixFile);
    if (fix.planFile !== reviewedPlanFile) throw new Error('修复反馈不属于本次计划，不能宣称复扫成功。');
    console.log(`[quality] 修复反馈：已修复 ${(fix.fixed || []).length}；剩余 ${(fix.remaining || []).length}；新增 ${(fix.regressions || []).length}；人工项 ${(fix.skipped || []).length}。`);
    console.log(`[quality] 恢复已核验=${fix.rolledBack === true}；需人工恢复=${fix.manualRecoveryRequired === true}；台账关闭=${fix.closed === true}；下一状态=${fix.nextState || '未知'}。`);
    console.log(`[quality] 修复报告：${fixFile}`);
  } else {
    console.log('[quality] 应用未产生本次修复反馈；历史修复报告不能作为本次成功依据。');
  }
  const freshSummary = existsSync(summaryFile) && sha256(readFileSync(summaryFile)) !== beforeSummaryDigest;
  if (freshSummary) showReport({ failure: code !== 0, current: true });
  else console.log(`[quality] 没有新的复扫结果，保留预览前报告：${summaryFile}`);
  console.log('[quality] 复扫结论与问题关闭分别判定；普通警告保留追踪。请按普通代码差异审阅、暂存后再次提交；本动作未暂存、提交或推送。');
  return code === 0 && !freshFix ? 2 : code;
}

async function main() {
try {
  const [action, ...args] = process.argv.slice(2);
  // Git pre-push 提供 remoteName/remoteLocation；仅消费 Hook 参数，绝不转发给 Gate。
  const invalidArgs = action === 'pre-push' ? ![0, 2].includes(args.length)
    : action === 'apply-repair' ? ![0, 1, 3].includes(args.length)
      : action === 'commit-msg' ? args.length > 1 : args.length > 0;
  if (invalidArgs) throw new Error('动作参数不合法。');
  if (['pre-commit','pre-push'].includes(action)) process.env.WL_GATE_TRIGGER='local-hook';
  if (action === 'pre-commit') process.exitCode = runCheck('fast', 'staged');
  else if (action === 'pre-push' || action === 'check') process.exitCode = runCheck('standard');
  else if (action === 'commit-msg') {
    if (!args[0]) throw new Error('commit-msg 缺少 Git 提供的消息文件。');
    process.exitCode = gate(['commit-message', args[0], '--root', root]);
  } else if (action === 'view-report') {
    if (!existsSync(summaryFile)) throw new Error('尚无质量报告，请在正常提交或推送自动检查后查看。');
    showReport();
  } else if (action === 'preview-repair') process.exitCode = previewRepair();
  else if (action === 'confirm-repair') process.exitCode = await confirmRepair();
  else if (action === 'apply-repair') process.exitCode = applyRepair(...args);
  else throw new Error('未知质量动作。');
} catch (error) {
  console.error(`[quality] ${error.message}`);
  process.exitCode = 2;
}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
