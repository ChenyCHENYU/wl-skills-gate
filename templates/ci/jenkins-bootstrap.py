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
import stat
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
    check("gate-root", valid_root, "固定 Gate 目录可读取" if valid_root else "固定 Gate 目录不存在或不可读取：" + str(root),
          "在该Jenkins节点运行本包的接入Jenkins脚本；使用安装回执中的 gateHome。包内入口为 bin/wl-skills-gate.js。")
    expected = env.get("WL_BOOTSTRAP_GATE_VERSION", "0.13.13")
    try:
        package = json.loads((root / "package.json").read_text())
        observed = str(package.get("name")) + "@" + str(package.get("version"))
        correct = package.get("name") == "@agile-team/wl-skills-gate" and package.get("version") == expected
    except (OSError, ValueError):
        observed = "包清单不可读取"
        correct = False
    check("gate-version", correct, "固定包版本匹配" if correct else "需要@agile-team/wl-skills-gate@" + expected + "；实际：" + observed,
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
        check(role, ok, "受控配置可读取" if ok else "受控配置缺失或不可读：" + (value or "未配置路径"), "配置工作区外的绝对路径，再重试；此自检不授予构建或签发权限。")
    return dict(schemaVersion=1, kind="wl-jenkins-node-preflight", status="ready" if all(c["status"] == "passed" for c in checks) else "blocked",
                checkedAt=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S"),
                mode=mode, job=env.get("JOB_NAME", "unknown"), buildNumber=env.get("BUILD_NUMBER", "unknown"),
                nodeVersion=node_version, checks=checks, qualityPassed=False, buildAuthorized=False)


def safe_text(value, env, limit=600):
    text = re.sub(r"[\x00-\x1f\x7f]", " ", str(value or ""))
    for key, secret in env.items():
        if re.search(r"TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTHORIZATION|CREDENTIAL", key, re.I) and isinstance(secret, str) and len(secret) >= 4:
            text = text.replace(secret, "[已隐藏]")
    def url_text(match):
        try:
            url = urllib.parse.urlsplit(match[0])
            return url.scheme + "://" + (url.hostname or "") + ("/[机器人地址已隐藏]" if "/hook/" in match[0] else url.path)
        except ValueError:
            return "[地址已隐藏]"
    text = re.sub(r"https?://[^\s<>)]+", url_text, text)
    text = re.sub(r"\b(?:npm_[A-Za-z0-9]+|Bearer\s+\S+)", "[已隐藏]", text, flags=re.I)
    text = re.sub(r"\b(token|password|secret|authorization)\s*[:=]\s*[^\s;,]+", r"\1=[已隐藏]", text, flags=re.I)
    return text[:limit]


def local_json(file, limit=65536):
    file = Path(file).absolute()
    if any(part.is_symlink() for part in [file, *file.parents]):
        raise ValueError("diagnostic symlink")
    if not stat.S_ISREG(file.lstat().st_mode):
        raise ValueError("diagnostic file type")
    fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit or info.st_nlink != 1:
            raise ValueError("diagnostic file bounds")
        with os.fdopen(fd, "r", encoding="utf-8", closefd=False) as stream:
            return json.loads(stream.read(limit + 1))
    finally:
        os.close(fd)


DIMENSIONS = {"submission": "代码提交", "branch": "分支管理", "coding": "编码规范", "ui": "UI与交互", "review": "Code Review", "tests": "测试规范", "scan": "扫描与质量门禁", "cicd": "CI/CD与发布", "governance": "工程治理"}


def failure_facts(report, env):
    blocked = [c for c in report.get("checks", []) if c.get("status") == "blocked"]
    if blocked:
        return [dict(category="environment", label="节点环境／接入缺项", dimension="cicd", stage="节点环境自检", reason=c.get("name", "自检") + "：" + c.get("detail", "未通过"), action=c.get("advice", "运维补齐该项后重跑节点复验")) for c in blocked]
    try:
        value = local_json(Path("quality-reports/ci-integration") / ("failure-" + env.get("BUILD_NUMBER", "") + ".json"), 16384)
        age = time.time() - datetime.datetime.fromisoformat(value["createdAt"].replace("Z", "+00:00")).timestamp()
        if value.get("kind") == "wl-jenkins-failure" and value.get("job") == env.get("JOB_NAME") and value.get("buildNumber") == env.get("BUILD_NUMBER") and 0 <= age <= 21600 and isinstance(value.get("diagnostics"), list) and value["diagnostics"] and all(isinstance(d, dict) and all(isinstance(d.get(k), str) for k in ("label", "reason", "action", "stage")) for d in value["diagnostics"]):
            return value["diagnostics"][:3]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    stage = env.get("WL_GATE_PHASE", "公共入口／执行阶段")
    message = env.get("WL_GATE_FAILURE_MESSAGE", "")
    if re.search(r"Scripts not permitted|RejectedAccessException|JsonSlurper|No such DSL method.*readJSON", message):
        return [dict(category="sandbox", label="Jenkins沙箱兼容性", dimension="cicd", stage=stage, reason=message,
                     action="增量更新受控公共入口；确认Pipeline Utility Steps插件已启用。新版使用readJSON，不关闭沙箱、不批准旧解析器签名。本轮尚未进入项目检查。")]
    return [dict(category="execution" if message else "diagnostic-missing", label="阶段执行失败" if message else "失败原因记录缺失", dimension="cicd", stage=stage,
                 reason=message or "Jenkins已停止本轮执行，但没有产生可用的具体失败记录；不能判断为代码、Review或Gate接入问题。",
                 action="运维更新受控公共入口后重跑本轮；新入口会归档实际错误。仍缺记录时提供本轮失败阶段原文，不能用旧报告放行。" if not message else "运维与执行人处理上述阶段原始错误后重跑；技术经理核对复检结果，后续构建暂不放行。")]


def failure_people(env):
    config_dir = Path(env.get("WL_GATE_FAILURE_CONFIG_DIR", "/srv/wl-quality/config"))
    config, directory = {}, {}
    if config_dir.is_absolute():
        for filename, kind in (("jenkins-ops.json", "wl-quality-jenkins-ops"), ("ops-responsibility-directory.json", "wl-ops-responsibility-directory")):
            try:
                value = local_json(config_dir / filename, 1048576)
                if isinstance(value, dict) and value.get("kind") == kind:
                    if filename == "jenkins-ops.json":
                        config = value
                    else:
                        directory = value
            except (OSError, ValueError, TypeError):
                pass
    def merged(key):
        a, b = directory.get(key, {}), config.get(key, {})
        return {**(a if isinstance(a, dict) else {}), **(b if isinstance(b, dict) else {})}
    mappings = config.get("jobMappings", {}) if isinstance(config.get("jobMappings"), dict) else {}
    mapping = mappings.get(env.get("JOB_NAME"), {})
    project = (mapping.get("project") if isinstance(mapping, dict) else None) or env.get("WL_GATE_PROJECT", "")
    if not project:
        try:
            registry = env.get("WL_GATE_FAILURE_REGISTRY", "")
            if registry and Path(registry).is_absolute():
                matches = [b for b in local_json(registry, 4194304).get("bindings", []) if env.get("JOB_NAME") in b.get("jobs", {}).values()]
                if len(matches) == 1:
                    project = matches[0]["project"]
        except (OSError, ValueError, KeyError, TypeError):
            pass
    people, owners = merged("people"), merged("owners")
    corrections = directory.get("approvedCorrections", {})
    for actor in corrections.get("people", []):
        if actor in directory.get("people", {}):
            people[actor] = directory["people"][actor]
    for entry in owners.values():
        if isinstance(entry, dict):
            for change in corrections.get("technicalManagers", []):
                if entry.get("technicalManager") == change.get("from"):
                    entry["technicalManager"] = change.get("to")
    owner = owners.get(project, {})
    if not isinstance(owner, dict):
        owner = {"technicalManager": owner}
    trigger_id = env.get("WL_GATE_BUILD_USER_ID") or env.get("BUILD_USER_ID")
    trigger_name = people.get(trigger_id, {}).get("name") or env.get("WL_GATE_BUILD_USER_NAME") or env.get("BUILD_USER") or trigger_id
    public = not project and env.get("JOB_NAME", "").split("/")[-1] in ("wl-quality-doctor", "wl-quality-fleet", "wl-quality-central", "wl-quality-review", "wl-quality-verify")
    executor = next((env.get(k) for k in ("WL_GATE_BUILD_USER_ID", "BUILD_USER_ID", "gitlabUserUsername") if env.get(k) in people), None) or owner.get("executor")
    manager = owner.get("technicalManager")
    def identity(actor):
        p = people.get(actor, {})
        f = p.get("feishu", {}) if isinstance(p, dict) else {}
        value = f.get("id", "") if isinstance(f, dict) else ""
        return value if isinstance(value, str) and f.get("idType") in ("open_id", "user_id") and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) and value != "all" and (f.get("idType") != "open_id" or value.startswith("ou_")) and (f.get("verified") is True or f.get("identityVerified") is True) else None
    same = executor and manager and (executor == manager or identity(executor) and identity(executor) == identity(manager))
    observer = owner.get("managerSubmissionNotify") if same else None
    public_cfg = config.get("publicTasks") or directory.get("publicTasks") or {}
    public_ids = public_cfg.get("recipients", []) if isinstance(public_cfg, dict) else []
    roles = [("公共任务责任人", actor) for actor in public_ids] if public else [("执行人", executor), ("技术经理", manager)] + ([("经理本人提交同步人", observer)] if same else [])
    missing, mentions, names = [], [], []
    if public and not roles:
        missing.append("公共任务责任人")
    for role, actor in roles:
        person = people.get(actor, {})
        if not isinstance(person, dict):
            person = {}
        value = identity(actor)
        display = person.get("name") or (trigger_name if role == "执行人" else None) or actor or "待确认"
        names.append(role + "：" + safe_text(display, env, 50))
        if not value:
            missing.append(role)
        elif value not in mentions:
            mentions.append(value)
    trigger = (safe_text(trigger_name, env, 50) + ("（" + safe_text(trigger_id, env, 40) + "）" if trigger_id and trigger_id != trigger_name else "")) if trigger_name else {"timer": "定时巡检", "upstream": "上游任务", "event": "自动事件"}.get(env.get("WL_GATE_BUILD_TRIGGER"), "触发来源未核验")
    return dict(project=project, public=public, names="　｜　".join(names), trigger=trigger, mentions=mentions, missing=missing,
                networkAccess=config.get("networkAccess") or directory.get("networkAccess", "unknown"), jenkinsOrigin=directory.get("jenkinsOrigin"))


