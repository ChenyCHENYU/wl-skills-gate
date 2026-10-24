import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, renameSync, symlinkSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyNotificationPresentation } from '../../lib/notification-presentation.js';

const base = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'wl-notification-display-'));
const hash = value => createHash('sha256').update(value).digest('hex');
const profile = overrides => ({ schemaVersion: 1, kind: 'wl-notification-presentation', revision: 'display-1', ...overrides });
function file(value) {
  const dir = mkdtempSync(path.join(base, 'case-')), target = path.join(dir, 'display.json');
  writeFileSync(target, JSON.stringify(value)); return target;
}
function fixture() {
  const button = (content, url) => ({ tag: 'button', type: 'primary', text: { tag: 'plain_text', content }, behaviors: [{ type: 'open_url', default_url: url }] });
  return { msg_type: 'interactive', card: { schema: '2.0', header: { template: 'red', title: { tag: 'plain_text', content: '生产 · wl-produce · 构建准入' } }, body: {
    padding: '10px 16px 12px 16px', vertical_spacing: '6px', elements: [
      { tag: 'markdown', text_size: 'heading-4', content: '⛔ 阻断合并｜2 项严重问题必须解决', font_color: 'red' },
      { tag: 'markdown', text_size: 'normal', content: '**触发人**：杨晨誉　｜　**技术经理**：杨天广\n**分支**：`sit`\n**提交**：fix(pl): 处理导出异常' },
      { tag: 'column_set', columns: [{ tag: 'column', elements: [{ tag: 'markdown', text_size: 'normal', font_color: 'red', content: '严重 2' }] }] },
      { tag: 'markdown', text_size: 'notation', content: '当前检查结果 · 修复未核验' },
      { tag: 'markdown', text_size: 'normal', content: '`a.java:31` · `JAVA/SQL`' },
      { tag: 'column_set', columns: [{ tag: 'column', elements: [button('查看九维检查详情', 'https://reports.example/report/1')] }, { tag: 'column', elements: [button('定位失败阶段', 'https://reports.example/report/1#pipeline-stages')] }] },
      { tag: 'markdown', text_size: 'normal', content: '<at id="409322"></at>、<at id="409102"></at> 请关注、修复并完成回归闭环。' },
    ],
  } } };
}

test('同一稳定配置文件更新后，下一张卡立即生效，不依赖进程缓存或Gate重装', () => {
  const payload = fixture(), original = JSON.stringify(payload);
  const target = file(profile({ density: 'compact', metadataTextSize: 'notation', brandSuffix: 'World Leading', buttonLabels: { reportDetails: '查看质量详情' } }));
  const first = applyNotificationPresentation(payload, { profileFile: target });
  assert.equal(first.status, 'applied'); assert.equal(first.revision, 'display-1');
  assert.equal(first.sha256, hash(readFileSync(target))); assert.equal(first.warning, null);
  assert.equal(first.payload.card.body.padding, '8px 12px 10px 12px');
  assert.equal(first.payload.card.body.elements[1].text_size, 'notation');
  assert.equal(first.payload.card.body.elements[5].columns[0].elements[0].text.content, '查看质量详情');
  writeFileSync(target + '.tmp', JSON.stringify(profile({ revision: 'display-2', density: 'comfortable', brandSuffix: 'WL', buttonLabels: { pipelineStages: '查看失败阶段' } })));
  renameSync(target + '.tmp', target);
  const second = applyNotificationPresentation(payload, { profileFile: target });
  assert.equal(second.status, 'applied'); assert.equal(second.revision, 'display-2');
  assert.notEqual(first.sha256, second.sha256); assert.equal(second.sha256, hash(readFileSync(target)));
  assert.equal(second.payload.card.body.padding, '12px 16px 14px 16px');
  assert.equal(second.payload.card.header.title.content, '生产 · wl-produce · 构建准入 · WL');
  assert.equal(second.payload.card.body.elements[5].columns[1].elements[0].text.content, '查看失败阶段');
  assert.equal(JSON.stringify(payload), original);
});

