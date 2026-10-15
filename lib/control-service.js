import path from "node:path";
import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { controlledPath, readControlledJson, writeExclusiveJson, lockedJson } from "./control-store.js";
import { validateIdentityConfig, createIdentityLogin, exchangeIdentityCode } from "./identity.js";
import { loadGovernanceConfig, readGovernanceState, signPlatformReceipt, actionGovernance } from "./governance.js";
import { validateReviewEvidence, validateReviewAuthorization } from "./review.js";
import { signRecord } from "./evidence.js";
import { stableStringify } from "./util.js";
import { inspectControlDeployment, authorizeControlDeployment, registerControlDeployment } from "./control-deployment.js";
import { verifyCollectedReview, loadReviewCollectorConfig } from "./review-collect.js";
import { verifyLiveCiReview } from "./review-live.js";

const assert = (value, message) => { if (!value) throw new Error(message); };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const id = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const publicDer = (key) => createPublicKey(key).export({ type: "spki", format: "der" });
const inside = (root, file) => { const relative = path.relative(controlledPath(root), controlledPath(file)); assert(relative && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative), "证据不在批准根目录"); return file; };

export function loadControlConfig(file) {
  const c = readControlledJson(file), base = path.dirname(path.resolve(file));
  assert(c.schemaVersion === 1, "认证操作服务配置版本无效");
  const u = new URL(c.origin); assert(u.protocol === "https:" && u.origin === c.origin, "认证操作入口必须固定HTTPS origin");
  for (const name of ["governanceConfigFile", "stateFile", "dataDir", "receiptPrivateKeyFile", "authorizationPrivateKeyFile"]) c[name] = controlledPath(path.resolve(base, c[name] || ""));
  c.identity.publicKeyFile = controlledPath(path.resolve(base, c.identity.publicKeyFile)); validateIdentityConfig(c.identity);
  const g = loadGovernanceConfig(c.governanceConfigFile);
  assert(g.allowedLinkOrigins.includes(c.origin), "认证操作入口不在治理允许来源");
  assert(id(c.authorizationIssuer) && c.reviewPolicies && typeof c.reviewPolicies === "object", "缺少独立Review授权issuer/批准策略");
  const receiptKey = createPrivateKey(readFileSync(c.receiptPrivateKeyFile)), authorizationKey = createPrivateKey(readFileSync(c.authorizationPrivateKeyFile));
  assert(receiptKey.asymmetricKeyType === "ed25519" && authorizationKey.asymmetricKeyType === "ed25519" && publicDer(receiptKey).equals(createPublicKey(readFileSync(g.publicKeyFile)).export({ type: "spki", format: "der" })), "中央事件签名密钥未绑定治理公钥");
  const identityDer = createPublicKey(readFileSync(c.identity.publicKeyFile)).export({ type: "spki", format: "der" });
  assert(!publicDer(receiptKey).equals(publicDer(authorizationKey)) && !publicDer(authorizationKey).equals(identityDer) && !publicDer(receiptKey).equals(identityDer), "身份、事件与Review授权密钥必须分离");
  const known = new Set([...g.operators, ...Object.values(g.projects).flatMap((p) => [p.owner, p.backup, p.escalationOwner, ...p.reviewers, ...(p.members || [])])]);
  assert(Object.values(c.identity.subjects).every((v) => known.has(v)), "身份映射包含未登记人员");
  for (const [project, spec] of Object.entries(c.reviewPolicies)) {
    assert(Object.hasOwn(g.projects, project) && /^[a-f0-9]{64}$/.test(spec.policyHash || ""), "Review项目/策略摘要未批准");
    spec.evidenceRoot = controlledPath(path.resolve(base, spec.evidenceRoot));
    assert(typeof spec.collectorConfigFile === "string" && spec.collectorConfigFile, "Review入口必须绑定可信CI补证配置");
    spec.collectorConfigFile = controlledPath(path.resolve(base, spec.collectorConfigFile));
    const collector = loadReviewCollectorConfig(spec.collectorConfigFile);
    assert(collector.project === project && collector.reviewPolicyHash === spec.policyHash && collector.allowedAuthorIds.every((a) => Object.values(c.identity.subjects).includes(a)), "Review作者映射/采集策略未绑定认证员工");
    if (collector.supplement) assert(collector.supplement.governanceConfigFile === c.governanceConfigFile && collector.supplement.authorizationIssuer === c.authorizationIssuer && createPublicKey(readFileSync(collector.supplement.authorizationPublicKeyFile)).export({ type: "spki", format: "der" }).equals(publicDer(authorizationKey)), "人工补证配置未绑定当前治理与身份授权公钥");
  }
  c.deploymentConfigs ??= {};
  for (const [name, file] of Object.entries(c.deploymentConfigs)) { assert(id(name) && typeof file === "string", "部署通道配置无效"); c.deploymentConfigs[name] = controlledPath(path.resolve(base, file)); }
  c.governance = g; return c;
}

