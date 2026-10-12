import path from "node:path";
import { fileURLToPath } from "node:url";
import { exists, readJson } from "./util.js";

export const DEFAULT_SCHEMA_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "schemas",
  "quality-summary.schema.json"
);

function typeMatches(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    switch (t) {
      case "object":
        return value && typeof value === "object" && !Array.isArray(value);
      case "array":
        return Array.isArray(value);
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "boolean":
        return typeof value === "boolean";
      case "null":
        return value === null;
      default:
        return false;
    }
  });
}

export function validateSummaryAgainstSchema(value, schema, pathExpr = "$", errors = []) {
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${pathExpr}: const 不满足（期望 ${JSON.stringify(schema.const)}，实际 ${JSON.stringify(value)}）`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${pathExpr}: 不在枚举 ${JSON.stringify(schema.enum)} 内（实际 ${JSON.stringify(value)}）`);
  }
  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    errors.push(`${pathExpr}: 类型不匹配（期望 ${JSON.stringify(schema.type)}，实际 ${typeof value}）`);
    return errors;
  }
  if (Array.isArray(schema.required) && value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required) {
      if (!(key in value)) errors.push(`${pathExpr}: 缺少必填字段 ${key}`);
    }
  }
  if (schema.properties && value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) validateSummaryAgainstSchema(value[key], sub, `${pathExpr}.${key}`, errors);
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((item, i) => validateSummaryAgainstSchema(item, schema.items, `${pathExpr}[${i}]`, errors));
  }
  return errors;
}

export function validateReportFile(file, schemaFile = DEFAULT_SCHEMA_FILE) {
  if (!exists(file)) return { ok: false, errors: [`报告不存在: ${file}`] };
  if (!exists(schemaFile)) return { ok: false, errors: [`schema 不存在: ${schemaFile}`] };
  let summary;
  try {
    summary = readJson(file);
  } catch (e) {
    return { ok: false, errors: [`报告无法解析: ${e.message}`] };
  }
  const errors = validateSummaryAgainstSchema(summary, readJson(schemaFile));
  return { ok: errors.length === 0, errors };
}