test('只能改变明确允许的显示路径，结论、修复状态、风险颜色计数、规则、@及URL逐字保留', () => {
  const payload = fixture(), target = file(profile({ density: 'compact', metadataTextSize: 'notation', brandSuffix: 'World Leading', buttonLabels: { reportDetails: '查看质量详情', pipelineStages: '查看失败阶段' } }));
  const result = applyNotificationPresentation(payload, { profileFile: target });
  assert.equal(result.status, 'applied');
  const restored = structuredClone(result.payload);
  restored.card.body.padding = payload.card.body.padding; restored.card.body.vertical_spacing = payload.card.body.vertical_spacing;
  restored.card.header.title.content = payload.card.header.title.content; restored.card.body.elements[1].text_size = payload.card.body.elements[1].text_size;
  for (let i = 0; i < 2; i++) restored.card.body.elements[5].columns[i].elements[0].text.content = payload.card.body.elements[5].columns[i].elements[0].text.content;
  assert.deepEqual(restored, payload);
});

test('无配置不读磁盘且返回独立副本，非飞书卡片沿用原消息', () => {
  const payload = fixture(), result = applyNotificationPresentation(payload);
  assert.equal(result.status, 'default'); assert.equal(result.revision, null); assert.equal(result.sha256, null); assert.equal(result.warning, null);
  assert.deepEqual(result.payload, payload); result.payload.card.body.elements[0].content = 'changed';
  assert.match(payload.card.body.elements[0].content, /阻断合并/);
  assert.deepEqual(applyNotificationPresentation({ msgtype: 'text', text: { content: '质量告警' } }, { profileFile: '/not-read' }), {
    payload: { msgtype: 'text', text: { content: '质量告警' } }, status: 'default', revision: null, sha256: null, warning: null,
  });
});

test('非法数据配置全部回退而不是部分应用或吞掉通知', () => {
  const cases = [
    null, [], {}, profile({ schemaVersion: 2 }), profile({ kind: 'code-template' }), profile({ revision: '../invalid' }),
    profile({ riskColors: { error: 'green' } }), profile({ conclusion: '已通过' }), profile({ mentions: [] }), profile({ rules: [] }),
    profile({ density: 'none' }), profile({ metadataTextSize: '0px' }), profile({ buttonLabels: { unknown: '按钮' } }),
    profile({ buttonLabels: { reportDetails: '<at id="all"></at>' } }), profile({ buttonLabels: { reportDetails: '${process.env.SECRET}' } }),
    profile({ brandSuffix: '<script>run()</script>' }), profile({ brandSuffix: 'https://evil.example' }), profile({ brandSuffix: 'WL\n已通过' }),
    profile({ brandSuffix: '\u202e隐藏文本' }), profile({ buttonLabels: { codeLocation: 'x'.repeat(25) } }),
    profile({ brandSuffix: '已修复' }), profile({ buttonLabels: { reportDetails: '全部问题已解决' } }),
    ...['修复完毕', '所有问题均已整改', '风险为零', '质量全部达标'].map(brandSuffix => profile({ brandSuffix })),
    profile({ buttonLabels: { reportDetails: '业务风险已规避' } }),
  ];
  for (const value of cases) {
    const payload = fixture(), result = applyNotificationPresentation(payload, { profileFile: file(value) });
    assert.equal(result.status, 'invalid-default', JSON.stringify(value)); assert.deepEqual(result.payload, payload);
    assert.match(result.warning, /未应用.*内置样式/u); assert.equal(result.revision, null); assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  }
});

