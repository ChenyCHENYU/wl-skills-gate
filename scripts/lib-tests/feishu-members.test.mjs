import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchFeishuMembers, matchFeishuNames } from "../../lib/feishu-members.js";
const settings = { appId: "cli_testapp", appSecret: "test-secret-not-real", chatId: "oc_testchat" };
const reply = (data) => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) });
test("一次读取指定群全部分页，返回姓名/ID且不泄露令牌或猜测同名人员", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return { ok: true, json: async () => ({ code: 0, tenant_access_token: "token-not-real" }) };
    return reply(calls.length === 2 ? { items: [{ member_id: "ou_one", member_id_type: "open_id", name: "同名甲" }], has_more: true, page_token: "page-two" } :
      { items: [{ member_id: "ou_two", member_id_type: "open_id", name: "同名甲" }, { member_id: "ou_three", member_id_type: "open_id", name: "经理乙" }], has_more: false });
  };
  const directory = await fetchFeishuMembers({ ...settings, fetchImpl });
  assert.equal(directory.complete, true); assert.equal(directory.count, 3); assert.equal(directory.appId, settings.appId);
  assert.equal(new URL(calls[2].url).searchParams.get("page_token"), "page-two");
  assert(calls.slice(1).every((call) => call.options.method === "GET"));
  assert(!JSON.stringify(directory).includes(settings.appSecret)); assert(!JSON.stringify(directory).includes("token-not-real"));
  assert.deepEqual(matchFeishuNames(["同名甲", "经理乙", "未入群"], directory).map((match) => match.status), ["ambiguous", "matched", "missing"]);
});
test("成员读取遇权限失败、残缺响应和分页循环均拒绝导出完整清单", async () => {
  for (const mode of ["denied", "incomplete", "loop"]) {
    let count = 0;
    const fetchImpl = async () => {
      if (++count === 1) return { ok: true, json: async () => ({ code: 0, tenant_access_token: "token-not-real" }) };
      if (mode === "denied") return { ok: true, json: async () => ({ code: 99991672, msg: "arbitrary-provider-message" }) };
      return reply(mode === "incomplete" ? { items: [] } : { items: [], has_more: true, page_token: "same" });
    };
    await assert.rejects(fetchFeishuMembers({ ...settings, fetchImpl }), /飞书接口拒绝|响应不完整|分页无有效进展/);
  }
});
