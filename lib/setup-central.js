import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createHash, createPublicKey } from 'node:crypto';
import { controlledPath, readControlledJson } from './control-store.js';
import { loadGovernanceConfig, readGovernanceState } from './governance.js';
import { loadControlConfig, serveControl } from './control-service.js';
import { loadAutomationConfig, automationTick, startAutomation } from './automation.js';
import { loadReviewPublishConfig } from './review-publish.js';
import { loadReviewCollectorConfig } from './review-collect.js';
import { loadCiSourceConfig } from './ci-source.js';
import { loadDeploymentConfig } from './deployment.js';
import { validateReviewPolicy } from './review.js';
import { stableStringify } from './util.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const assert = (value, message) => { if (!value) throw new Error(message); };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const inRoot = (root, file) => { const rel = path.relative(root, file); return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const publicDigest = (file) => digest(createPublicKey(readFileSync(controlledPath(file))).export({ type: 'spki', format: 'der' }));
const placeholder = /REPLACE(?:_|\b)|CHANGE[_ -]?ME|<[^>]+>|\$\{[^}]+\}|example\.(?:internal|com|org|net)\b/i;

/** Read-only central preflight. This never installs services, writes a ledger,
 * generates credentials, queries a provider, signs a Review, or sends a message. */
export function planCentralSetup(options = {}) {
  const env = options.env ?? process.env, steps = [], pins = new Map(), envChecks = new Map(), configs = {};
  let automationInput;
  const base = path.resolve(options.configDir || process.cwd());
  const files = Object.fromEntries([
    ['governanceConfigFile', 'governance-config.json'], ['controlConfigFile', 'control-config.json'],
    ['automationConfigFile', 'automation-config.json'], ['reviewPublishConfigFile', 'review-publish-config.json'],
  ].map(([key, fallback]) => [key, options[key] === null ? null : path.resolve(base, options[key] || fallback)]));
  const send = options.send === true, watch = options.watch === true, port = options.port ?? 8787;
  const secretValues = new Set();
  const clean = (message) => {
    let text = String(message).replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, '[credential omitted]');
    for (const value of secretValues) if (value.length > 3) text = text.split(value).join('[credential omitted]');
    return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[credential omitted]@').slice(0, 1600);
  };
  const step = (id, title, owner, action, check) => {
    try { const detail = check(); steps.push({ id, title, owner, status: 'passed', detail: clean(detail || '本机静态检查通过') }); return true; }
    catch (error) { steps.push({ id, title, owner, status: 'blocked', detail: clean(error.message), nextAction: action }); return false; }
  };
  const note = (id, title, detail, nextAction, owner = '米传汇智 / 运维') => steps.push({ id, title, owner, status: 'unverified', detail, nextAction });
  const pin = (file, role = 'config', { optional = false, directory = false } = {}) => {
    file = controlledPath(file);
    if (!existsSync(file)) {
      pins.set(file, { file, role, status: 'missing' });
      assert(optional, directory ? '批准目录不存在，先由运维创建受控目录' : '所需配置、密钥或执行文件不存在');
      return file;
    }
    const stat = lstatSync(file);
    assert(directory ? stat.isDirectory() : stat.isFile(), directory ? '受控路径不是目录' : '受控路径不是普通文件');
    if (!directory) { accessSync(file, constants.R_OK); pins.set(file, { file, role, status: 'present', sha256: digest(readFileSync(file)) }); }
    else pins.set(file, { file, role, status: 'directory' });
    return file;
  };
  const writable = (file, directory = false, required = false) => {
    file = pin(file, directory ? 'directory' : 'state', { optional: !required, directory });
    let parent = existsSync(file) ? (directory ? file : path.dirname(file)) : path.dirname(file);
    while (!existsSync(parent)) parent = path.dirname(parent);
    controlledPath(parent); assert(lstatSync(parent).isDirectory(), '数据路径祖先不是目录'); accessSync(parent, constants.W_OK | constants.X_OK);
    if (existsSync(file) && !directory) accessSync(file, constants.W_OK);
    return file;
  };
  const json = (file) => {
    pin(file); const value = readControlledJson(file);
    assert(!placeholder.test(JSON.stringify(value)), '仍含 REPLACE、示例域名或模板占位符；请填入已批准配置');
    return value;
  };
  const credential = (name, owner, required = true, kind = 'secret') => {
    if (!name) return;
    assert(/^[A-Z][A-Z0-9_]+$/.test(name), '凭据变量名无效');
    const present = typeof env[name] === 'string' && !!env[name] && !/[\r\n\0]/.test(env[name]) && !placeholder.test(env[name]);
    if (present) secretValues.add(env[name]);
    envChecks.set(name, { name, owner, present, required, kind });
    assert(present || !required, `缺少有效环境变量 ${name}；由${owner}注入，报告不记录其值`);
  };
  const collector = (file) => {
    json(file); const c = loadReviewCollectorConfig(file); json(c.ciConfigFile); const ci = loadCiSourceConfig(c.ciConfigFile);
    assert(ci.project === c.project && ci.qualitySummary && ci.artifacts.paths.includes(ci.qualitySummary), 'Review采集项目或原始Gate工件绑定不一致');
    assert(c.evidence.every((e) => ci.artifacts.paths.includes(e.path)), 'Review证据路径没有全部登记为可信CI工件');
    if (c.supplement) { json(c.supplement.governanceConfigFile); pin(c.supplement.authorizationPublicKeyFile, 'public-key'); }
    return c;
  };

  step('runtime', '固定 Gate 与 Node', '米传汇智 / 运维', '使用受控发布目录内的固定 Gate 版本与 Node >= 22.12.0，再重新预检。', () => {
    const pkg = readControlledJson(pin(path.join(packageRoot, 'package.json'), 'runtime'));
    const [major, minor, patch] = process.versions.node.split('.').map(Number);
    assert(major > 22 || major === 22 && (minor > 12 || minor === 12 && patch >= 0), 'Node 需要 >= 22.12.0');
    assert(!options.expectedGateVersion || options.expectedGateVersion === pkg.version, `Gate 固定版本不匹配，当前 ${pkg.version}`);
    for (const name of readdirSync(path.join(packageRoot, 'lib')).filter((name) => name.endsWith('.js')).sort()) pin(path.join(packageRoot, 'lib', name), 'runtime');
    pin(path.join(packageRoot, 'bin/wl-skills-gate.js'), 'runtime');
    configs.runtime = { node: process.versions.node, gate: pkg.version, nodeProgram: process.execPath };
    pin(process.execPath, 'runtime-program');
    return `Gate ${pkg.version} / Node ${process.versions.node}；配置与执行代码已计算固定摘要`;
  });
  step('options', '启动与发送边界', '米传汇智 / 运维', '仅使用布尔 start/watch/send；发送须显式 send=true，端口须为 1–65535。', () => {
    for (const key of ['start', 'watch', 'send']) assert(options[key] === undefined || typeof options[key] === 'boolean', `${key} 必须是明确布尔值`);
    assert(Number.isSafeInteger(port) && port > 0 && port <= 65535, '回环监听端口无效');
    assert(!options.host || options.host === '127.0.0.1', '操作入口只允许回环监听，由现有HTTPS反向代理接入');
    return `默认只预检；计划${watch ? '持续调度' : '单次调度'}，${send ? '已显式选择发送' : '消息只预览'}；127.0.0.1:${port}`;
  });
  step('governance', '治理登记与真实配置', '技术经理 / 米传汇智', '补齐真实项目、九维批准摘要、责任人员、渠道与固定来源；不要直接运行模板。', () => {
    assert(files.governanceConfigFile, '必须提供治理配置'); json(files.governanceConfigFile);
    const g = configs.governance = loadGovernanceConfig(files.governanceConfigFile); pin(g.publicKeyFile, 'public-key');
    assert(createPublicKey(readFileSync(g.publicKeyFile)).asymmetricKeyType === 'ed25519', '治理公钥需要 Ed25519');
    return `${Object.keys(g.projects).length} 个已接项目，${Object.keys(g.channels).length} 个消息渠道；公钥可读取`;
  });
  step('control', '认证操作与 Review 入口', '米传汇智 / 运维', '修正操作服务、SSO、公钥分离、人员与Review采集映射，并创建批准证据目录。', () => {
    assert(files.controlConfigFile, '必须提供操作服务配置'); const raw = json(files.controlConfigFile);
    if (raw.identity?.clientSecretEnv) credential(raw.identity.clientSecretEnv, 'SSO 运维');
    const c = configs.control = loadControlConfig(files.controlConfigFile);
    assert(c.governanceConfigFile === files.governanceConfigFile, '操作服务未引用同一治理配置');
    for (const file of [c.receiptPrivateKeyFile, c.authorizationPrivateKeyFile]) pin(file, 'private-key');
    pin(c.identity.publicKeyFile, 'public-key'); writable(c.stateFile); writable(c.dataDir, true);
    for (const spec of Object.values(c.reviewPolicies)) { collector(spec.collectorConfigFile); writable(spec.evidenceRoot, true, true); }
    return '认证、事件与授权密钥已分离；批准采集器、证据根与状态路径已检查；SSO真实登录另验';
  });
  step('automation', '自动采集与项目接线', '米传汇智 / 运维', '逐一修正固定CI来源、员工映射、Review接线与批准策略；不要删除旧账重试。', () => {
    assert(files.automationConfigFile, '必须提供自动执行器配置'); automationInput = json(files.automationConfigFile);
    const a = configs.automation = loadAutomationConfig(files.automationConfigFile), c = configs.control, g = configs.governance;
    assert(c && g, '先修复治理与认证操作配置');
    assert(a.governanceConfigFile === files.governanceConfigFile && a.stateFile === c.stateFile && a.receiptPrivateKeyFile === c.receiptPrivateKeyFile, '自动执行器与操作服务的治理配置、台账或事件密钥路径不一致');
    assert(!inRoot(a.dataDir, c.dataDir) && !inRoot(c.dataDir, a.dataDir), '操作服务与调度器数据目录须分开，不能重叠');
    pin(a.receiptPrivateKeyFile, 'private-key'); writable(a.dataDir, true);
    const known = new Set(Object.values(c.identity.subjects));
    for (const source of a.sources) {
      json(source.configFile); const ci = loadCiSourceConfig(source.configFile);
      credential(ci.tokenEnv, 'GitLab / Jenkins 运维'); if (ci.userEnv) credential(ci.userEnv, 'Jenkins 运维', true, 'username');
      assert(Object.values(source.actors).every((actor) => known.has(actor)), 'CI用户未完整映射到SSO已认证人员');
      assert(source.review, `来源 ${source.id} 尚未绑定自动 Review，不能把扫描当成完整九维审阅`);
      const raw = json(source.review.configFile), reviewBase = path.dirname(source.review.configFile);
      assert(raw.schemaVersion === 1, 'Review CI接线配置版本无效');
      for (const key of ['collectorConfigFile', 'controlConfigFile', 'reviewPolicyFile']) {
        assert(typeof raw[key] === 'string' && raw[key], `Review CI缺少固定配置 ${key}`); raw[key] = controlledPath(path.resolve(reviewBase, raw[key]));
      }
      assert(raw.controlConfigFile === files.controlConfigFile, 'Review CI未指向同一操作服务');
      const rc = collector(raw.collectorConfigFile), approved = c.reviewPolicies[ci.project];
      assert(approved && rc.project === ci.project && rc.ciConfigFile === source.configFile && approved.collectorConfigFile === raw.collectorConfigFile && approved.policyHash === rc.reviewPolicyHash, 'Review CI、采集器、来源与操作服务批准项目/策略不一致');
      assert(Object.values(source.actors).every((actor) => rc.allowedAuthorIds.includes(actor)), 'CI来源作者未全部登记为该项目Review允许作者');
      const policy = validateReviewPolicy(json(raw.reviewPolicyFile), ci.project);
      assert(digest(stableStringify(policy)) === rc.reviewPolicyHash, 'Review九维策略摘要与批准值不一致');
      assert(inRoot(approved.evidenceRoot, source.review.outRoot), '自动Review输出目录不在批准证据根内');
      writable(source.review.outRoot, true);
      if (raw.candidateContextPath !== undefined) assert(ci.artifacts.paths.includes(raw.candidateContextPath) && raw.sourceBranch && raw.targetBranch, '候选上下文须来自登记工件并固定源/目标分支');
      if (source.review.publication) {
        const p = source.review.publication;
        for (const file of [p.publicKeyFile, p.authorizationPublicKeyFile]) pin(file, 'public-key');
        assert(p.expectAuthorizationIssuer === c.authorizationIssuer && p.expectReviewPolicyHash === approved.policyHash && p.evidenceRoot === approved.evidenceRoot, '正式Review订阅未绑定当前授权者、策略或证据根');
        assert(publicDigest(p.authorizationPublicKeyFile) === publicDigest(c.authorizationPrivateKeyFile), '正式Review订阅授权公钥与操作服务不一致');
        writable(p.manifestDir, true);
      } else throw new Error(`来源 ${source.id} 尚未绑定确认后的正式Review回流订阅`);
    }
    for (const project of Object.keys(c.reviewPolicies)) assert(a.sources.some((s) => s.config.project === project), `Review已登记项目 ${project} 没有自动采集来源`);
    return `${a.sources.length} 个固定CI来源已绑定员工、九维Review、批准证据根与正式报告回流；尚未访问CI`;
  });
  // Report every registered source even when the aggregate loader rejects an
  // earlier source; operators should fix one concise checklist in one pass.
  for (const [index, source] of (Array.isArray(automationInput?.sources) ? automationInput.sources : []).entries()) {
    const name = /^[A-Za-z0-9_.:-]{1,128}$/.test(source?.id || '') ? source.id : String(index + 1);
    step(`source:${name}`, `CI 来源 ${name} 的配置与凭据`, '米传汇智 / 项目技术经理', '补齐该来源的真实配置、CI只读变量和Review采集工件；再一起复跑预检。', () => {
      assert(typeof source.configFile === 'string' && source.configFile, 'CI来源缺少固定配置文件');
      const ciFile = controlledPath(path.resolve(path.dirname(files.automationConfigFile), source.configFile)); json(ciFile); const ci = loadCiSourceConfig(ciFile);
      const missing = [];
      for (const [variable, owner, kind] of [[ci.tokenEnv, 'GitLab / Jenkins 运维', 'secret'], [ci.userEnv, 'Jenkins 运维', 'username']].filter(([variable]) => variable)) {
        try { credential(variable, owner, true, kind); } catch (error) { missing.push(error.message); }
      }
      assert(!missing.length, missing.join('；'));
      if (ci.userEnv) assert(!env[ci.userEnv].includes(':'), 'Jenkins只读用户名不能含冒号');
      assert(source.review?.configFile, '该来源缺少自动Review接线');
      const reviewFile = controlledPath(path.resolve(path.dirname(files.automationConfigFile), source.review.configFile)), review = json(reviewFile);
      assert(review.collectorConfigFile && review.reviewPolicyFile && review.controlConfigFile, 'Review接线必须固定采集器、九维策略和操作服务');
      const rc = collector(controlledPath(path.resolve(path.dirname(reviewFile), review.collectorConfigFile)));
      assert(rc.ciConfigFile === ciFile && rc.project === ci.project, 'Review采集器与此CI来源项目或路径不一致');
      const policy = validateReviewPolicy(json(path.resolve(path.dirname(reviewFile), review.reviewPolicyFile)), ci.project);
      assert(digest(stableStringify(policy)) === rc.reviewPolicyHash, '该来源九维策略摘要与采集器不一致');
      return `${ci.project} / ${ci.scope}：来源、凭据存在性与Review原始工件静态检查通过；完整绑定见自动采集步骤`;
    });
  }
  step('publisher', '独立 Review 签发接线', '独立 Review 签发运维', '在独立签发环境预检实际配置；本入口不会代替独立签发服务或自动授权。', () => {
    if (files.reviewPublishConfigFile === null) {
      note('publisher-external', '独立签发环境待验收', '此执行环境明确不加载独立Review私钥；尚未验证独立签发配置。', '由独立签发运维在受控环境完成预检与一次授权后签发回流验收。', '独立 Review 签发运维');
      return '已声明独立签发分开运行；本进程不接触其私钥';
    }
    const raw = json(files.reviewPublishConfigFile);
    if (raw.reviewPrivateKeyEnv) credential(raw.reviewPrivateKeyEnv, '独立 Review 签发运维', true, 'private-key-file');
    const p = configs.publisher = loadReviewPublishConfig(files.reviewPublishConfigFile, env), c = configs.control, a = configs.automation;
    assert(c && a, '先修复认证操作与自动执行器');
    pin(p.privateKeyFile, 'private-key'); pin(p.reviewPublicKeyFile, 'public-key'); pin(p.authorizationPublicKeyFile, 'public-key');
    assert(p.authorizationIssuer === c.authorizationIssuer && publicDigest(p.authorizationPublicKeyFile) === publicDigest(c.authorizationPrivateKeyFile), '独立签发授权者或公钥与操作服务不一致');
    assert(p.controlCatalogFile === path.join(c.dataDir, 'reviews.json') && p.authorizationDir === path.join(c.dataDir, 'authorizations'), '独立签发未订阅同一Review目录或授权目录');
    writable(p.stateFile); writable(p.manifestDir, true); writable(p.authorizationDir, true);
    if (existsSync(p.controlCatalogFile)) { const catalog = readControlledJson(pin(p.controlCatalogFile, 'catalog')); assert(catalog.schemaVersion === 1 && object(catalog.reviews), 'Review目录损坏，禁止清空或重建'); }
    for (const [project, spec] of Object.entries(c.reviewPolicies)) {
      const pp = p.projects[project];
      assert(pp && pp.collectorConfigFile === spec.collectorConfigFile && pp.reviewPolicyHash === spec.policyHash && pp.evidenceRoots.includes(spec.evidenceRoot), '独立签发项目、策略、采集器或证据根与操作服务不一致');
      collector(pp.collectorConfigFile); json(pp.reviewPolicyFile);
      assert(pp.reviewers.every((r) => c.governance.projects[project].reviewers.includes(r) && Object.values(c.identity.subjects).includes(r)), '独立签发复核人未绑定治理批准的SSO人员');
      for (const source of a.sources.filter((s) => s.config.project === project)) {
        const pub = source.review.publication, scope = c.governance.projects[project].scopes[source.config.scope];
        assert(pub.manifestDir === p.manifestDir && publicDigest(pub.publicKeyFile) === publicDigest(p.reviewPublicKeyFile), '正式Review回流目录或签名公钥与独立签发不一致');
        assert((pub.profile || 'standard') === pp.profile && (pp.profile !== 'release' || pub.env === pp.env), '正式Review回流档位或发布环境与独立签发不一致');
        for (const key of ['policyHash', 'rulesHash', 'baselineHash', 'waiversHash']) assert(pp[key] === scope[key], '独立签发Gate批准摘要与当前治理范围不一致');
      }
      for (const root of pp.evidenceRoots) writable(root, true, true);
    }
    return '独立签发密钥、授权订阅、项目摘要与报告回流静态绑定一致；本入口不启动签发或代替人工确认';
  });
  step('states', '旧账与执行状态保护', '米传汇智 / 运维', '恢复配套状态；配置变化先走已有受审计迁移流程，禁止删除台账、checkpoint或锁。', () => {
    const a = configs.automation, c = configs.control, p = configs.publisher; assert(a && c, '先修复中央配置');
    pin(c.stateFile, 'state', { optional: true }); readGovernanceState({ configFile: files.governanceConfigFile, stateFile: c.stateFile });
    const stateFile = path.join(a.dataDir, 'automation-state.json'); pin(stateFile, 'state', { optional: true });
    if (existsSync(stateFile)) {
      const state = readControlledJson(stateFile), binding = digest(stableStringify({ ...a, governance: a.governance }));
      assert(state.schemaVersion === 1 && state.binding === binding && object(state.runs) && Array.isArray(state.history) && object(state.health), '自动执行器配置身份变化或状态损坏，不能静默重置');
      assert(existsSync(c.stateFile), '已有调度checkpoint但治理台账缺失，不能把丢失旧账当首次安装');
    }
    if (p && existsSync(p.stateFile)) {
      const state = readControlledJson(pin(p.stateFile, 'state'));
      assert(state.schemaVersion === 1 && state.kind === 'review-publication-state' && state.configHash === p.binding && object(state.authorizations) && object(state.failures), 'Review签发checkpoint配置/状态损坏，不能静默重置');
    }
    const statePaths = [c.stateFile, stateFile, p?.stateFile].filter(Boolean);
    for (const source of a.sources) if (source.review?.publication) {
      const settings = source.review.publication, ci = loadCiSourceConfig(source.configFile), scope = c.governance.projects[ci.project]?.scopes[ci.scope];
      const file = path.join(a.dataDir, 'formal-reviews', source.id, 'publication-state.json'); statePaths.push(file); pin(file, 'state', { optional: true });
      if (existsSync(file)) {
        const state = readControlledJson(file), binding = digest(stableStringify({ ci, settings, scope, reviewKey: digest(readFileSync(settings.publicKeyFile)), authorizationKey: digest(readFileSync(settings.authorizationPublicKeyFile)) }));
        assert(state.schemaVersion === 1 && state.binding === binding && object(state.records) && (state.canonical === undefined || object(state.canonical)), '正式Review回流checkpoint身份或状态损坏，禁止重置');
        assert(existsSync(c.stateFile), '正式Review回流checkpoint存在但治理台账缺失，须恢复配套旧账');
      }
    }
    if (a.deployments) {
      const file = path.join(a.dataDir, 'deployments', 'deployment-delivery-state.json'); statePaths.push(file); pin(file, 'state', { optional: true });
      if (existsSync(file)) {
        const state = readControlledJson(file), binding = digest(stableStringify({ governanceConfigFile: a.governanceConfigFile, stateFile: a.stateFile,
          publicKey: createPublicKey(readFileSync(a.receiptPrivateKeyFile)).export({ type: 'spki', format: 'pem' }), configs: a.deployments.configs }));
        assert(state.schemaVersion === 1 && state.binding === binding && object(state.deliveries) && object(state.streams), '部署交付checkpoint身份或状态损坏，禁止重置');
        assert(existsSync(c.stateFile), '部署交付checkpoint存在但治理台账缺失，须恢复配套旧账');
      }
    }
    assert(new Set(statePaths).size === statePaths.length, '中央台账、调度与独立签发状态路径不能共用');
    for (const file of statePaths) assert(!existsSync(file + '.lock'), '存在中央执行器锁；先核对现有执行器，本预检不删除或恢复锁');
    return '旧台账与checkpoint身份检查通过；缺少首次状态仅标记待初始化，不写空账、不删锁';
  });
  step('deployments', '部署与环境复验回流', '米传汇智 / 发布运维', '补齐批准部署通道、真实脚本/程序摘要、独立验证人与回流配置；部署凭据仅留在受控部署作业。', () => {
    const c = configs.control, a = configs.automation; assert(c && a, '先修复中央配置');
    const entries = Object.entries(c.deploymentConfigs);
    const required = Object.entries(c.governance.projects).flatMap(([project, p]) => Object.values(p.scopes).filter((s) => s.closurePolicy).map((s) => ({ ...s.closurePolicy, project })));
    if (required.length) assert(entries.length && a.deployments, '治理要求部署复验，但中央操作或自动回流未配置部署通道');
    const lanes = [];
    for (const [id, file] of entries) {
      json(file); const d = loadDeploymentConfig(file); lanes.push(d);
      assert(d.ci, '自动部署回流必须登记固定Jenkins作业，不能采信孤立执行记录');
      pin(d.authorizationPublicKeyFile, 'public-key'); pin(d.releasePublicKeyFile, 'public-key'); writable(d.stateFile);
      assert(d.authorizationIssuer === c.authorizationIssuer && publicDigest(d.authorizationPublicKeyFile) === publicDigest(c.authorizationPrivateKeyFile), '部署授权公钥或签发者与操作服务不一致');
      const subscription = a.deployments?.configs[id]; assert(subscription && subscription.configFile === file, '部署通道未登记到同一自动回流配置');
      pin(subscription.executorPublicKeyFile, 'public-key'); writable(subscription.executionRoot, true);
      assert(createPublicKey(readFileSync(subscription.executorPublicKeyFile)).asymmetricKeyType === 'ed25519', '部署执行回流公钥必须为 Ed25519');
      assert(d.projects.every((project) => Object.hasOwn(c.governance.projects, project)), '部署组件项目未在治理登记');
      const known = Object.values(c.identity.subjects); assert([...d.operators, ...d.verifiers].every((actor) => known.includes(actor)), '部署操作或独立验证人未映射SSO');
      for (const command of Object.values(d.commands)) {
        const program = pin(command.program, 'deployment-program'), script = pin(path.resolve(d.commandsRoot, command.script), 'deployment-script');
        assert(inRoot(d.commandsRoot, script) && digest(readFileSync(program)) === command.programHash && digest(readFileSync(script)) === command.scriptHash, '部署执行程序或脚本摘要变化');
        accessSync(program, constants.X_OK);
        for (const spec of command.configFiles) { const file = pin(path.resolve(d.commandsRoot, spec.path), 'deployment-config'); assert(inRoot(d.commandsRoot, file) && digest(readFileSync(file)) === spec.sha256, '部署脚本关联配置越界或摘要变化'); }
      }
      if (existsSync(d.stateFile)) {
        const state = readControlledJson(d.stateFile);
        assert(state.schemaVersion === 1 && state.kind === 'deployment-state' && state.issuer === d.issuer && state.environment === d.environment && state.lane === d.lane && Number.isSafeInteger(state.revision) && state.revision >= 0 && Array.isArray(state.consumedAuthorizations), '部署状态损坏或与批准通道不符，禁止重置');
      }
      assert(!existsSync(d.stateFile + '.lock'), '部署状态存在锁，先核对受控作业；本入口不删除锁');
    }
    for (const cp of required) for (const environment of cp.requiredEnvironments) assert(lanes.some((d) => d.projects.includes(cp.project) && d.lane === cp.deploymentLane && d.environment === environment), '必要项目、环境或部署通道没有完整接线');
    if (a.deployments) writable(a.deployments.deliveryDir, true);
    return entries.length ? `${entries.length} 个部署通道与受控脚本、人员、回流映射检查通过；未执行部署或冒烟` : '当前治理未要求部署复验，未登记部署通道';
  });
  step('notifications', '分类消息与凭据注入', '杨晨誉 / 米传汇智', '按已登记渠道注入 Webhook 与飞书签名密钥；真实到群须单独显式选择发送并核对。', () => {
    const g = configs.governance; assert(g, '先修复治理配置');
    const errors = [];
    for (const channel of Object.values(g.channels)) {
      for (const variable of [channel.webhookEnv, channel.signingSecretEnv].filter(Boolean)) {
        try { credential(variable, '杨晨誉 / 消息运维', send); } catch (error) { errors.push(error.message); }
      }
      if (env[channel.webhookEnv]) try {
        const u = new URL(env[channel.webhookEnv]);
        assert(u.protocol === 'https:' && !u.port && !u.username && !u.password && !u.hash && (channel.type === 'feishu' ? u.hostname === 'open.feishu.cn' && /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+$/.test(u.pathname) && !u.search : u.hostname === 'qyapi.weixin.qq.com' && u.pathname === '/cgi-bin/webhook/send' && /^[A-Za-z0-9_-]+$/.test(u.searchParams.get('key') || '') && [...u.searchParams.keys()].length === 1), '消息Webhook不符合既有发送器允许来源');
      } catch { errors.push(`${channel.webhookEnv} 不符合既有发送器允许来源`); }
    }
    assert(!errors.length, errors.join('；'));
    return send ? '已检查显式发送所需环境变量；尚未发送、尚未证实到群' : '默认不发送消息；缺少消息凭据不影响只读预检，报告仅列变量名';
  });
  note('external-acceptance', '现场验收仍待执行', '本次仅验证本机文件、摘要、密钥绑定与接线。未验证 GitLab/Jenkins API、SSO登录、HTTPS代理、真实到群、九维人工复核结论或部署效果。', '按报告完成一次真实提交→构建→待确认Review→独立授权签发→消息到群；必要环境再做部署和独立复验。');

  const filePins = [...pins.values()].sort((a, b) => a.file.localeCompare(b.file));
  const environment = [...envChecks.values()].sort((a, b) => a.name.localeCompare(b.name));
  const blocked = steps.filter((s) => s.status === 'blocked');
  const plan = { schemaVersion: 1, kind: 'central-setup-plan', status: blocked.length ? 'blocked' : 'ready', mode: 'read-only',
    configFiles: files, runtime: configs.runtime || null, options: { watch, send, port, host: '127.0.0.1' },
    steps, environment, filePins, automaticallyStarted: false, messagesSent: false, networkExecuted: false,
    nextActions: steps.filter((s) => s.nextAction).map(({ id, owner, nextAction }) => ({ step: id, owner, action: nextAction })),
    limitations: ['静态通过只表示接线具备执行条件，不能替代现场端到端验收。', '本入口不安装或改写 systemd、Jenkins、GitLab、SSO、密钥或特权配置。', '独立Review签发服务保持独立；本入口只启动操作入口与中央采集。'],
  };
  plan.planHash = digest(stableStringify({ ...plan }));
  return plan;
}