test('仅修改已知元数据字号，关键结论、修复说明与最终@字号不受显示文件控制', () => {
  for (const content of [
    '**提交人**：姓名\n**分支**：sit',
    '**触发人**：姓名\n**分支**：sit',
    '**检查时间**：2026-10-24 10:00:00\n**项目**：2',
    '**项目领域**：生产\n**检查阶段**：CI',
  ]) {
    const payload = fixture(); payload.card.body.elements[1].content = content;
    const result = applyNotificationPresentation(payload, { profileFile: file(profile({ metadataTextSize: 'notation' })) });
    assert.equal(result.payload.card.body.elements[1].text_size, 'notation');
    for (const index of [0, 3, 4, 6]) assert.deepEqual(result.payload.card.body.elements[index], payload.card.body.elements[index]);
  }
  const payload = fixture(); payload.card.body.elements[1].content = '任意段落\n**分支**：sit';
  assert.equal(applyNotificationPresentation(payload, { profileFile: file(profile({ metadataTextSize: 'notation' })) }).payload.card.body.elements[1].text_size, 'normal');
});

test('所有内置按钮只支持各自审核过的中性同义标签，未知按钮与行为URL均不变', () => {
  const payload = fixture(); payload.card.body.elements = [
    { tag: 'markdown', content: '不可替换的内容 查看报告' },
    ...['查看九维检查详情', '直接定位编码问题', '定位失败阶段', '查看本次接入检查与完整缺项', '查看报告', '查看流水线', '查看记录', '登录处理', '自定义授权'].map(content => ({ tag: 'button', text: { tag: 'plain_text', content }, behaviors: [{ type: 'open_url', default_url: 'https://reports.example/' }] })),
  ];
  const names = ['reportDetails', 'codeLocation', 'pipelineStages', 'opsDetails', 'report', 'pipeline', 'record', 'handle'];
  const aliases = ['查看质量详情', '查看代码位置', '查看失败阶段', '查看接入检查与完整缺项', '打开检查报告', '打开流水线', '查看执行记录', '进入处理入口'];
  const buttonLabels = Object.fromEntries(names.map((key, i) => [key, aliases[i]]));
  const result = applyNotificationPresentation(payload, { profileFile: file(profile({ buttonLabels })) });
  assert.equal(result.status, 'applied');
  for (let i = 1; i <= 8; i++) { assert.equal(result.payload.card.body.elements[i].text.content, aliases[i - 1]); assert.deepEqual(result.payload.card.body.elements[i].behaviors, payload.card.body.elements[i].behaviors); }
  assert.deepEqual(result.payload.card.body.elements[0], payload.card.body.elements[0]); assert.deepEqual(result.payload.card.body.elements[9], payload.card.body.elements[9]);
});

test('品牌只接受四个审核选项，自由文本与修复结论同义绕过全部回退', () => {
  for (const brandSuffix of ['', 'WL', 'World Leading', 'WL Quality']) {
    const payload = fixture(), result = applyNotificationPresentation(payload, { profileFile: file(profile({ brandSuffix })) });
    assert.equal(result.status, 'applied', brandSuffix);
    assert.equal(result.payload.card.header.title.content, payload.card.header.title.content + (brandSuffix ? ` · ${brandSuffix}` : ''));
  }
  for (const brandSuffix of ['修复完毕', '所有问题均已整改', '风险为零', '质量全部达标', '业务风险已规避', 'World Leading · 已整改', '自定义品牌', 'wl', 'WL ', null, 0]) {
    const payload = fixture(), result = applyNotificationPresentation(payload, { profileFile: file(profile({ density: 'compact', brandSuffix })) });
    assert.equal(result.status, 'invalid-default', String(brandSuffix)); assert.deepEqual(result.payload, payload);
  }
});

test('按钮各自仅允许内置文字加一个中性别名，断言文本和跨按钮标签不可混用', () => {
  const builtins = { reportDetails: '查看九维检查详情', codeLocation: '直接定位编码问题', pipelineStages: '定位失败阶段', opsDetails: '查看本次接入检查与完整缺项', report: '查看报告', pipeline: '查看流水线', record: '查看记录', handle: '登录处理' };
  for (const [key, value] of Object.entries(builtins)) {
    const payload = fixture(), result = applyNotificationPresentation(payload, { profileFile: file(profile({ buttonLabels: { [key]: value } })) });
    assert.equal(result.status, 'applied'); assert.deepEqual(result.payload, payload);
    for (const unsafe of ['修复完毕', '所有问题均已整改', '风险为零', '质量全部达标', '业务风险已规避', '查看自定义详情', key === 'pipeline' ? builtins.handle : builtins.pipeline]) {
      const rejected = applyNotificationPresentation(payload, { profileFile: file(profile({ buttonLabels: { [key]: unsafe } })) });
      assert.equal(rejected.status, 'invalid-default', `${key}:${unsafe}`); assert.deepEqual(rejected.payload, payload);
    }
  }
});

