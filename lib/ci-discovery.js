import { createHash } from "node:crypto";
import { loadCiSourceConfig } from "./ci-source.js";
import { stableStringify } from "./util.js";

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const positive = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const iso = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const terminalStates = new Set(["success", "failed", "canceled", "skipped"]);
const gitlabStates = new Set([...terminalStates, "manual", "pending", "running", "created", "preparing", "scheduled", "waiting_for_resource", "canceling", "waiting_for_callback"]);
class DiscoveryTimeBudget extends Error {
  constructor() { super("CI发现本轮总时间预算已用完，保留续页与未完成队列"); this.code = "CI_DISCOVERY_TIME_BUDGET"; }
}
const digest = (value) => createHash("sha256").update(stableStringify(value)).digest("hex");

// Central fixed-source polling. A webhook, commit author, display name, build
// parameter, and job-supplied URL can never determine attribution or API routes.
export async function discoverCiRuns({ configFile, actors, since, updatedSince = since, recheckRunIds = [], cursor = null, afterRunId = 0, env = process.env, fetchImpl = fetch, now = Date.now(), monotonicNow = () => performance.now() }) {
  const startedMonotonic = monotonicNow();
  assert(Number.isFinite(startedMonotonic), "发现单调时钟无效");
  const config = loadCiSourceConfig(configFile);
  assert(iso(since) && Date.parse(since) <= Number(now) && Number.isFinite(Number(now)), "发现窗口必须是明确且不晚于当前时刻的ISO时间");
  assert(actors instanceof Map || actors && typeof actors === "object" && !Array.isArray(actors), "发现任务必须提供中央批准的来源用户ID映射");
  assert(iso(updatedSince) && Date.parse(updatedSince) <= Number(now), "增量发现窗口无效");
  assert(Array.isArray(recheckRunIds) && recheckRunIds.length <= 1000 && recheckRunIds.every((v) => positive(v)) && new Set(recheckRunIds.map(String)).size === recheckRunIds.length && Number.isSafeInteger(afterRunId) && afterRunId >= 0, "重查运行/高水位无效");
  const configHash = digest(config);
  if (cursor) assert(cursor.schemaVersion === 1 && cursor.configHash === configHash && cursor.since === since && iso(cursor.updatedSince) && iso(cursor.scanStartedAt) && Date.parse(cursor.scanStartedAt) <= Number(now) && Number.isSafeInteger(cursor.page) && cursor.page >= (config.system === "gitlab" ? 1 : 0) && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 && Number.isSafeInteger(cursor.afterRunId) && cursor.afterRunId >= 0, "发现续页游标身份/范围无效");
  const windowStart = cursor?.updatedSince || updatedSince, scanStartedAt = cursor?.scanStartedAt || new Date(now).toISOString(), lowerRunId = cursor?.afterRunId ?? afterRunId;
  let nextCursor = null, highWatermarkRunId = lowerRunId, partial = false;
  const resumeAt = (page, offset) => { partial = true; nextCursor = {schemaVersion:1, configHash, since, updatedSince:windowStart, scanStartedAt, page, offset, afterRunId:lowerRunId}; };
  const actorMap = actors instanceof Map ? actors : new Map(Object.entries(actors));
  for (const [source, actor] of actorMap) assert(typeof source === "string" && source && typeof actor === "string" && ID.test(actor), "中央来源用户映射必须为源用户ID到员工ID");
  const options = config.discovery || {}, pageSize = options.pageSize ?? 100, maxPages = options.maxPages ?? 20, maxRuns = options.maxRuns ?? 1000, dueAfterMinutes = options.dueAfterMinutes ?? 60, maxDurationMs = options.maxDurationMs ?? 20000;
  assert(Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 100 && Number.isSafeInteger(maxPages) && maxPages > 0 && maxPages <= 100 && Number.isSafeInteger(maxRuns) && maxRuns > 0 && maxRuns <= 10000 && Number.isSafeInteger(dueAfterMinutes) && dueAfterMinutes > 0 && dueAfterMinutes <= 10080, "CI发现分页/期限预算无效");
  assert(Number.isSafeInteger(maxDurationMs) && maxDurationMs > 0 && maxDurationMs <= 60000, "CI发现总时间预算必须为1~60000毫秒");
  const remaining = () => { const elapsed = monotonicNow() - startedMonotonic; assert(Number.isFinite(elapsed) && elapsed >= 0, "发现单调时钟无效或倒退"); return maxDurationMs - elapsed; };
  const requireTime = () => { const value = remaining(); if (value <= 0) throw new DiscoveryTimeBudget(); return value; };
  const token = env[config.tokenEnv]; assert(typeof token === "string" && token && !/[\r\n]/.test(token), "缺少有效CI发现只读凭据");
  if (config.system === "jenkins") assert(typeof env[config.userEnv] === "string" && env[config.userEnv] && !/[:\r\n]/.test(env[config.userEnv]), "缺少有效Jenkins发现只读用户");
  const headers = config.system === "gitlab" ? { "PRIVATE-TOKEN": token } : { Authorization: `Basic ${Buffer.from(`${env[config.userEnv]}:${token}`).toString("base64")}` };
  let actorSource;
  if (config.system === "jenkins" && config.actorSource !== undefined) {
    actorSource = config.actorSource;
    const origin = new URL(actorSource.baseUrl);
    assert(actorSource.system === "gitlab" && origin.protocol === "https:" && origin.origin === actorSource.baseUrl && positive(actorSource.projectId) && /^[A-Z][A-Z0-9_]+$/.test(actorSource.tokenEnv || "") && typeof actorSource.ref === "string" && actorSource.ref && !/[\u0000-\u001f]/.test(actorSource.ref), "Jenkins上游作者来源必须固定GitLab项目/ref/HTTPS来源和只读凭据");
    assert(typeof env[actorSource.tokenEnv] === "string" && env[actorSource.tokenEnv] && !/[\r\n]/.test(env[actorSource.tokenEnv]), "缺少上游作者核验只读凭据");
  }
  const responses = [], runs = [], discoveryErrors = [], attemptedRecheckRunIds = [], seen = new Set(); let responseBytes = 0, requests = 0, listedRuns = 0;
  const get = async (route, { xml = false, actorLookup = false, onAttempt } = {}) => {
    const source = actorLookup ? actorSource : config; assert(source, "未批准上游作者来源");
    const url = new URL(route, source.baseUrl);
    assert(url.origin === source.baseUrl && url.protocol === "https:" && !url.username && !url.password && !url.hash, "发现查询越出固定HTTPS来源");
    assert(++requests <= (maxRuns + recheckRunIds.length) * (maxPages * 2 + 8) + maxPages + 4, "发现请求超出预算");
    const requestHeaders = actorLookup ? { "PRIVATE-TOKEN": env[actorSource.tokenEnv] } : headers;
    const timeLeft = requireTime(), requestMs = Math.max(1, Math.min(15000, Math.ceil(timeLeft))), overallDeadline = timeLeft <= 15000;
    const controller = new AbortController(); let timer, expired = false;
    const operation = async () => {
      let response;
      try { requireTime(); onAttempt?.(); response = await fetchImpl(url.href, { method: "GET", headers: requestHeaders, redirect: "error", signal: controller.signal }); }
      catch { if (expired && overallDeadline || remaining() <= 0) throw new DiscoveryTimeBudget(); throw new Error("CI发现只读连接失败"); }
      if (expired) throw overallDeadline ? new DiscoveryTimeBudget() : new Error("CI发现只读查询超时"); requireTime();
      assert(!response.url || new URL(response.url).origin === source.baseUrl && !new URL(response.url).username && !new URL(response.url).password, "CI发现响应发生来源跳转");
      assert(response.ok, `CI发现只读查询失败: HTTP ${response.status}`);
      const limit = 10 * 1024 * 1024, declared = response.headers.get("content-length");
      assert(!declared || Number.isSafeInteger(Number(declared)) && Number(declared) >= 0 && Number(declared) <= limit, "CI发现响应超出预算");
      const chunks = []; let length = 0;
      if (response.body) for await (const part of response.body) { if (expired) throw overallDeadline ? new DiscoveryTimeBudget() : new Error("CI发现只读查询超时"); requireTime(); length += part.byteLength; responseBytes += part.byteLength; assert(length <= limit && responseBytes <= 64 * 1024 * 1024, "CI发现响应超出预算"); chunks.push(Buffer.from(part)); }
      requireTime();
      const body = Buffer.concat(chunks), raw = body.toString("utf8");
      assert(!raw.includes(token) && (!actorSource || !raw.includes(env[actorSource.tokenEnv])), "CI发现响应含凭据，拒绝保存");
      const record = { url: url.href, sha256: createHash("sha256").update(body).digest("hex"), ...(xml ? { rawOmitted: "controlled-job-configuration" } : { raw }) };
      responses.push(record);
      if (xml) return { body, response };
      let value; try { value = JSON.parse(raw); } catch { throw new Error("CI发现来源未返回有效JSON"); }
      return { value, response };
    };
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; controller.abort(); reject(overallDeadline ? new DiscoveryTimeBudget() : new Error("CI发现只读查询超时")); }, requestMs); });
    try { return await Promise.race([operation(), timeout]); }
    catch (error) { if (error.code === "CI_DISCOVERY_TIME_BUDGET" || error.message === "CI发现只读查询超时") throw error; throw new Error(error.message?.startsWith("CI") ? error.message : "CI发现只读连接失败"); }
    finally { clearTimeout(timer); }
  };
  const owner = (sourceUserId, authenticated) => ({ authorId: authenticated && actorMap.has(String(sourceUserId)) ? actorMap.get(String(sourceUserId)) : null,
    actorSource: { system: config.system, userId: sourceUserId === null ? null : String(sourceUserId), authenticated, mapped: authenticated && actorMap.has(String(sourceUserId)) } });
  const mergedCommitOwner = async (sha) => {
    const base = `/api/v4/projects/${actorSource.projectId}`, candidates = [];
    for (let page = 1; ; page++) {
      assert(page <= maxPages, "上游MR作者关联分页超出预算");
      const response = await get(`${base}/repository/commits/${sha}/merge_requests?per_page=100&page=${page}`, { actorLookup: true });
      assert(Array.isArray(response.value), "上游提交关联MR响应无效");
      candidates.push(...response.value.filter((mr) => mr.state === "merged" && [mr.merge_commit_sha, mr.squash_commit_sha].includes(sha) && Number(mr.project_id) === Number(actorSource.projectId) && (mr.target_project_id === undefined || Number(mr.target_project_id) === Number(actorSource.projectId)) && mr.target_branch === actorSource.ref));
      const next = response.response.headers.get("x-next-page"); if (!next && response.value.length < 100) break; if (next) assert(next === String(page + 1), "上游MR关联分页顺序无效");
    }
    if (candidates.length !== 1) return { authorId: null, actorSource: { system: "gitlab", authenticated: false, mapped: false, userId: null, mechanism: "merged-commit-association", reason: "no-unique-merged-commit-association" } };
    const listed = candidates[0]; assert(positive(listed.iid) && positive(listed.id), "上游关联MR编号无效");
    const detail = async () => (await get(`${base}/merge_requests/${listed.iid}`, { actorLookup: true })).value;
    const mr = await detail(), valid = (v) => Number(v.id) === Number(listed.id) && Number(v.iid) === Number(listed.iid) && Number(v.project_id) === Number(actorSource.projectId) && (v.target_project_id === undefined || Number(v.target_project_id) === Number(actorSource.projectId)) && v.state === "merged" && v.target_branch === actorSource.ref && [v.merge_commit_sha, v.squash_commit_sha].includes(sha) && positive(v.author?.id);
    assert(valid(mr) && Number(mr.author.id) === Number(listed.author?.id), "上游实际MR作者/合并SHA/目标分支关联不匹配");
    const facts = (v) => ({ id: v.id, iid: v.iid, projectId: v.project_id, state: v.state, targetBranch: v.target_branch, mergeSha: v.merge_commit_sha, squashSha: v.squash_commit_sha, authorId: v.author?.id });
    const final = await detail(); assert(valid(final) && digest(facts(final)) === digest(facts(mr)), "上游MR作者/合并关系在发现期间改变");
    const mappingKey = `gitlab:${mr.author.id}`;
    return { authorId: actorMap.get(mappingKey) || null, actorSource: { system: "gitlab", authenticated: true, mapped: actorMap.has(mappingKey), userId: String(mr.author.id), mappingKey, mechanism: "merged-commit-association", projectId: Number(actorSource.projectId), mergeRequestId: Number(mr.id), mergeRequestIid: Number(mr.iid), targetRef: actorSource.ref, sha, associationHash: digest(facts(final)) } };
  };
  const link = (value) => { const url = new URL(value); assert(url.origin === config.baseUrl && url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash, "CI发现运行链接不属于固定来源"); return url.href; };
  const timestamp = (value) => { assert(iso(value) && Date.parse(value) <= Number(now), "CI发现运行创建时间无效或来自未来"); return new Date(value).toISOString(); };
  const push = (run) => {
    if (Date.parse(run.occurredAt) < Date.parse(since)) return;
    assert(!seen.has(run.runId), "CI发现列表包含重复运行编号"); seen.add(run.runId);
    runs.push({ ...run, dueAt: new Date(Date.parse(run.occurredAt) + dueAfterMinutes * 60000).toISOString(),
      status: run.authorId === null ? "unmapped-actor" : run.missingJobs.length ? "incomplete" : run.status });
  };
  let activePage = cursor?.page ?? (config.system === "gitlab" ? 1 : 0), activeOffset = cursor?.offset || 0, jenkinsFinalCheck = false;
  const initialPage = activePage, initialOffset = activeOffset;
  try {
  if (config.system === "gitlab") {
    const base = `/api/v4/projects/${config.projectId}`;
    const processed = new Set();
    const inspect = async (runId, recheck = false) => {
      if (processed.has(runId)) return; requireTime(); processed.add(runId); highWatermarkRunId=Math.max(highWatermarkRunId,runId);
let pipelineUrl;
        try {
          const pipeline = (await get(`${base}/pipelines/${runId}`, { onAttempt: recheck ? () => attemptedRecheckRunIds.push(runId) : undefined })).value;
          pipelineUrl = link(pipeline.web_url);
          assert(Number(pipeline.id) === runId && Number(pipeline.project_id) === Number(config.projectId) && pipeline.ref === config.ref && SHA.test(pipeline.sha || "") && gitlabStates.has(pipeline.status), "GitLab发现实际流水线身份/SHA/ref/状态不匹配");
          const occurredAt = timestamp(pipeline.created_at); if (Date.parse(occurredAt) < Date.parse(since)) return;
          const fetchJobs = async () => { const jobs = []; let jobPage = 1;
          while (true) {
            assert(jobPage <= maxPages, "GitLab发现作业分页超出预算");
            const batch = await get(`${base}/pipelines/${runId}/jobs?include_retried=false&per_page=${pageSize}&page=${jobPage}`);
            assert(Array.isArray(batch.value), "GitLab发现作业清单无效"); jobs.push(...batch.value);
            const next = batch.response.headers.get("x-next-page"); if (!next && batch.value.length < pageSize) break; if (next) assert(next === String(jobPage + 1), "GitLab发现作业分页顺序无效"); jobPage++;
          }
          return jobs; };
          const jobs = await fetchJobs();
          const missingJobs = [], requiredJobs = [], issues = [];
          for (const name of config.requiredJobs) {
            const matches = jobs.filter((job) => job.name === name);
            if (matches.length !== 1) { missingJobs.push(name); issues.push({ job: name, reason: matches.length ? "duplicate-job" : "not-created" }); continue; }
            const job = matches[0], valid = positive(job.id) && Number(job.pipeline?.id) === runId && job.commit?.id === pipeline.sha && job.ref === config.ref && job.allow_failure === false && gitlabStates.has(job.status)
              && (!new Set(["success", "failed"]).has(job.status) || config.trustedRunnerIds.map(String).includes(String(job.runner?.id)));
            if (!valid) { missingJobs.push(name); issues.push({ job: name, reason: "job-identity-or-trust-invalid" }); }
            requiredJobs.push({ id: Number(job.id), name, status: job.status, trusted: valid });
          }
          const userId = positive(pipeline.user?.id) ? String(pipeline.user.id) : null, actor = owner(userId, userId !== null);
          const facts = (rows) => rows.filter((job) => config.requiredJobs.includes(job.name)).map((job) => ({ id: job.id, name: job.name, status: job.status, allow_failure: job.allow_failure, runnerId: job.runner?.id ?? null,
            sha: job.commit?.id ?? null, pipelineId: job.pipeline?.id ?? null, ref: job.ref, erasedAt: job.erased_at ?? null, finishedAt: job.finished_at ?? null })).sort((a, b) => Number(a.id) - Number(b.id));
          const finalJobs = await fetchJobs(), final = (await get(`${base}/pipelines/${runId}`)).value;
          const pipelineFacts = (value) => ({ id: value.id, projectId: value.project_id, sha: value.sha, ref: value.ref, status: value.status, userId: value.user?.id ?? null, createdAt: value.created_at, webUrl: value.web_url });
          assert(digest(facts(jobs)) === digest(facts(finalJobs)) && digest(pipelineFacts(pipeline)) === digest(pipelineFacts(final)), "GitLab发现期间必需作业/流水线事实改变，等待下次稳定发现");
          push({ runId, sha: pipeline.sha, ref: pipeline.ref, occurredAt, pipelineUrl, ...actor,
            terminal: terminalStates.has(pipeline.status), missingJobs, status: pipeline.status, sourceStatus: pipeline.status, requiredJobs, issues,
            observedRevision: digest({ run: pipelineFacts(final), jobs: facts(finalJobs) }) });
        } catch (error) { if (error.code === "CI_DISCOVERY_TIME_BUDGET") throw error; discoveryErrors.push({ runId, ...(pipelineUrl ? { pipelineUrl } : {}), reason: error.message }); }
    };
    for (const value of recheckRunIds) await inspect(Number(value), true);
    let page = cursor?.page || 1, offset = cursor?.offset || 0, pages = 0;
    while (true) {
      activePage = page; activeOffset = offset; requireTime();
      if (pages >= maxPages || listedRuns >= maxRuns) { resumeAt(page,offset); break; } pages++;
      const query = new URLSearchParams({ ref: config.ref, created_after: new Date(since).toISOString(), updated_after: new Date(windowStart).toISOString(), order_by: "id", sort: "asc", per_page: String(pageSize), page: String(page) });
      const listed = await get(`${base}/pipelines?${query}`); assert(Array.isArray(listed.value), "GitLab流水线发现清单无效");
      for (let index=offset; index<listed.value.length; index++) {
        if (listedRuns >= maxRuns) { resumeAt(page,index); break; }
        activePage = page; activeOffset = index; requireTime();
        const row=listed.value[index]; assert(positive(row?.id), "GitLab发现清单运行ID无效"); listedRuns++; await inspect(Number(row.id)); activeOffset = index + 1;
      }
      if (partial) break;
      const next = listed.response.headers.get("x-next-page"); if (!next && listed.value.length < pageSize) break; if (next) assert(next === String(page + 1), "GitLab流水线发现分页顺序无效"); page++; offset=0;
    }
  } else {
    const jobPath = config.jobPath.split("/").map((part) => `job/${encodeURIComponent(part)}`).join("/");
    const xml = await get(`/${jobPath}/config.xml`, { xml: true });
    assert(createHash("sha256").update(xml.body).digest("hex") === config.jobConfigHash, "Jenkins发现作业配置与批准摘要不一致");
    const processed = new Set();
    const inspect = async (runId, listedTimestamp, recheck = false) => {
      if(processed.has(runId)) return; requireTime(); processed.add(runId); highWatermarkRunId=Math.max(highWatermarkRunId,runId);
        let pipelineUrl;
        try {
          const buildPath = `/${jobPath}/${runId}/`, build = (await get(`${buildPath}api/json`, { onAttempt: recheck ? () => attemptedRecheckRunIds.push(runId) : undefined })).value;
          assert(Number(build.number) === runId && typeof build.building === "boolean" && Number.isSafeInteger(build.timestamp) && (listedTimestamp === undefined || build.timestamp === listedTimestamp), "Jenkins发现真实构建身份/时间不匹配");
          pipelineUrl = build.url ? link(build.url) : new URL(buildPath, config.baseUrl).href;
          const occurredAt = timestamp(new Date(build.timestamp).toISOString());
          const revisions = [...new Set((build.actions || []).map((action) => action.lastBuiltRevision?.SHA1).filter(Boolean))];
          assert(revisions.length === 1 && SHA.test(revisions[0]), "Jenkins发现缺少唯一真实SCM revision"); const sha = revisions[0];
          const branches = (build.actions || []).flatMap((action) => action.lastBuiltRevision?.branch || []).filter((branch) => branch.SHA1 === sha).map((branch) => branch.name);
          if (!branches.includes(config.ref)) return;
          const states = { SUCCESS: "success", FAILURE: "failed", UNSTABLE: "failed", ABORTED: "canceled", NOT_BUILT: "skipped" };
          const status = build.building ? "running" : states[build.result]; assert(status, "Jenkins发现构建状态未知");
          const causes = (build.actions || []).flatMap((action) => action.causes || []).filter((cause) => cause._class === "hudson.model.Cause$UserIdCause" && typeof cause.userId === "string" && cause.userId);
          const users = [...new Set(causes.map((cause) => cause.userId))], userId = users.length === 1 ? users[0] : null;
          const actor = userId === null && actorSource ? await mergedCommitOwner(sha) : owner(userId, userId !== null);
          const final = (await get(`${buildPath}api/json`)).value;
          const facts = (value) => ({ number: value.number, timestamp: value.timestamp, building: value.building, result: value.result, actions: value.actions, artifacts: value.artifacts, url: value.url ?? null });
          assert(digest(facts(build)) === digest(facts(final)), "Jenkins发现期间构建事实改变，等待下次稳定发现");
          push({ runId, sha, ref: config.ref, occurredAt, pipelineUrl, ...actor,
            terminal: !build.building, missingJobs: [], status, sourceStatus: status, requiredJobs: [{ id: runId, name: config.jobPath, status, trusted: true }], issues: actor.authorId === null ? [{ reason: actor.actorSource.reason || "no-unique-authenticated-author" }] : [],
            observedRevision: digest({ build: facts(final), configHash: config.jobConfigHash, actorSource: actor.actorSource }) });
        } catch (error) { if (error.code === "CI_DISCOVERY_TIME_BUDGET") throw error; discoveryErrors.push({ runId, ...(pipelineUrl ? { pipelineUrl } : {}), reason: error.message }); }
    };
    for (const value of recheckRunIds) await inspect(Number(value), undefined, true);
    let page = cursor?.page || 0, offset = cursor?.offset || 0, stop = false, pages=0;
    while (!stop) {
      activePage = page; activeOffset = offset; requireTime();
      if(pages >= maxPages || listedRuns >= maxRuns) {resumeAt(page,offset);break;} pages++;
      const start=page*pageSize, query=new URLSearchParams({tree:`builds[number,timestamp]{${start},${start+pageSize}}`});
      const listed=(await get(`/${jobPath}/api/json?${query}`)).value; assert(Array.isArray(listed.builds), "Jenkins发现构建清单无效");
      for(let index=offset;index<listed.builds.length;index++) {
        activePage = page; activeOffset = index; requireTime();
        const row=listed.builds[index];assert(positive(row?.number)&&Number.isSafeInteger(row.timestamp),"Jenkins发现清单运行ID/时间无效");
        if(row.timestamp<Date.parse(since)||Number(row.number)<=lowerRunId){stop=true;break;}
        if(listedRuns>=maxRuns){resumeAt(page,index);break;} listedRuns++; await inspect(Number(row.number),row.timestamp); activeOffset = index + 1;
      }
      if(partial)break;
      if(listed.builds.length<pageSize)stop=true; page++;offset=0;
    }
    jenkinsFinalCheck = true;
    const final = await get(`/${jobPath}/config.xml`, { xml: true });
    assert(createHash("sha256").update(final.body).digest("hex") === config.jobConfigHash, "Jenkins发现期间作业配置变化");
  }
  } catch (error) {
    if (error.code !== "CI_DISCOVERY_TIME_BUDGET") throw error;
    if (jenkinsFinalCheck) { runs.length = 0; activePage = initialPage; activeOffset = initialOffset; }
    resumeAt(activePage, activeOffset);
  }
  return { runs: runs.sort((a, b) => a.runId - b.runId), responses, discoveryErrors, attemptedRecheckRunIds, durationBudgetMs: maxDurationMs, durationMs: Math.max(0, monotonicNow() - startedMonotonic), complete: !partial && discoveryErrors.length === 0, windowComplete: !partial, partial, nextCursor, watermark: !partial ? scanStartedAt : null, highWatermarkRunId,
    system: config.system, project: config.project, scope: config.scope, ref: config.ref, since: new Date(since).toISOString(), observedAt: new Date(now).toISOString() };
}
