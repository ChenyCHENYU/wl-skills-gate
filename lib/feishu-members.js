// Read one approved group. No message sending, membership mutation or config writes.
export async function fetchFeishuMembers({ appId, appSecret, chatId, fetchImpl = fetch }) {
  if (!/^cli_[A-Za-z0-9]+$/.test(appId || "") || !appSecret || !/^oc_[A-Za-z0-9]+$/.test(chatId || "")) throw new Error("需要应用App ID、App Secret及oc_开头的群ID");
  async function request(url, options) {
    const response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`飞书接口HTTP ${response.status}，未生成成员清单`);
    const result = await response.json();
    if (result.code !== 0) throw new Error(`飞书接口拒绝（code=${Number.isSafeInteger(result.code) ? result.code : "invalid"}）；核对应用发布、只读权限与入群状态`);
    return result;
  }
  const auth = await request("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (typeof auth.tenant_access_token !== "string" || !auth.tenant_access_token) throw new Error("飞书未返回有效应用令牌");
  const members = new Map(), visited = new Set();
  let pageToken = "";
  for (let page = 0; page < 1000; page++) {
    const url = new URL(`https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`);
    url.searchParams.set("member_id_type", "open_id"); url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const result = await request(url.href, { method: "GET", headers: { Authorization: `Bearer ${auth.tenant_access_token}` } });
    const data = result.data;
    if (!data || !Array.isArray(data.items) || typeof data.has_more !== "boolean") throw new Error("群成员响应不完整，禁止将半份名单作为完整结果");
    for (const member of data.items) {
      if (member.member_id_type !== "open_id" || !/^ou_[A-Za-z0-9_-]+$/.test(member.member_id || "") || typeof member.name !== "string" || !member.name.trim()) throw new Error("群成员姓名/ID类型无效，拒绝猜测身份");
      const entry = { name: member.name.trim(), idType: "open_id", id: member.member_id };
      if (members.has(entry.id) && members.get(entry.id).name !== entry.name) throw new Error("群成员在分页期间发生身份信息变化，请重新读取");
      members.set(entry.id, entry);
    }
    if (!data.has_more) return { schemaVersion: 1, kind: "feishu-group-members", appId, chatId, collectedAt: new Date().toISOString(), complete: true, count: members.size, members: [...members.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")) };
    if (typeof data.page_token !== "string" || !data.page_token || visited.has(data.page_token)) throw new Error("群成员分页无有效进展，未导出残缺名单");
    visited.add(data.page_token); pageToken = data.page_token;
  }
  throw new Error("群成员分页超出预算，未导出残缺名单");
}

export function matchFeishuNames(names, directory) {
  if (directory?.complete !== true || !Array.isArray(directory.members)) throw new Error("只允许使用完整群成员清单匹配");
  return [...new Set(names)].map((name) => {
    const matches = directory.members.filter((member) => member.name === name);
    return { name, status: matches.length === 1 ? "matched" : matches.length > 1 ? "ambiguous" : "missing", matches };
  });
}