test('缺失、过大、坏JSON、相对路径、目录及符号链接均不执行也不阻断原通知', () => {
  const valid = file(profile({ density: 'compact' })), dir = path.dirname(valid);
  const malformed = path.join(dir, 'bad.json'); writeFileSync(malformed, '{not valid');
  const oversized = path.join(dir, 'big.json'); writeFileSync(oversized, ' '.repeat(8193));
  const link = path.join(dir, 'link.json'); symlinkSync(valid, link);
  const linkDir = path.join(dir, 'link-dir'); symlinkSync(dir, linkDir);
  const absent=applyNotificationPresentation(fixture(),{profileFile:path.join(dir,'missing')});assert.equal(absent.status,'default');assert.equal(absent.warning,null);
  for (const target of [malformed, oversized, 'display.json', dir, link, path.join(linkDir, 'display.json'), dir + '/../' + path.basename(dir) + '/display.json']) {
    const payload = fixture(), result = applyNotificationPresentation(payload, { profileFile: target });
    assert.equal(result.status, 'invalid-default', target); assert.deepEqual(result.payload, payload); assert.ok(result.warning);
  }
  writeFileSync(malformed, 'credential-should-not-appear-in-error');
  const hidden = applyNotificationPresentation(fixture(), { profileFile: malformed });
  assert.match(hidden.warning, /JSON语法无效/u); assert.doesNotMatch(hidden.warning, /credential-should-not-appear/u);
});

test('一次无效更新后恢复正确文件，下张卡自动恢复显示配置，未遗留失败缓存', () => {
  const payload = fixture(), target = file(profile({ density: 'compact' }));
  assert.equal(applyNotificationPresentation(payload, { profileFile: target }).status, 'applied');
  writeFileSync(target, '{ broken'); assert.equal(applyNotificationPresentation(payload, { profileFile: target }).status, 'invalid-default');
  writeFileSync(target, '\uFEFF' + JSON.stringify(profile({ revision: 'display-3', metadataTextSize: 'normal' })));
  const result = applyNotificationPresentation(payload, { profileFile: target }); assert.equal(result.status, 'applied'); assert.equal(result.revision, 'display-3');
});

test('长标题或超限卡片回退完整原件，品牌后缀重复应用不追加多次', () => {
  const target = file(profile({ brandSuffix: 'World Leading' })), payload = fixture();
  const once = applyNotificationPresentation(payload, { profileFile: target });
  const twice = applyNotificationPresentation(once.payload, { profileFile: target });
  assert.deepEqual(twice.payload, once.payload);
  for (const mutate of [p => p.card.header.title.content = '长'.repeat(160), p => p.card.body.elements.push({ tag: 'markdown', content: '长'.repeat(7000) })]) {
    const large = fixture(); mutate(large); const result = applyNotificationPresentation(large, { profileFile: target });
    assert.equal(result.status, 'invalid-default'); assert.deepEqual(result.payload, large);
  }
});

test('随包配置可以直接验证，读取不会改变文件及修订摘要', () => {
  const target = fileURLToPath(new URL('../../templates/platform/notification-presentation.json', import.meta.url)), before = readFileSync(target);
  const result = applyNotificationPresentation(fixture(), { profileFile: target });
  assert.equal(result.status, 'applied'); assert.equal(result.revision, 'display-1'); assert.equal(result.sha256, hash(before)); assert.deepEqual(readFileSync(target), before);
});

process.on('exit', () => rmSync(base, { recursive: true, force: true }));
