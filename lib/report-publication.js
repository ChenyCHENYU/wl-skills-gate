import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { controlledPath } from "./control-store.js";
import { safePath } from "./source-state.js";
import { stableStringify } from "./util.js";
import { renderProjectReviewReport, renderPipelineReviewReport } from "./project-review-report.js";
import { validateSummaryAgainstSchema, DEFAULT_SCHEMA_FILE } from "./validate-report.js";

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function buildUrl(value) {
  const u = new URL(value);
  assert(u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && /^\/(?:job\/[^/]+\/)+[1-9][0-9]*\/$/.test(u.pathname), "报告必须绑定具体Jenkins构建编号的HTTPS链接，不能使用latest/lastBuild或携带凭据");
  return u;
}

// The caller supplies an existing report/draft. Archiving grants no approval.
export function archiveQualityReport({ input, outDir, jenkinsBuildUrl }) {
  const run = input?.summary?.run, stage = run?.stage;
  assert(run && ID.test(run.project || "") && ID.test(run.eventId || "") && ["local-hook", "ci"].includes(stage), "报告缺少项目、事件编号或明确的项目/流水线阶段");
  assert(input.presentation?.simulation === true || SHA.test(run.commitSha || ""), "正式归档必须绑定本轮源码SHA");
  if (!input.presentation?.simulation) assert(validateSummaryAgainstSchema(input.summary, JSON.parse(readFileSync(DEFAULT_SCHEMA_FILE, "utf8"))).length === 0, "正式归档的原始报告Schema无效");
  const build = jenkinsBuildUrl ? buildUrl(jenkinsBuildUrl) : null;
  const snapshot = JSON.parse(JSON.stringify(input));
  const html = stage === "local-hook" ? renderProjectReviewReport(snapshot) : renderPipelineReviewReport(snapshot);
  const archiveId = hash(stableStringify({ input: snapshot, buildUrl: build?.href || null, htmlSha256: hash(html) }));
  const relativeDirectory = `${run.project}/${stage}/${archiveId}`;
  mkdirSync(controlledPath(outDir), { recursive: true });
  const root = controlledPath(outDir), publicationRoot = safePath(root, `batches/${archiveId}`), destination = safePath(publicationRoot, relativeDirectory);
  const summary = json(snapshot.summary);
  const manifest = { schemaVersion: 1, kind: "quality-report-archive", archiveId, project: run.project, stage, eventId: run.eventId, commitSha: run.commitSha || null,
    createdAt: run.finishedAt || run.startedAt, simulation: snapshot.presentation?.simulation === true, relativeDirectory,
    htmlSha256: hash(html), summarySha256: hash(summary), buildUrl: build?.href || null,
    reportUrl: build ? new URL(`wl-quality/${relativeDirectory}/index.html`, build).href : null,
    status: "archived-awaiting-publication", approved: false };
  const files = { "index.html": html, "quality-summary.json": summary, "archive.json": json(manifest) };
  const checkExisting = () => {
    for (const [name, bytes] of Object.entries(files)) assert(readFileSync(controlledPath(safePath(destination, name)), "utf8") === bytes, "已归档报告被修改，禁止用新内容覆盖旧消息");
  };
  if (existsSync(destination)) checkExisting();
  else {
    mkdirSync(controlledPath(path.dirname(destination)), { recursive: true });
    const temporary = mkdtempSync(path.join(path.dirname(destination), ".report-"));
    try {
      for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(temporary, name), bytes, { flag: "wx", mode: 0o600 });
      try { renameSync(temporary, destination); }
      catch (error) { if (!existsSync(destination)) throw error; checkExisting(); }
    } finally { if (existsSync(temporary)) rmSync(temporary, { recursive: true }); }
  }
  return { ...manifest, manifestFile: path.join(destination, "archive.json"), entryFile: path.join(destination, "index.html"), archiveDir: destination, publicationRoot };
}

export function publicationInput({ summaryFile, reviewIndexFile }) {
  summaryFile = controlledPath(summaryFile);
  const raw = readFileSync(summaryFile), summary = JSON.parse(raw);
  let dimensions = [];
  if (reviewIndexFile && existsSync(reviewIndexFile)) {
    const index = JSON.parse(readFileSync(controlledPath(reviewIndexFile), "utf8"));
    assert(index.schemaVersion === 2 && index.project === summary.run.project && index.eventId === summary.run.eventId && index.summaryHash === hash(raw), "九维草稿不是本轮报告，不能混用历史结果");
    const record = JSON.parse(readFileSync(controlledPath(safePath(path.dirname(reviewIndexFile), index.recordFile)), "utf8"));
    assert(record.kind === "review-draft" && record.content?.candidateSha === summary.run.commitSha, "九维草稿未绑定本轮候选版本");
    dimensions = record.content.dimensions;
  }
  return { summary, dimensions, presentation: {} };
}

// The publishing job calls this after HTML Publisher, before any notification.
// A 200 login page, JSON artifact, redirect, or different report is not success.
export async function verifyPublishedQualityReport({ manifestFile, expectedOrigin, user, token, fetchImpl = fetch, now = Date.now() }) {
  const manifest = JSON.parse(readFileSync(controlledPath(manifestFile), "utf8"));
  assert(manifest.kind === "quality-report-archive" && manifest.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(manifest.htmlSha256 || ""), "报告归档清单无效");
  const build = buildUrl(manifest.buildUrl), origin = new URL(expectedOrigin);
  assert(origin.protocol === "https:" && origin.origin === build.origin && !origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === "/", "报告发布来源与批准的Jenkins入口不一致");
  assert(manifest.relativeDirectory === `${manifest.project}/${manifest.stage}/${manifest.archiveId}` && ID.test(manifest.project || "") && ["local-hook", "ci"].includes(manifest.stage) && /^[a-f0-9]{64}$/.test(manifest.archiveId || ""), "报告归档路径无效");
  const url = new URL(`wl-quality/${manifest.relativeDirectory}/index.html`, build);
  assert(url.href === manifest.reportUrl, "报告链接与固定归档不一致");
  const html = readFileSync(controlledPath(path.join(path.dirname(manifestFile), "index.html")));
  assert(hash(html) === manifest.htmlSha256, "本地归档HTML已经变化");
  assert((!user && !token) || (typeof user === "string" && user && !/[:\r\n]/.test(user) && typeof token === "string" && token && !/[\r\n]/.test(token)), "发布检查需成对提供只读Jenkins账号与Token，不能写入URL");
  const response = await fetchImpl(url.href, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15000), headers: user ? { Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}` } : {} });
  assert(response.status === 200 && /^text\/html(?:;|$)/i.test(response.headers.get("content-type") || ""), "报告尚不可访问，或返回登录页/JSON；不允许推送失效详情按钮");
  assert(!response.url || response.url === url.href, "报告请求发生未批准的跳转");
  const chunks = []; let size = 0;
  if (response.body) for await (const chunk of response.body) { size += chunk.byteLength; assert(size <= 16 * 1024 * 1024, "远端报告超出大小预算"); chunks.push(Buffer.from(chunk)); }
  assert(hash(Buffer.concat(chunks)) === manifest.htmlSha256, "远端HTML与本轮归档不一致，可能是登录页、旧报告或发布未完成");
  return { schemaVersion: 1, kind: "verified-quality-report-publication", project: manifest.project, stage: manifest.stage, archiveId: manifest.archiveId, reportUrl: url.href,
    htmlSha256: manifest.htmlSha256, verifiedAt: new Date(now).toISOString(), status: "accessible", audiencePermissionsVerified: false, approved: false };
}
