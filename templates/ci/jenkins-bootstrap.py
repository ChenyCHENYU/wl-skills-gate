"""Node-independent Jenkins preflight and infrastructure failure notification.
Embedded into protected Pipeline definitions by jenkins-bootstrap.js. No packages.
"""
import base64
import datetime
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def version_ok(value):
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", value.strip())
    if not match:
        return False
    major, minor, _ = map(int, match.groups())
    return major == 22 and minor >= 13 or major >= 24


def execute_version(program):
    try:
        result = subprocess.run([program, "--version"], capture_output=True, text=True, timeout=10)
        return result.stdout.strip() if result.returncode == 0 else "unavailable"
    except (OSError, subprocess.SubprocessError):
        return "unavailable"


def preflight(env):
    checks = []

    def check(name, passed, detail, advice):
        checks.append(dict(name=name, status="passed" if passed else "blocked", detail=detail, advice=advice))

    mode = env.get("WL_BOOTSTRAP_MODE", "job")
    for program in (["git", "node"] if mode in ("job", "node") else ["node"]):
        check(program, bool(shutil.which(program)), "命令已找到" if shutil.which(program) else "命令不在 PATH 中",
              "在实际执行节点安装工具；Node 路径通过受控变量 WL_NODE_BIN_DIR 配置。")
    node_version = execute_version("node") if shutil.which("node") else "missing"
    check("node-version", version_ok(node_version), node_version, "需要 Node 22.13+（22 系列）或 24+。")
    root = Path(env.get("WL_BOOTSTRAP_GATE_ROOT", "/opt/wl-quality/gate-validation/node_modules/@agile-team/wl-skills-gate"))
    valid_root = root.is_absolute() and root.is_dir()
    check("gate-root", valid_root, "固定 Gate 目录可读取" if valid_root else "固定 Gate 目录不存在或不可读取",
          "在该Jenkins节点运行本包的接入Jenkins脚本；使用安装回执中的 gateHome。包内入口为 bin/wl-skills-gate.js。")
    expected = env.get("WL_BOOTSTRAP_GATE_VERSION", "0.13.2")
    try:
        package = json.loads((root / "package.json").read_text())
        correct = package.get("name") == "@agile-team/wl-skills-gate" and package.get("version") == expected
    except (OSError, ValueError):
        correct = False
    check("gate-version", correct, "固定包版本匹配" if correct else "包缺失、不可读或版本不匹配",
          "使用接入包随附的固定 tgz 安装；完整字节摘要由后续 Gate 登记与运行时核验。")
    for relative in ("bin/wl-skills-gate.js", "templates/ci/jenkins-gate.groovy"):
        file = root / relative
        check("gate-file:" + relative, file.is_file() and os.access(file, os.R_OK),
              "入口可读取" if file.is_file() and os.access(file, os.R_OK) else "入口缺失或不可读",
              "重新安装完整 Gate 包，勿创建 gate-cli 或 approve-build.sh 替代真实入口。")
    expected_runtime = env.get("WL_BOOTSTRAP_RUNTIME_HASH", "")
    if expected_runtime:
        actual_runtime = "unavailable"
        try:
            if not re.fullmatch(r"[a-f0-9]{64}", expected_runtime):
                raise ValueError("invalid runtime pin")
            files = {}
            for name in ("package.json", "npm-shrinkwrap.json", "bin", "lib", "templates", "schemas", "assets", "scripts"):
                entry = root / name
                candidates = sorted(entry.rglob("*")) if entry.is_dir() else [entry]
                if entry.is_symlink():
                    raise ValueError("runtime symlink")
                for item in candidates:
                    if item.is_symlink():
                        raise ValueError("runtime symlink")
                    if item.is_dir():
                        continue
                    if not item.is_file():
                        raise ValueError("runtime file missing")
                    files[item.relative_to(root).as_posix()] = hashlib.sha256(item.read_bytes()).hexdigest()
            encoded = json.dumps(files, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
            actual_runtime = hashlib.sha256(encoded).hexdigest()
        except (OSError, ValueError):
            pass
        check("gate-runtime", actual_runtime == expected_runtime, "固定包字节匹配" if actual_runtime == expected_runtime else "包文件缺失或发生漂移",
              "重新部署同一固定快照；自检通过前不加载执行节点上的Gate脚本。")
    required = []
    if mode in ("job", "verify"):
        required.append(("registry", env.get("WL_BOOTSTRAP_REGISTRY", "")))
    elif mode == "automation":
        required.append(("automation-config", env.get("WL_CENTRAL_AUTOMATION_CONFIG", "")))
    elif mode == "review":
        required.append(("review-config", env.get("WL_REVIEW_PUBLISH_CONFIG", "")))
    for role, value in required:
        file = Path(value) if value else None
        ok = bool(file and file.is_absolute() and file.is_file() and os.access(file, os.R_OK))
        check(role, ok, "受控配置可读取" if ok else "受控配置未配置、缺失或不可读", "配置工作区外的绝对路径，再重试；此自检不授予构建或签发权限。")
    return dict(schemaVersion=1, kind="wl-jenkins-node-preflight", status="ready" if all(c["status"] == "passed" for c in checks) else "blocked",
                checkedAt=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S"),
                mode=mode, job=env.get("JOB_NAME", "unknown"), buildNumber=env.get("BUILD_NUMBER", "unknown"),
                nodeVersion=node_version, checks=checks, qualityPassed=False, buildAuthorized=False)


def card(report, env):
    if env.get("WL_BOOTSTRAP_ACTION") == "notify-test":
        return {"msg_type": "interactive", "card": {"schema": "2.0", "header": {"template": "blue", "title": {"tag": "plain_text", "content": "流水线机器人 · 连通测试"}}, "body": {"elements": [
            {"tag": "div", "text": {"tag": "plain_text", "content": "测试：" + env.get("JOB_NAME", "unknown") + " · #" + env.get("BUILD_NUMBER", "unknown")}},
            {"tag": "div", "text": {"tag": "plain_text", "content": "机器人签名消息已到群；请核对群与机器人名称。", "text_color": "blue"}},
            {"tag": "div", "text": {"tag": "plain_text", "content": "仅验证通知连通，不执行代码检查、构建、部署或签发，不表示质量通过。"}}
        ]}}}
    blocked = [c for c in report.get("checks", []) if c.get("status") == "blocked"]
    reason = "；".join(c["name"] + "：" + c["detail"] for c in blocked[:3]) if blocked else "执行阶段失败，具体原因见 Jenkins 控制台与归档记录。"
    advice = "完成节点工具安装及路径配置后重跑自检；本次未通过不授予构建、部署或 Review 签发权限。" if blocked else "按本次日志修复失败阶段，再重新执行检查；修复后须保留新的运行记录。"
    content = "任务：" + env.get("JOB_NAME", "unknown") + " · #" + env.get("BUILD_NUMBER", "unknown")
    elements = [
        {"tag": "div", "text": {"tag": "plain_text", "content": content}},
        {"tag": "div", "text": {"tag": "plain_text", "content": "结论：本次执行失败，后续阶段停止", "text_color": "red"}},
        {"tag": "div", "text": {"tag": "plain_text", "content": reason, "text_color": "orange"}},
        {"tag": "div", "text": {"tag": "plain_text", "content": "处理：" + advice, "text_color": "blue"}},
        {"tag": "div", "text": {"tag": "plain_text", "content": "分类：运行环境／执行异常；不属于四类代码问题计数。"}},
    ]
    url = env.get("BUILD_URL", "")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password:
        elements.append({"tag": "markdown", "content": "[查看本次 Jenkins 记录](" + url.replace(")", "%29") + ")"})
    return {"msg_type": "interactive", "card": {"schema": "2.0", "header": {"template": "red", "title": {"tag": "plain_text", "content": "流水线执行异常 · 需处理"}}, "body": {"elements": elements}}}


def notify(report, env, opener=None, now=None):
    # These two credentials are bound only in post-failure, never while running source.
    webhook, secret = env.get("WL_FEISHU_CI_WEBHOOK", ""), env.get("WL_FEISHU_CI_SECRET", "")
    parsed = urllib.parse.urlparse(webhook)
    if parsed.scheme != "https" or parsed.hostname != "open.feishu.cn" or parsed.port or parsed.username or parsed.password or parsed.query or parsed.fragment or not re.fullmatch(r"/open-apis/bot/v2/hook/[A-Za-z0-9-]+", parsed.path) or not secret:
        return dict(status="not-sent", reason="机器人凭据缺失或地址不符合批准的飞书入口", originalFailurePreserved=True)
    timestamp = str(int(time.time() if now is None else now))
    payload = card(report, env)
    payload.update(timestamp=timestamp, sign=base64.b64encode(hmac.new((timestamp + "\n" + secret).encode(), b"", hashlib.sha256).digest()).decode())
    request = urllib.request.Request(webhook, data=json.dumps(payload, ensure_ascii=False).encode(), headers={"Content-Type": "application/json"}, method="POST")
    # No retry after an unknown outcome: a timeout may still mean Feishu accepted it.
    try:
        client = opener or urllib.request.build_opener(NoRedirect())
        with client.open(request, timeout=10) as response:
            raw = response.read(65537)
            if len(raw) > 65536:
                return dict(status="unknown", reason="响应超出校验上限", originalFailurePreserved=True)
            result = json.loads(raw)
            ok = response.status == 200 and isinstance(result, dict) and any(type(result.get(key)) is int and result[key] == 0 for key in ("code", "StatusCode"))
            return dict(status="sent" if ok else "rejected", reason="飞书已确认接收" if ok else "飞书未确认接收；检查机器人安全设置", originalFailurePreserved=True)
    except urllib.error.HTTPError:
        return dict(status="rejected", reason="飞书返回 HTTP 错误；未自动重试", originalFailurePreserved=True)
    except (OSError, ValueError, TimeoutError):
        return dict(status="unknown", reason="超时、网络或响应异常；先核对群消息再决定是否补发", originalFailurePreserved=True)


def main():
    env = os.environ
    run = re.sub(r"[^A-Za-z0-9_-]", "_", env.get("BUILD_NUMBER", "local"))
    directory = Path(".wl-gate-bootstrap")
    if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
        print("阻断：自检目录不是受控真实目录，不写入或读取外部文件。")
        return 2
    directory.mkdir(mode=0o700, exist_ok=True)
    filename = directory / (run + "-preflight.json")
    if filename.is_symlink() or (directory / (run + "-notice.json")).is_symlink():
        print("阻断：本轮自检文件是符号链接，不读取、写入或推送。")
        return 2
    if env.get("WL_BOOTSTRAP_ACTION") in ("notify", "notify-test"):
        try:
            report = json.loads(filename.read_text())
        except (OSError, ValueError):
            report = {"checks": []}
        receipt = notify(report, env)
        (directory / (run + "-notice.json")).write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
        print("飞书通知：" + receipt["status"] + "；" + receipt["reason"])
        return 0 if receipt["status"] == "sent" else 3
    report = preflight(env)
    filename.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    for check in report["checks"]:
        print(("通过" if check["status"] == "passed" else "阻断") + " | " + check["name"] + " | " + check["detail"])
        if check["status"] != "passed":
            print("处理 | " + check["advice"])
    return 0 if report["status"] == "ready" else 2


if __name__ == "__main__":
    sys.exit(main())
