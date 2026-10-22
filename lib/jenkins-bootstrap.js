import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativePipelineEntry} from './jenkins-entry-contract.js';
const root=fileURLToPath(new URL('../',import.meta.url));

// The helper is embedded in the protected Pipeline: it still runs when Gate is
// absent. Python code is owned here; business checkout never supplies the script.
export function jenkinsBootstrapHelper() {
  const python=readFileSync(path.join(root,'templates/ci/jenkins-bootstrap.py'),'utf8');
  if(python.includes("'''") || python.includes('\nWL_GATE_BOOTSTRAP_PY\n'))throw Error('Bootstrap source cannot be safely embedded');
  const literal=python.replaceAll('\\','\\\\');
  return `def wlGateBootstrap(String action, Map cfg = [:]) {
  def result = 2
  withEnv(["PATH+WLGATE=\${env.WL_NODE_BIN_DIR ?: '/usr/bin'}",
    "WL_BOOTSTRAP_ACTION=\${action}", "WL_BOOTSTRAP_MODE=\${cfg.mode ?: 'job'}",
    "WL_BOOTSTRAP_GATE_ROOT=\${cfg.gateRoot ?: '/opt/wl-quality/gate-validation/node_modules/@agile-team/wl-skills-gate'}",
    "WL_BOOTSTRAP_REGISTRY=\${cfg.registry ?: ''}", "WL_BOOTSTRAP_RUNTIME_HASH=\${cfg.runtimeHash ?: ''}"]) {
    result = sh(returnStatus: true, script: '''#!/bin/sh
set +x
if ! command -v python3 >/dev/null 2>&1; then
  echo '阻断：缺少 python3；在当前执行节点安装 Python3 后重跑。签名通知也依赖 Python3，本次不能确认飞书送达。'
  exit 2
fi
python3 - <<'WL_GATE_BOOTSTRAP_PY'
${literal}WL_GATE_BOOTSTRAP_PY
''')
  }
  return result
}
def wlGatePreflight(Map cfg) {
  def result = wlGateBootstrap('probe', cfg)
  archiveArtifacts artifacts: '.wl-gate-bootstrap/*-preflight.json', allowEmptyArchive: true
  if (result != 0) error('节点自检未通过；按控制台处理项修复，后续阶段停止。')
}
def wlGateNotificationTest() {
  env.WL_GATE_NOTIFICATION_TEST = 'true'
  withCredentials([
    string(credentialsId: 'wl-feishu-ci-webhook', variable: 'WL_FEISHU_CI_WEBHOOK'),
    string(credentialsId: 'wl-feishu-ci-signing-secret', variable: 'WL_FEISHU_CI_SECRET')
  ]) {
    def result = wlGateBootstrap('notify-test')
    if (result != 0) error('机器人连通测试未确认送达；查看 notice.json 和群记录。')
  }
}
def wlGateFailureNotice() {
  if (env.WL_GATE_NOTIFICATION_TEST == 'true') {
    echo '连通测试失败已留痕，不重复推送异常消息。'
    return
  }
  if (env.WL_GATE_FAILURE_KIND == 'quality') {
    echo '代码质量问题由中央采集及质量卡片通知，本阶段不重复发送环境异常消息。'
    return
  }
  try {
    withCredentials([
      string(credentialsId: 'wl-feishu-ci-webhook', variable: 'WL_FEISHU_CI_WEBHOOK'),
      string(credentialsId: 'wl-feishu-ci-signing-secret', variable: 'WL_FEISHU_CI_SECRET')
    ]) {
      def result = wlGateBootstrap('notify')
      if (result != 0) echo '通知尚未确认送达；查看 notice.json 和群记录。原失败结果保持不变。'
    }
  } catch (org.jenkinsci.plugins.workflow.steps.FlowInterruptedException interrupted) {
    throw interrupted
  } catch (Exception ignored) {
    echo '通知未完成；检查 wl-feishu-ci-webhook / wl-feishu-ci-signing-secret 凭据与 Python3。原失败结果保持不变。'
  }
}
`;
}
export function embedJenkinsBootstrap(template) {
  if(!template.includes('// __WL_BOOTSTRAP__'))throw Error('Jenkins template lacks bootstrap marker');
  return template.replace('// __WL_BOOTSTRAP__',jenkinsBootstrapHelper());
}
export function renderJenkinsMaintenance({mode,gateRoot='/opt/wl-quality/gate-validation/node_modules/@agile-team/wl-skills-gate',registryFile='/srv/wl-quality/config/jenkins-bindings.json',configDir='/srv/wl-quality/config',agentLabel,nativeEntry}={}) {
  if(nativeEntry)return nativePipelineEntry(nativeEntry);
  const templates={node:'Jenkinsfile.node-preflight',verify:'Jenkinsfile.verify-jobs',automation:'Jenkinsfile.automation',review:'Jenkinsfile.review-sign',fleet:'Jenkinsfile.fleet'};
  if(!templates[mode])throw Error('Unknown Jenkins maintenance mode');
  agentLabel ||= mode==='review'?'wl-review-signer-isolated':['automation','fleet'].includes(mode)?'wl-quality-central':'wl-quality-isolated';
  if(!/^[A-Za-z0-9_.-]{1,100}$/.test(agentLabel) || [gateRoot,registryFile,configDir].some(v=>!path.isAbsolute(v)||/[\u0000-\u001f'"`$\\]/.test(v)))throw Error('Maintenance task requires controlled paths and an explicit Agent label');
  const template=readFileSync(path.join(root,'templates/ci',templates[mode]),'utf8');
  return embedJenkinsBootstrap(template).replaceAll('__WL_GATE_ROOT__',gateRoot).replaceAll('__WL_REGISTRY__',registryFile).replaceAll('__WL_AGENT__',agentLabel).replaceAll('__WL_CENTRAL_CONFIG__',configDir);
}
