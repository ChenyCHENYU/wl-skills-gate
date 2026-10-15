const FLOW_SEQ = /^\[(.*)\]$/;

export class YamlLiteError extends Error {}

function parseScalar(token) {
  const s = token.trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  const bare = s.replace(/\s+#.*$/, "").trim();
  if (bare === "true") return true;
  if (bare === "false") return false;
  if (bare === "null") return null;
  if (/^-?(?:0|[1-9]\d*)$/.test(bare)) {
    const value = Number(bare);
    if (!Number.isSafeInteger(value)) throw new YamlLiteError("yaml-lite: 十进制整数超出安全范围");
    return value;
  }
  return bare;
}

function parseValue(token) {
  const raw = token.trim();
  const isQuoted =
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2);
  const s = isQuoted ? raw : raw.replace(/\s+#.*$/, "").trim();
  const flow = s.match(FLOW_SEQ);
  if (flow) {
    const inner = flow[1].trim();
    if (!inner) return [];
    return inner.split(",").map((part) => parseScalar(part));
  }
  return parseScalar(s);
}

function splitKeyValue(text) {
  const idx = text.indexOf(":");
  if (idx <= 0) throw new YamlLiteError(`yaml-lite: 无法解析的行: ${text}`);
  const key = text.slice(0, idx).trim();
  const rest = text.slice(idx + 1).trim();
  if (!key) throw new YamlLiteError(`yaml-lite: 空键: ${text}`);
  return [key, rest];
}

function parseMaps(lines, start, indent) {
  const map = {};
  let i = start;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.indent < indent) break;
    if (ln.indent > indent) throw new YamlLiteError(`yaml-lite: 不支持的缩进: ${ln.text}`);
    if (ln.text.startsWith("- ")) throw new YamlLiteError(`yaml-lite: 此处不期望列表项: ${ln.text}`);
    const [key, rest] = splitKeyValue(ln.text);
    if (Object.hasOwn(map, key)) throw new YamlLiteError(`yaml-lite: 重复键: ${key}`);
    if (rest === "") {
      const next = lines[i + 1];
      if (next && next.indent > indent && next.text.startsWith("- ")) {
        const r = parseList(lines, i + 1, next.indent);
        map[key] = r.value;
        i = r.next;
      } else if (next && next.indent > indent) {
        const r = parseMaps(lines, i + 1, next.indent);
        map[key] = r.value;
        i = r.next;
      } else {
        map[key] = null;
        i += 1;
      }
    } else {
      map[key] = parseValue(rest);
      i += 1;
    }
  }
  return { value: map, next: i };
}

function parseList(lines, start, dashIndent) {
  const arr = [];
  let i = start;
  while (i < lines.length && lines[i].indent === dashIndent && lines[i].text.startsWith("- ")) {
    const first = lines[i].text.slice(2).trim();
    const itemIndent = dashIndent + 2;
    if (first === "") throw new YamlLiteError("yaml-lite: 空列表项");
    if (!first.includes(":")) {
      arr.push(parseValue(first));
      i += 1;
      continue;
    }
    const item = {};
    const [k, rest] = splitKeyValue(first);
    item[k] = rest === "" ? null : parseValue(rest);
    i += 1;
    while (i < lines.length && lines[i].indent === itemIndent && !lines[i].text.startsWith("- ")) {
      const [k2, rest2] = splitKeyValue(lines[i].text);
      if (Object.hasOwn(item, k2)) throw new YamlLiteError(`yaml-lite: 重复键: ${k2}`);
      item[k2] = rest2 === "" ? null : parseValue(rest2);
      i += 1;
    }
    arr.push(item);
  }
  return { value: arr, next: i };
}

export function parseYamlLite(text) {
  const lines = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.includes("\t")) throw new YamlLiteError("yaml-lite: 请使用空格缩进");
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    lines.push({ indent, text: trimmed });
  }
  if (!lines.length) return {};
  if (lines[0].text.startsWith("- ")) {
    const r = parseList(lines, 0, lines[0].indent);
    if (r.next !== lines.length) throw new YamlLiteError("yaml-lite: 列表后存在无法归属的内容");
    return r.value;
  }
  const r = parseMaps(lines, 0, lines[0].indent);
  if (r.next !== lines.length) throw new YamlLiteError("yaml-lite: 存在无法解析的内容");
  return r.value;
}
