// Central, data-only display preferences. This is deliberately independent of
// rule/quality identity: it cannot supply markup, links, facts or recipients.
import path from 'node:path';
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const LIMIT = 8192;
const BUTTONS = {
  reportDetails: '查看九维检查详情', codeLocation: '直接定位编码问题',
  pipelineStages: '定位失败阶段', opsDetails: '查看本次接入检查与完整缺项',
  report: '查看报告', pipeline: '查看流水线', record: '查看记录', handle: '登录处理',
};
// Exact, reviewed text choices keep display preferences from introducing
// unsupported quality claims through synonyms or misleading link labels.
const BRAND_SUFFIXES = ['', 'WL', 'World Leading', 'WL Quality'];
const BUTTON_ALIASES = {
  reportDetails: '查看质量详情', codeLocation: '查看代码位置',
  pipelineStages: '查看失败阶段', opsDetails: '查看接入检查与完整缺项',
  report: '打开检查报告', pipeline: '打开流水线', record: '查看执行记录', handle: '进入处理入口',
};
const own = (v, k) => Object.hasOwn(v, k);
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const keys = (v, allowed) => record(v) && Object.keys(v).every(k => allowed.includes(k));


function validate(profile) {
  assert(keys(profile, ['schemaVersion', 'kind', 'revision', 'density', 'metadataTextSize', 'brandSuffix', 'buttonLabels']), '存在未知字段或不是普通JSON对象');
  assert(profile.schemaVersion === 1 && profile.kind === 'wl-notification-presentation', '配置类型或版本不受支持');
  assert(typeof profile.revision === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile.revision), 'revision须为1–64位版本标识');
  if (own(profile, 'density')) assert(['compact', 'comfortable'].includes(profile.density), 'density仅支持compact或comfortable');
  if (own(profile, 'metadataTextSize')) assert(['normal', 'notation'].includes(profile.metadataTextSize), 'metadataTextSize仅支持normal或notation');
  if (own(profile, 'brandSuffix')) assert(BRAND_SUFFIXES.includes(profile.brandSuffix), '品牌后缀仅支持已审核选项：空、WL、World Leading、WL Quality');
  if (own(profile, 'buttonLabels')) {
    assert(keys(profile.buttonLabels, Object.keys(BUTTONS)), '按钮键不在内置白名单');
    for (const [key, value] of Object.entries(profile.buttonLabels)) assert(value === BUTTONS[key] || value === BUTTON_ALIASES[key], '按钮文字须选择该按钮的已审核中性标签');
  }
  return profile;
}

function checkedPath(file) {
  assert(typeof file === 'string' && path.isAbsolute(file) && !/[\u0000-\u001f]/u.test(file), '配置须为受控绝对路径');
  assert(!file.split(path.sep).some(part => ['.', '..'].includes(part)), '配置路径不能包含相对跳转');
  const absolute = path.resolve(file), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    assert(!stat.isSymbolicLink(), '配置路径不接受符号链接');
    assert(current === absolute ? stat.isFile() : stat.isDirectory(), '配置路径类型不符');
  }
  return absolute;
}

function readProfile(file) {
  file = checkedPath(file);
  const before = lstatSync(file);
  assert(before.size <= LIMIT, '配置超过8KiB限制');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.size <= LIMIT && stat.dev === before.dev && stat.ino === before.ino, '读取期间配置发生变化');
    const bytes = readFileSync(fd);
    const after = lstatSync(checkedPath(file));
    assert(bytes.length <= LIMIT && after.dev === stat.dev && after.ino === stat.ino && after.size === stat.size
      && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs, '读取期间配置发生变化');
    return bytes;
  } finally { closeSync(fd); }
}

// Metadata stays readable and contains exactly the same text. This intentionally
// excludes the separate final responsibility reminder and risk/repair blocks.
function metadata(element) {
  return element?.tag === 'markdown' && typeof element.content === 'string'
    && /^(?:\*\*(?:提交人|触发人|检查时间|项目领域)\*\*：)/u.test(element.content)
    && /\n\*\*(?:分支|项目|检查阶段)\*\*：/u.test(element.content);
}

function visitButtons(value, labels) {
  if (!record(value)) return;
  if (value.tag === 'button' && value.text?.tag === 'plain_text') {
    const entry = Object.entries(BUTTONS).find(([, builtin]) => value.text.content === builtin);
    if (entry && own(labels, entry[0])) value.text.content = labels[entry[0]];
  }
  // Only descend the card's standard layout containers. Arbitrary nested data
  // (behaviors/URLs, risk facts, content) is never interpreted as configuration.
  for (const key of ['elements', 'columns']) if (Array.isArray(value[key])) for (const child of value[key]) visitButtons(child, labels);
}

/** Re-read the stable profile on every card. No execution, fetch or state write. */
export function applyNotificationPresentation(payload, { profileFile } = {}) {
  const original = structuredClone(payload);
  if (!profileFile || payload?.msg_type !== 'interactive' || payload?.card?.schema !== '2.0') {
    return { payload: original, status: 'default', revision: null, sha256: null, warning: null };
  }
  let sha256 = null;
  try {
    const bytes = readProfile(profileFile);
    sha256 = createHash('sha256').update(bytes).digest('hex');
    const profile = validate(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')));
    const result = structuredClone(payload), { body, header } = result.card;
    assert(record(body) && Array.isArray(body.elements) && header?.title?.tag === 'plain_text' && typeof header.title.content === 'string', '卡片不是受支持的内置结构');
    if (profile.density === 'compact') { body.padding = '8px 12px 10px 12px'; body.vertical_spacing = '4px'; }
    if (profile.density === 'comfortable') { body.padding = '12px 16px 14px 16px'; body.vertical_spacing = '8px'; }
    if (profile.metadataTextSize) for (const element of body.elements) if (metadata(element)) element.text_size = profile.metadataTextSize;
    if (profile.brandSuffix) {
      const suffix = ` · ${profile.brandSuffix}`;
      if (!header.title.content.endsWith(suffix)) header.title.content += suffix;
      assert([...header.title.content].length <= 160, '追加品牌后标题超过160字');
    }
    if (profile.buttonLabels) visitButtons(body, profile.buttonLabels);
    assert(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 20000, '显示配置导致卡片超过飞书大小限制');
    return { payload: result, status: 'applied', revision: profile.revision, sha256, warning: null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { payload: original, status: 'default', revision: null, sha256: null, warning: null };
    // A broken preference must not silence quality alerts or erase their @s.
    const reason = error instanceof SyntaxError ? 'JSON语法无效' : error?.code || error?.message || '读取失败';
    return { payload: original, status: 'invalid-default', revision: null, sha256,
      warning: `通知显示配置未应用，已使用内置样式：${reason}` };
  }
}