/** Run only after an explicit start and confirmation of an unchanged plan.
 * Runtime injection exists to test cancellation and fail-before-start behavior. */
export async function runCentralSetup(options = {}, runtime = {}) {
  const plan = planCentralSetup(options);
  if (plan.status === 'blocked' || options.start !== true) return plan;
  if (!/^[a-f0-9]{64}$/.test(options.expectPlanHash || '') || options.expectPlanHash !== plan.planHash) return { ...plan, status: 'blocked',
    steps: [...plan.steps, { id: 'confirmation', title: '固定计划确认', owner: '米传汇智 / 运维', status: 'blocked', detail: '缺少确认摘要或配置、文件、环境状态已变化；未启动服务', nextAction: '重新展示预检报告，确认新的 planHash 后再启动。' }],
    nextActions: [...plan.nextActions, { step: 'confirmation', owner: '米传汇智 / 运维', action: '重新确认当前预检计划。' }] };
  const serve = runtime.serveControl || serveControl, tick = runtime.automationTick || automationTick, watch = runtime.startAutomation || startAutomation;
  let server, scheduler, stopPromise;
  const aborted = () => options.signal?.aborted === true;
  const abort = () => { void stop(); };
  const stop = () => {
    if (stopPromise) return stopPromise;
    options.signal?.removeEventListener('abort', abort);
    const drain = scheduler?.stop(); scheduler = null;
    const current = server; server = null;
    const closed = current ? new Promise((resolve) => current.close(() => resolve())) : Promise.resolve();
    stopPromise = Promise.all([drain, closed]).then(() => undefined);
    return stopPromise;
  };
  try {
    assert(!aborted(), 'central-start-cancelled');
    server = await serve({ configFile: plan.configFiles.controlConfigFile, port: plan.options.port, host: '127.0.0.1' });
    assert(!aborted(), 'central-start-cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    const args = { configFile: plan.configFiles.automationConfigFile, send: plan.options.send, env: options.env ?? process.env };
    if (plan.options.watch) {
      scheduler = watch({ ...args, ...(options.onResult ? { onResult: options.onResult } : {}) });
      return { ...plan, status: 'started', mode: 'watch', automaticallyStarted: false, networkExecuted: null, messagesSent: null,
        execution: { controlListening: true, automation: 'watch', messageSendingEnabled: plan.options.send, fieldAcceptance: 'pending' }, stop };
    }
    const result = await tick(args); await stop();
    return { ...plan, status: aborted() ? 'cancelled' : result.status === 'ok' ? 'completed' : 'attention', mode: 'tick', networkExecuted: result.networkExecuted === true,
      messagesSent: plan.options.send && !!result.delivery?.results?.some((item) => item.status === 'delivered'),
      execution: { controlListening: false, automation: result.status, errors: result.errors?.length || 0, sources: result.sources?.length || 0, messageSendingEnabled: plan.options.send, fieldAcceptance: 'pending' } };
  } catch (error) {
    await stop();
    return { ...plan, status: aborted() ? 'cancelled' : 'attention', mode: plan.options.watch ? 'watch' : 'tick',
      execution: { controlListening: false, automation: 'failed', messageSendingEnabled: false, fieldAcceptance: 'pending', reason: /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : 'runtime-failed' },
      nextActions: [{ step: 'start', owner: '米传汇智 / 运维', action: '启动或采集失败；本入口已停止自己启动的服务。核对受控执行器日志后重新预检，勿删除旧账。' }, ...plan.nextActions] };
  }
}