def report_url(env, people):
    origin = env.get("WL_GATE_JENKINS_ORIGIN") or people.get("jenkinsOrigin") or env.get("JENKINS_URL", "")
    parsed = urllib.parse.urlparse(origin)
    job, number = env.get("JOB_NAME", ""), env.get("BUILD_NUMBER", "")
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/") or not re.fullmatch(r"[1-9][0-9]*", number) or not job or any(part in ("", ".", "..") for part in job.split("/")):
        return None
    return origin.rstrip("/") + "/" + "/".join("job/" + urllib.parse.quote(part, safe="") for part in job.split("/")) + "/" + number + "/"


def task_display_name(env):
    job = env.get("JOB_NAME", "")
    return {"wl-quality-doctor": "公共巡检", "wl-quality-fleet": "接入维护", "wl-quality-central": "质量消息采集", "wl-quality-review": "Review签发", "wl-quality-verify": "接线验证"}.get(job.split("/")[-1], job or "任务待识别")


def card(report, env):
    def text(content, color="default", size="normal"):
        return {"tag": "div", "text": {"tag": "plain_text", "content": safe_text(content, env, 1800), "text_color": color, "text_size": size}}
    if env.get("WL_BOOTSTRAP_ACTION") == "notify-test":
        return {"msg_type": "interactive", "card": {"schema": "2.0", "header": {"template": "blue", "title": {"tag": "plain_text", "content": "流水线机器人 · 连通测试"}}, "body": {"elements": [
            text("测试来源：" + task_display_name(env) + " · 第" + env.get("BUILD_NUMBER", "unknown") + "次"),
            text("这是一条机器人签名连通测试消息，请核对群与机器人名称。", "blue"),
            text("仅验证通知连通，不执行代码检查、构建、部署或签发，不表示质量通过。")
        ]}}}
    facts, people = failure_facts(report, env), failure_people(env)
    category = "、".join(dict.fromkeys(safe_text(f.get("label", "阶段执行失败"), env, 80) for f in facts))
    dimensions = "、".join(dict.fromkeys(DIMENSIONS.get(f.get("dimension"), "CI/CD与发布") for f in facts))
    elements = [text("⛔ 公共巡检中断｜本轮未完成项目检查" if people["public"] else "⛔ 本次执行未通过｜后续构建暂不放行", "red", "normal"),
                text("检查来源：" + task_display_name(env) + " · 第" + env.get("BUILD_NUMBER", "unknown") + "次", "grey", "notation"),
                text("触发人：" + people["trigger"] + "　｜　" + datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")),
                text(people["names"]), text("阻断分类：" + category + "　｜　九维定位：" + dimensions, "orange")]
    for i, fact in enumerate(facts[:3]):
        elements += [text(str(i + 1) + ". " + fact.get("stage", "执行阶段") + "｜" + fact.get("reason", "具体原因记录缺失"), "red"),
                     text("处理：" + fact.get("action", "运维补齐本轮失败原件后复查"), "blue")]
    if len(facts) > 3:
        elements.append(text("另有 " + str(len(facts) - 3) + " 项失败，完整记录见下方。", "grey"))
    elements.append(text("本轮未取得有效扫描结果；代码风险未判定。", "grey", "notation"))
    url = report_url(env, people)
    if url:
        def button(label, target):
            return {"tag": "button", "type": "default", "width": "fill", "text": {"tag": "plain_text", "content": label}, "behaviors": [{"type": "open_url", "default_url": target}]}
        elements.append({"tag": "column_set", "horizontal_spacing": "8px", "columns": [
            {"tag": "column", "width": "weighted", "weight": 1, "elements": [button("详情", url)]},
            {"tag": "column", "width": "weighted", "weight": 1, "elements": [button("日志", url.rstrip("/") + "/console")]}]})
    if people["networkAccess"] == "intranet-vpn":
        elements.append(text("详情／日志需公司内网或VPN；手机4G无法直接访问。", "grey", "notation"))
    if people["mentions"]:
        elements.append({"tag": "markdown", "text_size": "normal", "content": " ".join('<at id="' + x + '"></at>' for x in people["mentions"]) + " 请关注上述阻断项，落实修复、复检与回归闭环。"})
    if people["missing"]:
        elements.append(text("责任人提醒未完成：" + "、".join(people["missing"]) + "未匹配身份；补齐人员映射后复检。", "orange"))
    return {"msg_type": "interactive", "card": {"schema": "2.0", "header": {"template": "red", "title": {"tag": "plain_text", "content": (safe_text(people["project"], env, 80) + " · " if people["project"] else "公共任务 · ") + category}}, "body": {"padding": "10px 16px 12px 16px", "vertical_spacing": "6px", "elements": elements}}}


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
            people = failure_people(env)
            complete = ok and (env.get("WL_BOOTSTRAP_ACTION") == "notify-test" or not people["missing"])
            return dict(status="sent" if ok else "rejected", reason="飞书已确认接收" if ok else "飞书未确认接收；检查机器人安全设置", providerAccepted=ok, notificationComplete=complete, mentionMissing=people["missing"], mentionDeliveryConfirmed=False, originalFailurePreserved=True)
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
    if any((directory / (run + suffix)).is_symlink() for suffix in ("-preflight.json", "-notice.json", "-card.json")):
        print("阻断：本轮自检文件是符号链接，不读取、写入或推送。")
        return 2
    if env.get("WL_BOOTSTRAP_ACTION") in ("notify", "notify-test"):
        try:
            report = json.loads(filename.read_text())
        except (OSError, ValueError):
            report = {"checks": []}
        (directory / (run + "-card.json")).write_text(json.dumps(card(report, env), ensure_ascii=False, indent=2) + "\n")
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