// Called by the controlled evidence producer, never from an unauthenticated HTTP
// request. Registering a draft neither approves nor signs a Review.
export async function registerControlReview({ configFile, reviewId, recordFile, evidenceRoot, provenanceFile, now = Date.now() }) {
  const c = loadControlConfig(configFile); assert(id(reviewId), "Review入口编号无效");
  recordFile = controlledPath(recordFile); evidenceRoot = controlledPath(evidenceRoot);
  const record = readControlledJson(recordFile), spec = c.reviewPolicies[record.project];
  assert(spec && record.schemaVersion === 2 && record.kind === "review-draft" && record.decision === "pending-confirmation", "只登记实际生成的待确认Review草稿");
  inside(spec.evidenceRoot, recordFile); inside(spec.evidenceRoot, path.join(evidenceRoot, ".scope")); inside(evidenceRoot, recordFile);
  assert(record.content?.policyHash === spec.policyHash && hash(stableStringify(record.content)) === record.reviewDigest, "Review草稿摘要/受控策略不符");
  provenanceFile = controlledPath(provenanceFile); inside(evidenceRoot, provenanceFile);
  verifyCollectedReview({ recordFile, evidenceRoot, provenanceFile, configFile: spec.collectorConfigFile, now });
  const entry = { reviewId, project: record.project, recordFile, evidenceRoot, recordHash: hash(readFileSync(recordFile)), provenanceFile, provenanceHash: hash(readFileSync(provenanceFile)) };
  return lockedJson(path.join(c.dataDir, "reviews.json"), { schemaVersion: 1, reviews: {} }, (catalog) => {
    assert(catalog.schemaVersion === 1 && catalog.reviews && typeof catalog.reviews === "object", "Review目录损坏");
    if (Object.hasOwn(catalog.reviews, reviewId)) assert(stableStringify(catalog.reviews[reviewId]) === stableStringify(entry), "同一Review入口不能替换正文；请登记新版本");
    catalog.reviews[reviewId] = entry; return { status: "registered", url: `${c.origin}/reviews/${reviewId}` };
  });
}

