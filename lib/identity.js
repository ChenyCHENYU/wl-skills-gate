import { createPublicKey, verify, randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { controlledPath } from "./control-store.js";
const assert = (value, message) => { if (!value) throw new Error(message); };
export function validateIdentityConfig(config) {
  assert(config && ["EdDSA", "RS256"].includes(config.algorithm), "身份校验必须固定 EdDSA/RS256 算法");
  for (const name of ["issuer", "authorizationEndpoint", "tokenEndpoint"]) {
    const u = new URL(config[name]); assert(u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash, "身份提供方必须固定HTTPS地址");
  }
  assert(typeof config.clientId === "string" && config.clientId && typeof config.keyId === "string" && config.keyId, "身份 clientId/keyId 缺失");
  assert(config.subjects && Object.keys(config.subjects).length && Object.values(config.subjects).every((v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)), "必须把已认证sub映射到固定员工编号");
  const key = createPublicKey(readFileSync(controlledPath(config.publicKeyFile)));
  assert(config.algorithm === "EdDSA" ? key.asymmetricKeyType === "ed25519" : key.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails?.modulusLength >= 2048, "身份公钥/算法不符");
  if (config.clientSecretEnv !== undefined) assert(/^[A-Z][A-Z0-9_]+$/.test(config.clientSecretEnv), "身份客户端密钥必须来自环境变量");
  return config;
}
export function verifyIdentityToken(token, config, { now = Date.now(), nonce, maxAgeSeconds = 3600 } = {}) {
  assert(typeof token === "string" && token.length <= 16384, "身份令牌缺失或过长");
  const parts = token.split("."); assert(parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)), "身份令牌编码无效");
  let header, payload;
  try { header = JSON.parse(Buffer.from(parts[0], "base64url")); payload = JSON.parse(Buffer.from(parts[1], "base64url")); } catch { throw new Error("身份令牌JSON无效"); }
  assert(header.alg === config.algorithm && header.kid === config.keyId && !header.crit && !header.jku && !header.jwk && !header.x5u, "身份令牌算法/固定密钥不匹配");
  const key = createPublicKey(readFileSync(controlledPath(config.publicKeyFile)));
  assert(verify(config.algorithm === "EdDSA" ? null : "RSA-SHA256", Buffer.from(parts.slice(0, 2).join(".")), key, Buffer.from(parts[2], "base64url")), "身份令牌签名无效");
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud], seconds = Math.floor(now / 1000);
  assert(payload.iss === config.issuer && audiences.includes(config.clientId) && (audiences.length === 1 || payload.azp === config.clientId), "身份issuer/audience不匹配");
  assert(Number.isSafeInteger(payload.exp) && Number.isSafeInteger(payload.iat) && payload.exp > seconds && payload.iat <= seconds + 30 && payload.iat >= seconds - maxAgeSeconds && payload.exp > payload.iat && (!payload.nbf || Number.isSafeInteger(payload.nbf) && payload.nbf <= seconds + 30), "身份令牌过期/来自未来");
  if (nonce !== undefined) assert(payload.nonce === nonce, "身份nonce不匹配");
  assert(typeof payload.sub === "string" && Object.hasOwn(config.subjects, payload.sub), "身份未登记，不能自报actorId");
  return { actorId: config.subjects[payload.sub], subject: payload.sub, expiresAt: payload.exp * 1000, identitySource: config.issuer };
}
export function createIdentityLogin(config, { redirectUri, now = Date.now() }) {
  const verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("base64url"), nonce = randomBytes(32).toString("base64url");
  const url = new URL(config.authorizationEndpoint);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: config.clientId, redirect_uri: redirectUri, scope: "openid", state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") })) url.searchParams.set(key, value);
  return { url: url.href, state, nonce, verifier, expiresAt: now + 300000 };
}
export async function exchangeIdentityCode(config, { code, login, redirectUri, env = process.env, fetchImpl = fetch, now = Date.now() }) {
  assert(typeof code === "string" && code.length > 0 && code.length < 4096 && login.expiresAt > now, "身份授权码/登录会话失效");
  const form = new URLSearchParams({ grant_type: "authorization_code", client_id: config.clientId, code, redirect_uri: redirectUri, code_verifier: login.verifier });
  if (config.clientSecretEnv) { assert(env[config.clientSecretEnv], "缺少身份客户端密钥"); form.set("client_secret", env[config.clientSecretEnv]); }
  let response;
  try { response = await fetchImpl(config.tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(), redirect: "error", signal: AbortSignal.timeout(10000) }); } catch { throw new Error("身份服务连接失败"); }
  assert(response.ok && (!response.url || response.url === config.tokenEndpoint), "身份服务拒绝授权码");
  let text = "";
  if (response.body) for await (const part of response.body) { text += Buffer.from(part).toString("utf8"); assert(Buffer.byteLength(text) <= 32768, "身份响应超出预算"); }
  let data; try { data = JSON.parse(text); } catch { throw new Error("身份服务响应无效"); }
  return verifyIdentityToken(data.id_token, config, { nonce: login.nonce, now });
}
