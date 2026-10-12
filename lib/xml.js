// 仅接受完整、无 DTD 的 XML；不支持的格式失败关闭，不猜测测试结果。
function decode(text) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(text)) throw new Error("XML 包含未知或未闭合实体");
  return text.replace(/&([^;]+);/g, (_, entity) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (entity in named) return named[entity];
    const code = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error("XML 字符实体非法");
    return String.fromCodePoint(code);
  });
}

function opening(tag) {
  const match = /^<([A-Za-z_][\w:.-]*)/.exec(tag);
  if (!match) throw new Error("XML 元素名非法");
  let rest = tag.slice(match[0].length).replace(/\/?\s*>$/, "");
  const attrs = Object.create(null);
  while (rest.trim()) {
    const attr = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(rest);
    if (!attr || Object.hasOwn(attrs, attr[1])) throw new Error("XML 属性非法或重复");
    attrs[attr[1]] = decode(attr[2] ?? attr[3]);
    rest = rest.slice(attr[0].length);
  }
  return { name: match[1], attrs, children: [], text: "" };
}

export function parseXml(xml) {
  xml = xml.replace(/^\uFEFF/, "");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml)) throw new Error("XML 包含非法控制字符");
  const token = /<!--[\s\S]*?-->|<\?[^?]*(?:\?(?!>)[^?]*)*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(?:(?:[^<>"']|"[^"<]*"|'[^'<]*')+)>|[^<]+/gy;
  const stack = [];
  let root = null;
  let offset = 0;
  while (offset < xml.length) {
    token.lastIndex = offset;
    const m = token.exec(xml);
    if (!m) throw new Error(`XML 截断或标签非法（位置 ${offset}）`);
    offset = token.lastIndex;
    const value = m[0];
    if (value.startsWith("<!--")) {
      if (value.slice(4, -3).includes("--")) throw new Error("XML 注释非法");
      continue;
    }
    if (value.startsWith("<?")) {
      if (m.index !== 0 || !/^<\?xml\s+version\s*=\s*(?:"1\.0"|'1\.0')(?:\s+encoding\s*=\s*(?:"UTF-8"|'UTF-8'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>$/i.test(value)) throw new Error("仅支持开头完整的 UTF-8 XML 1.0 声明");
      continue;
    }
    if (value.startsWith("<![CDATA[")) {
      if (!stack.length) throw new Error("CDATA 必须在元素内");
      stack.at(-1).text += value.slice(9, -3);
      continue;
    }
    if (value.startsWith("<!")) throw new Error("不支持 DTD/实体声明");
    if (value.startsWith("</")) {
      const close = /^<\/([A-Za-z_][\w:.-]*)\s*>$/.exec(value);
      if (!close || stack.at(-1)?.name !== close[1]) throw new Error("XML 标签不匹配");
      stack.pop();
      continue;
    }
    if (value.startsWith("<")) {
      const node = opening(value);
      if (stack.length) stack.at(-1).children.push(node);
      else {
        if (root) throw new Error("XML 存在多个根元素");
        root = node;
      }
      if (!/\/\s*>$/.test(value)) stack.push(node);
      if (stack.length > 128) throw new Error("XML 嵌套过深");
      continue;
    }
    if (value.includes("]]>")) throw new Error("XML 文本包含非法 CDATA 结束符");
    if (!stack.length && value.trim()) throw new Error("XML 根元素外存在内容");
    if (stack.length) stack.at(-1).text += decode(value);
  }
  if (!root || stack.length) throw new Error("XML 未完整闭合");
  return root;
}