export function createControlHandler({ configFile, fetchImpl = fetch, env = process.env, clock = () => Date.now() }) {
  const c = loadControlConfig(configFile), pending = new Map();
  mkdirSync(c.dataDir, { recursive: true, mode: 0o700 });
  for (const name of ["authorizations", "actions", "auth-check"]) mkdirSync(controlledPath(path.join(c.dataDir, name)), { recursive: true, mode: 0o700 });
  const redirectUri = c.origin + "/auth/callback", sessionsFile = path.join(c.dataDir, "sessions.json");
  const binding = hash(stableStringify({ origin: c.origin, identity: c.identity, governance: c.governance, authorizationIssuer: c.authorizationIssuer }));
  const cookie = (req, name) => { const matches = String(req.headers.cookie || "").split(";").map((v) => v.trim()).filter((v) => v.startsWith(name + "=")); return matches.length === 1 ? matches[0].slice(name.length + 1) : null; };
  const respond = (res, status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", ...headers }); res.end(body); };
  const page = (title, body, actor) => `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>body{max-width:1000px;margin:32px auto;padding:0 18px;font:16px/1.6 system-ui;color:#202c3b}a{color:#175cd3}fieldset,article{border:1px solid #d0d5dd;border-radius:8px;margin:14px 0;padding:16px}input,select,textarea,button{font:inherit;padding:6px;max-width:95%}textarea{width:90%}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:18px}small{color:#526071}label{display:block;margin:8px 0}</style><h1>${esc(title)}</h1>${actor ? `<small>已认证：${esc(actor)} · <a href="/issues">问题</a> · <a href="/reviews">Review</a> · <a href="/deliveries">投递恢复</a></small>` : ""}${body}`;
  const csrf = (session) => `<input type="hidden" name="csrf" value="${esc(session.csrf)}">`;
  const hidden = (name, value) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
  const permitted = (actor, p) => c.governance.operators.includes(actor) || [p.owner, p.backup, p.escalationOwner, ...p.reviewers, ...(p.members || [])].includes(actor);
  const sessionFor = async (req) => {
    const token = cookie(req, "wl_quality_session"); if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const catalog = existsSync(sessionsFile) ? readControlledJson(sessionsFile) : { schemaVersion: 1, binding, sessions: {} };
    assert(catalog.schemaVersion === 1 && catalog.binding === binding && catalog.sessions, "会话配置已变化或会话库损坏，请受控重启登录");
    const s = catalog.sessions[hash(token)]; return s && s.expiresAt > clock() && c.identity.subjects[s.subject] === s.actorId ? s : null;
  };
  const getReview = (reviewId) => {
    const catalog = readControlledJson(path.join(c.dataDir, "reviews.json")), entry = catalog.reviews?.[reviewId]; assert(entry, "Review未登记");
    const spec = c.reviewPolicies[entry.project]; assert(spec, "Review项目未批准"); inside(spec.evidenceRoot, entry.recordFile); inside(entry.evidenceRoot, entry.recordFile);
    assert(hash(readFileSync(controlledPath(entry.recordFile))) === entry.recordHash, "Review正文已变化，旧卡片失效");
    assert(hash(readFileSync(controlledPath(entry.provenanceFile))) === entry.provenanceHash, "Review身份来源已变化");
    verifyCollectedReview({ recordFile: entry.recordFile, evidenceRoot: entry.evidenceRoot, provenanceFile: entry.provenanceFile, configFile: spec.collectorConfigFile, now: clock() });
    return { entry, record: readControlledJson(entry.recordFile), spec };
  };
  return async function handler(req, res) {
    try {
      assert(req.headers.host === new URL(c.origin).host, "请求Host未批准");
      const u = new URL(req.url, c.origin); assert(u.origin === c.origin && !u.hash, "请求地址无效");
      if (req.method === "GET" && u.pathname === "/auth/login") {
        for (const [key, value] of pending) if (value.expiresAt <= clock()) pending.delete(key);
        assert(pending.size < 1000, "登录请求超出预算");
        const returnTo = u.searchParams.get("return") || "/issues"; assert(/^\/(?:issues|reviews|deliveries|deployments)(?:\/[A-Za-z0-9_.:-]+)?$/.test(returnTo), "登录返回地址不合法");
        const login = createIdentityLogin(c.identity, { redirectUri, now: clock() }), browser = randomBytes(32).toString("base64url");
        pending.set(login.state, { ...login, browserHash: hash(browser), returnTo });
        return respond(res, 302, "", { Location: login.url, "Set-Cookie": `wl_quality_login=${browser}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=300` });
      }
      if (req.method === "GET" && u.pathname === "/auth/callback") {
        const state = u.searchParams.get("state"), login = pending.get(state); assert(login && cookie(req, "wl_quality_login") && hash(cookie(req, "wl_quality_login")) === login.browserHash, "登录state/浏览器绑定无效");
        pending.delete(state); // consume before awaiting the identity provider
        assert(u.searchParams.getAll("code").length === 1 && u.searchParams.getAll("state").length === 1, "登录响应参数重复");
        const identity = await exchangeIdentityCode(c.identity, { code: u.searchParams.get("code"), login, redirectUri, env, fetchImpl, now: clock() });
        const token = randomBytes(32).toString("base64url"), session = { ...identity, csrf: randomBytes(32).toString("base64url"), expiresAt: Math.min(identity.expiresAt, clock() + 3600000) };
        await lockedJson(sessionsFile, { schemaVersion: 1, binding, sessions: {} }, (s) => { assert(s.schemaVersion === 1 && s.binding === binding && s.sessions, "会话库损坏"); for (const [key, value] of Object.entries(s.sessions)) if (value.expiresAt <= clock()) delete s.sessions[key]; assert(Object.keys(s.sessions).length < 10000, "活跃会话超出预算"); s.sessions[hash(token)] = session; });
        return respond(res, 302, "", { Location: login.returnTo, "Set-Cookie": [`wl_quality_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`, "wl_quality_login=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0"] });
      }
      const session = await sessionFor(req);
      if (!session) { if (req.method === "GET") { const reviewParent = u.pathname.match(/^(\/reviews\/[A-Za-z0-9_.:-]+)\/evidence\/[A-Za-z0-9_.:-]+$/); return respond(res, 302, "", { Location: `/auth/login?return=${encodeURIComponent(reviewParent ? reviewParent[1] : u.pathname === "/" ? "/issues" : u.pathname)}` }); } return respond(res, 401, page("请重新登录", "身份会话无效")); }
      const actor = session.actorId;
      let data;
      if (req.method === "POST") {
        assert(req.headers.origin === c.origin && !["cross-site", "none"].includes(req.headers["sec-fetch-site"]), "写入请求来源无效");
        const chunks = []; let size = 0; for await (const part of req) { const bytes = Buffer.from(part); size += bytes.length; assert(size <= 32768, "动作请求超出预算"); chunks.push(bytes); } const body = Buffer.concat(chunks).toString("utf8");
        if (req.headers["content-type"]?.startsWith("application/json")) data = JSON.parse(body);
        else { assert(req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded"), "请求格式不支持"); const params = new URLSearchParams(body); assert(new Set(params.keys()).size === [...params.keys()].length, "动作字段重复"); data = Object.fromEntries(params); }
        assert(data && typeof data === "object" && !Array.isArray(data) && data.csrf === session.csrf && !Object.hasOwn(data, "actorId"), "CSRF无效或请求试图自报身份");
      }
      const state = readGovernanceState({ configFile: c.governanceConfigFile, stateFile: c.stateFile });
      if (req.method === "GET" && ["/", "/issues"].includes(u.pathname)) {
        const issues = Object.values(state.issues).filter((i) => permitted(actor, c.governance.projects[i.project]));
        return respond(res, 200, page("质量问题", issues.map((i) => `<article><a href="/issues/${esc(i.id)}">${esc(i.project)} · ${esc(i.ruleId)} · ${esc(i.status)}</a><br>${esc(i.file)} ${esc(i.message || "")}<br><small>主责 ${esc(i.owner)} · 备份 ${esc(i.backup)}</small></article>`).join("") || "当前无问题", actor));
      }
      const issueMatch = u.pathname.match(/^\/issues\/([a-f0-9]{64})$/);
      if (issueMatch) {
        const issue = state.issues[issueMatch[1]]; assert(issue && permitted(actor, c.governance.projects[issue.project]), "无权查看该问题");
        const p = c.governance.projects[issue.project];
        if (req.method === "GET") {
          const closure = p.scopes[issue.scope].closurePolicy;
          const environments = (closure?.requiredEnvironments || []).map((environment) => {
            const facts = Object.values(state.lifecycles).filter((f) => f.category === "deploy" && f.project === issue.project && f.scope === issue.scope && f.environment === environment && f.lane === closure.deploymentLane && f.sha === issue.pendingEvidence?.sha && f.actorId === actor && f.status === "verified");
            return `<label>${esc(environment)} 实际部署复验<select required name="verification_${environment}"><option value="">请选择已验证事实</option>${facts.map((f) => `<option value="${esc(f.eventId)}">${esc(f.deploymentId)} · ${esc(f.sha.slice(0, 12))}</option>`).join("")}</select></label>`;
          }).join("");
          const claim = [p.owner, p.backup].includes(actor) && issue.status !== "closed" ? `<form method="post">${csrf(session)}${hidden("action", "claim")}${hidden("revision", issue.revision)}<button>我来处理</button></form>` : "";
          const close = p.reviewers.includes(actor) && issue.status === "awaitingVerification" && closure ? `<form method="post">${csrf(session)}${hidden("action", "close")}${hidden("revision", issue.revision)}${hidden("sha", issue.pendingEvidence.sha)}${hidden("reportHash", issue.pendingEvidence.reportHash)}${environments}<label>复验结论<textarea required name="reason" maxlength="2000"></textarea></label><label>验证记录链接<input required type="url" name="verificationUrl"></label><button>确认各环境复验并关闭</button></form>` : "";
          return respond(res, 200, page(`${issue.project} · ${issue.ruleId}`, `<p>${esc(issue.status)} · ${esc(issue.file)} · ${esc(issue.message || "")}</p><p><a href="${esc(issue.latestEvidence.reportUrl)}">原始报告</a> · <a href="${esc(issue.latestEvidence.pipelineUrl)}">流水线</a></p>${claim}${close}`, actor));
        }
        assert(req.method === "POST" && ["claim", "close"].includes(data.action), "不支持该问题动作");
        const action = { schemaVersion: 1, kind: "issue-action", eventId: `action-${randomUUID()}`, actorId: actor, action: data.action, issueId: issue.id, expectedRevision: Number(data.revision) };
        if (data.action === "close") Object.assign(action, { sha: data.sha, reportHash: data.reportHash, result: "passed", environment: p.scopes[issue.scope].closurePolicy?.requiredEnvironments[0], reason: data.reason, verificationUrl: data.verificationUrl, verificationEventIds: (p.scopes[issue.scope].closurePolicy?.requiredEnvironments || []).map((e) => data[`verification_${e}`]) });
        const file = writeExclusiveJson(path.join(c.dataDir, "actions", action.eventId + ".json"), signPlatformReceipt(action, { privateKeyFile: c.receiptPrivateKeyFile, issuer: c.governance.issuer, createdAt: new Date(clock()).toISOString() }));
        actionGovernance({ configFile: c.governanceConfigFile, stateFile: c.stateFile, actionFile: file, now: clock() });
        return respond(res, 303, "", { Location: u.pathname });
      }
      if (req.method === "GET" && u.pathname === "/reviews") {
        const catalog = existsSync(path.join(c.dataDir, "reviews.json")) ? readControlledJson(path.join(c.dataDir, "reviews.json")) : { reviews: {} };
        return respond(res, 200, page("Review确认", Object.values(catalog.reviews).filter((r) => permitted(actor, c.governance.projects[r.project])).map((r) => `<p><a href="/reviews/${esc(r.reviewId)}">${esc(r.project)} · ${esc(r.reviewId)}</a></p>`).join("") || "暂无待确认Review", actor));
      }
      const evidenceMatch = u.pathname.match(/^\/reviews\/([A-Za-z0-9_.:-]+)\/evidence\/([A-Za-z0-9_.:-]+)$/);
      if (req.method === "GET" && evidenceMatch) {
        const { record, entry } = getReview(evidenceMatch[1]); assert(permitted(actor, c.governance.projects[record.project]), "无权读取Review证据");
        const evidence = record.content.evidence.find((e) => e.id === evidenceMatch[2]); assert(evidence, "证据未登记");
        const file = controlledPath(inside(entry.evidenceRoot, path.resolve(entry.evidenceRoot, evidence.file))), stat = statSync(file);
        assert(stat.isFile() && stat.size <= 16 * 1024 * 1024, "证据超出网页下载预算，请通过受控工件存储查看");
        const bytes = readFileSync(file); assert(hash(bytes) === evidence.sha256, "原始证据已变化");
        return respond(res, 200, bytes, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` });
      }
      const reviewMatch = u.pathname.match(/^\/reviews\/([A-Za-z0-9_.:-]+)$/);
      if (reviewMatch) {
        const { record, entry, spec } = getReview(reviewMatch[1]); assert(permitted(actor, c.governance.projects[record.project]), "无权查看Review");
        let invalid; try { validateReviewEvidence(record, { evidenceRoot: entry.evidenceRoot, expectReviewPolicyHash: spec.policyHash, project: record.project, sha: record.candidateSha }); } catch (error) { invalid = error.message; }
        const reviewer = c.governance.projects[record.project].reviewers.includes(actor) && actor !== record.authorId;
        const humanDimensions = record.content.dimensions.filter((d) => d.applicable && (d.id === "ui" && d.missingTypes.includes("ui-verification") || d.id === "review" && d.missingTypes.includes("impact-review") || d.id === "tests" && d.missingTypes.includes("test-verification")));
        const canSupplement = reviewer && humanDimensions.length > 0 && !!loadReviewCollectorConfig(spec.collectorConfigFile).supplement;
        if (req.method === "GET") {
          const allowed = c.governance.projects[record.project].reviewers.includes(actor) && actor !== record.authorId && !invalid;
          const form = allowed ? `<form method="post">${csrf(session)}${hidden("reviewDigest", record.reviewDigest)}${record.content.dimensions.map((d) => `<fieldset><label><input required type="checkbox" name="decision_${esc(d.id)}" value="${d.applicable ? "approved" : "not-applicable"}"> ${esc(d.name || d.id)}：${d.applicable ? "已复核证据" : "同意不适用"}</label><input required name="reason_${esc(d.id)}" placeholder="该维度复核结论" maxlength="1000"></fieldset>`).join("")}<label>整体复核结论<textarea required name="reason" maxlength="2000"></textarea></label><button>确认并授权发布本份Review</button></form>` : `<p>${esc(invalid || "当前身份不能批准此Review")}</p>`;
          const bodyFile = inside(entry.evidenceRoot, path.resolve(entry.evidenceRoot, record.bodyFile));
          const evidenceLinks = record.content.evidence.map((e) => `<li><a href="/reviews/${esc(reviewMatch[1])}/evidence/${encodeURIComponent(e.id)}">${esc(e.id)} · ${esc(e.dimensionIds.join("、"))} · ${esc(e.type)}</a></li>`).join("");
          const supplementForm = canSupplement ? `<form method="post">${csrf(session)}${hidden("action", "supplement")}${hidden("reviewDigest", record.reviewDigest)}<h2>补充实际验证记录</h2><p>查看变更和实际验证原件后填写测试范围、用例与结果。此处保存的是认证人员的复核记录；机器阻断须先修复复扫。保存后生成新版本，仍须逐维确认。</p>${humanDimensions.map((d) => `<fieldset><legend>${esc(d.name || d.id)}</legend><label>验证范围、结果与风险<textarea required name="conclusion_${d.id}" maxlength="2000"></textarea></label><label>实际截图、测试或评审记录链接<input required type="url" name="verificationUrl_${d.id}" maxlength="2000"></label></fieldset>`).join("")}<button>保存补证并查看新版本</button></form>` : "";
          return respond(res, 200, page("Review确认", `<p>候选 ${esc(record.candidateSha)} · 作者 ${esc(record.authorId)}<br>正文摘要 ${esc(record.bodyDigest)}</p><details open><summary>查看九维原始证据</summary><ul>${evidenceLinks}</ul></details><pre>${esc(readFileSync(controlledPath(bodyFile), "utf8"))}</pre>${form}${supplementForm}`, actor));
        }
        if (req.method === "POST" && data.action === "supplement") {
          assert(canSupplement && data.reviewDigest === record.reviewDigest, "人工补证必须由已登记非作者复核人基于当前正文提交");
          await verifyLiveCiReview({ configFile: spec.collectorConfigFile, recordFile: entry.recordFile, evidenceRoot: entry.evidenceRoot, provenanceFile: entry.provenanceFile, outDir: path.join(c.dataDir, "auth-check", randomUUID()), env, fetchImpl, now: clock() });
          const { extendCollectedReview } = await import("./review-additions.js");
          const extended = extendCollectedReview({ configFile: spec.collectorConfigFile, recordFile: entry.recordFile, evidenceRoot: entry.evidenceRoot, provenanceFile: entry.provenanceFile, outDir: path.join(entry.evidenceRoot, "authenticated", randomUUID()), now: clock(), authorizationPrivateKeyFile: c.authorizationPrivateKeyFile, human: { actorId: actor, identitySource: session.identitySource, entries: humanDimensions.map((d) => ({ dimensionId: d.id, conclusion: data[`conclusion_${d.id}`], verificationUrl: data[`verificationUrl_${d.id}`] })) } });
          const nextId = `${reviewMatch[1].slice(0, 102)}-human-${extended.reviewDigest.slice(0, 16)}`;
          const registered = await registerControlReview({ configFile, reviewId: nextId, recordFile: extended.recordFile, evidenceRoot: entry.evidenceRoot, provenanceFile: extended.provenanceFile, now: clock() });
          return respond(res, 303, "", { Location: new URL(registered.url).pathname });
        }
        assert(data?.action === undefined || data.action === "approve", "Review动作无效");
        assert(req.method === "POST" && !invalid && c.governance.projects[record.project].reviewers.includes(actor) && actor !== record.authorId, invalid || "Review必须由已登记非作者复核");
        assert(data.reviewDigest === record.reviewDigest && typeof data.reason === "string" && data.reason.trim() && data.reason.length <= 2000, "Review已变化或缺少明确结论");
        await verifyLiveCiReview({ configFile: spec.collectorConfigFile, recordFile: entry.recordFile, evidenceRoot: entry.evidenceRoot,
          provenanceFile: entry.provenanceFile, outDir: path.join(c.dataDir, "auth-check", randomUUID()), env, fetchImpl, now: clock() });
        const authorization = signRecord({ schemaVersion: 1, kind: "review-authorization", scope: "review-publish", decision: "approved", issuer: c.authorizationIssuer, authorizationId: `authorization-${randomUUID()}`, identitySource: session.identitySource, actorId: actor, authorId: record.authorId, project: record.project, candidateSha: record.candidateSha, reviewDigest: record.reviewDigest, bodyDigest: record.bodyDigest, evidenceDigest: record.evidenceDigest, reason: data.reason, createdAt: new Date(clock()).toISOString(), expiresAt: new Date(Math.min(clock() + 900000, session.expiresAt)).toISOString(), dimensionDecisions: record.content.dimensions.map((d) => ({ id: d.id, decision: data[`decision_${d.id}`], reason: data[`reason_${d.id}`] })) }, c.authorizationPrivateKeyFile);
        // Validate using a public key derived from the configured signing key;
        // validation remains identical to the independent formal signer.
        const authPublic = path.join(c.dataDir, "authorization-public.pem");
        const pem = createPublicKey(createPrivateKey(readFileSync(c.authorizationPrivateKeyFile))).export({ type: "spki", format: "pem" });
        if (!existsSync(authPublic)) { const { writeFileSync } = await import("node:fs"); writeFileSync(controlledPath(authPublic), pem, { flag: "wx", mode: 0o600 }); }
        assert(readFileSync(controlledPath(authPublic), "utf8") === pem, "Review授权公钥变化");
        validateReviewAuthorization(authorization, record, { reviewerId: actor, authorId: record.authorId, project: record.project, sha: record.candidateSha, authorizationPublicKeyFile: authPublic, expectAuthorizationIssuer: c.authorizationIssuer, now: new Date(clock()) });
        writeExclusiveJson(path.join(c.dataDir, "authorizations", authorization.authorizationId + ".json"), authorization);
        return respond(res, 200, page("Review已授权", `<p>已绑定当前正文、九维证据及候选提交，等待受控签发作业生成正式Review。</p><p>授权编号 ${esc(authorization.authorizationId)}</p>`, actor), { "X-Quality-Authorization-Id": authorization.authorizationId });
      }
      const deploymentMatch = u.pathname.match(/^\/deployments\/([A-Za-z0-9_.:-]+)$/);
      if (deploymentMatch) {
        const catalogFile = path.join(c.dataDir, "deployments.json"); let catalog = existsSync(catalogFile) ? readControlledJson(catalogFile) : { plans: {} }, entry = catalog.plans?.[deploymentMatch[1]];
        if (!entry) {
          const request = readControlledJson(path.join(c.dataDir, "deployment-requests", deploymentMatch[1] + ".json"));
          assert(request.schemaVersion === 1 && request.kind === "deployment-plan-request" && request.planId === deploymentMatch[1] && id(request.planId) && id(request.configId) && hash(readFileSync(controlledPath(request.planFile))) === request.planFileHash, "部署队列身份或原计划摘要变化");
          await registerControlDeployment({ config: c, planId: request.planId, configId: request.configId, planFile: request.planFile, releaseSetFile: request.releaseSetFile, now: clock() });
          catalog = readControlledJson(catalogFile); entry = catalog.plans[deploymentMatch[1]];
        }
        assert(entry, "部署计划未登记"); const { plan, config } = inspectControlDeployment(c, entry, clock());
        const releaseSet = readControlledJson(entry.releaseSetFile);
        const allowed = (plan.action === "smoke" ? config.verifiers : config.operators).includes(actor) && !releaseSet.components.some((p) => p.authorId === actor); assert(allowed, "当前认证人员无权授权此部署动作或是组件作者");
        if (req.method === "GET") return respond(res, 200, page("部署动作确认", `<p>动作 ${esc(plan.action)} · 环境 ${esc(plan.environment)} · 通道 ${esc(plan.lane)}</p><pre>${esc(plan.components.map((p) => `${p.project}  ${p.sha}  制品 ${p.artifactHash}`).join("\n"))}</pre><p>发布顺序：${esc(plan.deploymentOrder?.join(" → "))}<br>API契约：${esc(plan.apiContractHash)}<br>目标数据库版本：${esc(plan.expectedSchemaVersion)}<br>数据库动作：${esc(plan.databaseExecution?.mode)} · 恢复约束：${esc(plan.compatibility?.rollback?.mode)}</p><details><summary>数据库与恢复原始约束</summary><pre>${esc(JSON.stringify({database:plan.compatibility?.database,rollback:plan.compatibility?.rollback,previousReleaseConstraints:plan.previousReleaseConstraints},null,2))}</pre></details><p>计划摘要 ${esc(plan.planHash)}</p><form method="post">${csrf(session)}${hidden("planHash", plan.planHash)}<label>确认原因<textarea required name="reason" maxlength="2000"></textarea></label><button>授权执行本次${esc(plan.action)}动作</button></form>`, actor));
        assert(req.method === "POST", "部署确认方法无效");
        const authorization = authorizeControlDeployment({ config: c, entry, actorId: actor, reason: data.reason, expectedPlanHash: data.planHash, identitySource: session.identitySource, now: clock() });
        return respond(res, 200, page("部署动作已授权", `<p>授权编号 ${esc(authorization.authorizationId)}，受控执行器将再次核对计划、制品和当前环境状态。</p>`, actor), { "X-Quality-Authorization-Id": authorization.authorizationId });
      }
      if (u.pathname === "/deliveries") {
        assert(c.governance.operators.includes(actor), "只有登记运维可恢复投递");
        if (req.method === "GET") return respond(res, 200, page("消息投递恢复", Object.values(state.outbox).filter((x) => ["dead-letter", "attempting"].includes(x.status)).map((x) => `<article>${esc(x.id)} · ${esc(x.status)}<form method="post">${csrf(session)}${hidden("messageId", x.id)}${hidden("attemptId", x.attemptId || "")}<label>核实结果<select name="outcome"><option value="not-received">已核实未收到，允许重试</option><option value="accepted-by-provider">已核实已收到，补记成功</option></select></label><label>核实记录<input required name="verificationUrl" type="url"></label><label>原因<input required name="reason" maxlength="2000"></label><button>确认投递核实</button></form></article>`).join("") || "没有待恢复消息", actor));
        assert(req.method === "POST", "投递动作无效");
        const item = state.outbox[data.messageId]; assert(item && ["dead-letter", "attempting"].includes(item.status), "投递已变化");
        assert(item.status === "attempting" || data.outcome === "not-received", "确定失败的投递只能修复配置后重试");
        const action = { schemaVersion: 1, kind: "issue-action", eventId: `delivery-${randomUUID()}`, actorId: actor, action: item.status === "dead-letter" ? "retry-delivery" : "resolve-delivery", messageId: data.messageId, expectedAttemptId: data.attemptId, outcome: data.outcome, reason: data.reason, verificationUrl: data.verificationUrl };
        const file = writeExclusiveJson(path.join(c.dataDir, "actions", action.eventId + ".json"), signPlatformReceipt(action, { privateKeyFile: c.receiptPrivateKeyFile, issuer: c.governance.issuer, createdAt: new Date(clock()).toISOString() }));
        actionGovernance({ configFile: c.governanceConfigFile, stateFile: c.stateFile, actionFile: file, now: clock() }); return respond(res, 303, "", { Location: "/deliveries" });
      }
      return respond(res, 404, page("未找到", "入口不存在", actor));
    } catch (error) { return respond(res, 400, page("动作未执行", `<p>${esc(error.message)}</p><p>请刷新页面查看最新证据后重试。</p>`)); }
  };
}

export async function serveControl({ configFile, port = 8787, host = "127.0.0.1" }) {
  assert(host === "127.0.0.1" && Number.isSafeInteger(Number(port)) && Number(port) > 0 && Number(port) <= 65535, "操作服务只监听回环地址，由现有HTTPS反向代理接入");
  const handler = createControlHandler({ configFile }), server = createServer(handler);
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 50;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(Number(port), host, resolve); }); return server;
}
