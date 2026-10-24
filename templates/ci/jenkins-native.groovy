// Package-owned Scripted Pipeline; no separately published shared library.
def wlOpsRun(Map cfg) {
  def publicRoot = "${pwd()}/wl-ops-public"
  dir('wl-ops-public') { deleteDir(); dir('projects') { writeFile file: '.keep', text: '' } }
  def inventory = null
  def outcome = 2
  withEnv(["WL_QUALITY_CLI=${cfg.gateRoot}/bin/wl-quality.js", "WL_OPS_CLUSTER=${cfg.clusterFile}", "WL_OPS_PUBLIC=${publicRoot}"]) {
    try {
      stage('发现项目与流水线') { env.WL_GATE_PHASE = '发现项目与流水线';
        withCredentials([usernamePassword(credentialsId: 'wl-jenkins-ci-readonly', usernameVariable: 'WL_JENKINS_READ_USER', passwordVariable: 'WL_JENKINS_READ_TOKEN')]) {
          sh '''#!/bin/sh
set -eu
set +x
node "$WL_QUALITY_CLI" jenkins ops inventory --cluster "$WL_OPS_CLUSTER" --out "$WL_OPS_PUBLIC/inventory.json"
'''
        }
        inventory = readJSON(file: 'wl-ops-public/inventory.json', returnPojo: true)
        echo "巡检发现 ${inventory.jobsDiscovered} 个任务；目标 ${inventory.targets.size()} 项。"
      }
      stage('检查项目接入条件') { env.WL_GATE_PHASE = '检查项目接入条件';
        for (def target in inventory.targets) {
          withEnv(["WL_OPS_KEY=${target.key}", "WL_OPS_RESULT=${publicRoot}/projects/${target.key}.json"]) {
            def checkoutFailed = false
            if (target.checkoutAllowed == true) {
              dir("wl-ops-checkouts/${target.key}") {
                deleteDir()
                try {
                try {
                  timeout(time: 5, unit: 'MINUTES') {
                    checkout(changelog: false, poll: false, scm: [
                      $class: 'GitSCM', branches: [[name: "origin/${target.branch}"]],
                      userRemoteConfigs: [[name: 'origin', url: target.repository, credentialsId: target.credentialId,
                        refspec: "+refs/heads/${target.branch}:refs/remotes/origin/${target.branch}"]],
                      extensions: [[$class: 'CloneOption', shallow: true, depth: 1, noTags: true, honorRefspec: true]]
                    ])
                  }
                } catch (org.jenkinsci.plugins.workflow.steps.FlowInterruptedException interrupted) { throw interrupted }
                catch (Exception checkoutFailure) { checkoutFailed = true; echo '源码检出未完成；仅记录缺项，继续检查其余项目。' }
                if (!checkoutFailed) {
                  sh(returnStatus: true, script: '''#!/bin/sh
set -eu
node "$WL_QUALITY_CLI" jenkins ops inspect --cluster "$WL_OPS_CLUSTER" --inventory "$WL_OPS_PUBLIC/inventory.json" --target-key "$WL_OPS_KEY" --root "$PWD" --out "$WL_OPS_RESULT"
''')
                }
                } finally { deleteDir() }
              }
            }
            if (checkoutFailed || target.checkoutAllowed != true) {
              sh(returnStatus: true, script: '''#!/bin/sh
set -eu
node "$WL_QUALITY_CLI" jenkins ops inspect --cluster "$WL_OPS_CLUSTER" --inventory "$WL_OPS_PUBLIC/inventory.json" --target-key "$WL_OPS_KEY" --failure checkout-not-completed --out "$WL_OPS_RESULT"
''')
            }
          }
        }
      }
    } finally {
      try {
      if (fileExists('wl-ops-public/inventory.json')) {
        stage('记录缺项与飞书提醒') { env.WL_GATE_PHASE = '记录缺项与飞书提醒';
          try { withEnv(["WL_OPS_RETRY_NOTICE=${params.RETRY_NOTIFICATION == true ? '1' : '0'}"]) { withCredentials([
            string(credentialsId: 'wl-feishu-ci-webhook', variable: 'WL_FEISHU_CI_WEBHOOK'),
            string(credentialsId: 'wl-feishu-ci-signing-secret', variable: 'WL_FEISHU_CI_SECRET')
          ]) {
            outcome = sh(returnStatus: true, script: '''#!/bin/sh
set -eu
set +x
set -- jenkins ops finish --cluster "$WL_OPS_CLUSTER" --inventory "$WL_OPS_PUBLIC/inventory.json" --results "$WL_OPS_PUBLIC/projects" --out "$WL_OPS_PUBLIC/summary.json" --send
if [ "$WL_OPS_RETRY_NOTICE" = '1' ]; then set -- "$@" --retry-notification; fi
node "$WL_QUALITY_CLI" "$@"
''')
          } } } catch (org.jenkinsci.plugins.workflow.steps.FlowInterruptedException interrupted) { throw interrupted }
          catch (Exception noticeFailure) {
            echo '通知阶段未完成；请核对流水线机器人凭据。本次仍生成巡检原件，不登记消息送达。'
            if (!fileExists('wl-ops-public/summary.json')) sh(returnStatus: true, script: '''#!/bin/sh
set -eu
node "$WL_QUALITY_CLI" jenkins ops finish --cluster "$WL_OPS_CLUSTER" --inventory "$WL_OPS_PUBLIC/inventory.json" --results "$WL_OPS_PUBLIC/projects" --out "$WL_OPS_PUBLIC/summary.json"
''')
            outcome = 2
          }
        }
      }
      } finally { archiveArtifacts artifacts: 'wl-ops-public/*.json,wl-ops-public/*.html,wl-ops-public/projects/*.json', allowEmptyArchive: true }
    }
  }
  if (fileExists('wl-ops-public/summary.json')) {
    def summary = readJSON(file: 'wl-ops-public/summary.json', returnPojo: true)
    if (!summary.globalGaps) wlOpsContinue(cfg, summary)
  }
  if (outcome != 0) { currentBuild.result = 'UNSTABLE'; echo '运维巡检有待处理项或消息未确认送达；见本次归档，修复后下一轮自动复查。本结果不授予构建准入。' }
}

// Only package-verified CHECK jobs can be resumed; never arbitrary legacy deploy jobs.
def wlOpsContinue(Map cfg, Map summary) {
  try {
  stage('承接已就绪项目的九维检查') { env.WL_GATE_PHASE = '承接已就绪项目的九维检查';
    for (def project in summary.projects.findAll { it.checkJob && (it.status == 'ready' || it.gaps.every { g -> g.id == 'CHECK-DISPATCH-UNKNOWN' }) }) {
      withEnv(["WL_QUALITY_CLI=${cfg.gateRoot}/bin/wl-quality.js", "WL_OPS_CLUSTER=${cfg.clusterFile}", "WL_OPS_RUN=${summary.runId}", "WL_OPS_KEY=${project.key}", "WL_OPS_CLAIM=wl-ops-public/claim-${project.key}.json", "WL_OPS_ACK=wl-ops-public/ack-${project.key}.json", "WL_OPS_RETRY_CHECK=${params.RETRY_UNCONFIRMED_CHECK == true ? '1' : '0'}"]) {
        def claimCode = 2
        withCredentials([usernamePassword(credentialsId: 'wl-jenkins-ci-readonly', usernameVariable: 'WL_JENKINS_READ_USER', passwordVariable: 'WL_JENKINS_READ_TOKEN')]) {
        claimCode = sh(returnStatus: true, script: '''#!/bin/sh
set -eu
set +x
set -- jenkins ops claim-check --cluster "$WL_OPS_CLUSTER" --run-id "$WL_OPS_RUN" --target-key "$WL_OPS_KEY" --out "$WL_OPS_CLAIM"
if [ "$WL_OPS_RETRY_CHECK" = '1' ]; then set -- "$@" --retry-unknown; fi
node "$WL_QUALITY_CLI" "$@"
''')
        }
        if (claimCode == 0 && fileExists("wl-ops-public/claim-${project.key}.json")) {
        def claim = readJSON(file: "wl-ops-public/claim-${project.key}.json", returnPojo: true)
        if (claim.status == 'claimed') {
          try {
            def started = build(job: claim.job, wait: false, waitForStart: true, propagate: false,
              parameters: [string(name: 'WL_REVIEW_SHA', value: claim.sha), string(name: 'WL_GATE_DISPATCH_ID', value: claim.dispatchId)])
            withEnv(["WL_OPS_BUILD=${started.number}", "WL_OPS_DISPATCH=${claim.dispatchId}"]) {
              sh '''#!/bin/sh
set -eu
node "$WL_QUALITY_CLI" jenkins ops ack-check --cluster "$WL_OPS_CLUSTER" --run-id "$WL_OPS_RUN" --target-key "$WL_OPS_KEY" --build-number "$WL_OPS_BUILD" --dispatch-id "$WL_OPS_DISPATCH" --out "$WL_OPS_ACK"
'''
            }
            echo "CHECK已启动：${claim.job} #${started.number}；正式检查及Review结论以该运行原件为准。"
          } catch (org.jenkinsci.plugins.workflow.steps.FlowInterruptedException interrupted) { throw interrupted }
          catch (Exception dispatchFailure) { currentBuild.result = 'UNSTABLE'; echo 'CHECK启动未确认，已保留本轮记录；下轮提醒核对，不自动重复启动。' }
        } else {
          if (claim.status != 'already-started') currentBuild.result = 'UNSTABLE'
          echo "CHECK承接：${claim.status}；${claim.reason ?: '已有实际启动记录，未重复启动'}"
        }
        } else { currentBuild.result = 'UNSTABLE'; echo '本项目CHECK承接核验未通过，未启动；按本轮控制台缺项修复，其余项目继续。' }
      }
    }
  }
  } finally { archiveArtifacts artifacts: 'wl-ops-public/claim-*.json,wl-ops-public/ack-*.json', allowEmptyArchive: true }
}

def wlFleetRun(Map cfg, String action, String batch = '', String planHash = '') {
  def code = 2
  withEnv(["WL_APPROVED_GATE_CLI=${cfg.gateRoot}/bin/wl-skills-gate.js",
    "WL_FLEET_CONFIG=${cfg.configDir}/jenkins-fleet.json",
    "WL_FLEET_ACTION=${action}", "WL_FLEET_BATCH=${batch}", "WL_FLEET_HASH=${planHash}",
    "PATH+WLGATE=${env.WL_NODE_BIN_DIR ?: '/usr/bin'}"]) {
    withCredentials([
      usernamePassword(credentialsId: 'wl-jenkins-config-manager', usernameVariable: 'WL_JENKINS_CONFIG_USER', passwordVariable: 'WL_JENKINS_CONFIG_TOKEN'),
      string(credentialsId: 'wl-gitlab-hooks-token', variable: 'WL_GITLAB_HOOK_TOKEN'),
      string(credentialsId: 'wl-gitlab-jenkins-webhook-secret', variable: 'WL_GITLAB_JENKINS_WEBHOOK_SECRET')
    ]) {
      code = sh(returnStatus: true, script: '''#!/bin/sh
set -eu
set +x
rm -f wl-fleet-public/summary.json
set -- jenkins fleet "$WL_FLEET_ACTION" --config "$WL_FLEET_CONFIG" --out wl-fleet-public/summary.json
if [ -n "$WL_FLEET_BATCH" ]; then set -- "$@" --batch "$WL_FLEET_BATCH"; fi
if [ -n "$WL_FLEET_HASH" ]; then set -- "$@" --plan-hash "$WL_FLEET_HASH" --confirm; fi
node "$WL_APPROVED_GATE_CLI" "$@"
''')
    }
  }
  if (!fileExists('wl-fleet-public/summary.json')) error('未产生本次结果；按控制台缺项处理，不登记成功。')
  def result = readJSON(file: 'wl-fleet-public/summary.json', returnPojo: true)
  archiveArtifacts artifacts: 'wl-fleet-public/summary.json', allowEmptyArchive: false
  if (code != 0) error('批次仍有待处理项；查看归档逐项结果，修复后续跑或重新预览。')
  return result
}

def wlPrepareJobs(Map cfg) {
  dir('wl-bootstrap-public') {
    deleteDir()
  withEnv(["WL_QUALITY_CLI=${cfg.gateRoot}/bin/wl-quality.js", "WL_CLUSTER_FILE=${cfg.clusterFile}"]) {
    withCredentials([usernamePassword(credentialsId: 'wl-jenkins-config-manager', usernameVariable: 'WL_JENKINS_CONFIG_USER', passwordVariable: 'WL_JENKINS_CONFIG_TOKEN')]) {
      def planned = sh(returnStatus: true, script: 'node "$WL_QUALITY_CLI" jenkins bootstrap --config "$WL_CLUSTER_FILE" --out wl-bootstrap-plan.json')
      if (!fileExists('wl-bootstrap-plan.json')) error('未产生本轮公共任务计划，按控制台处理项修复。')
      def plan = readJSON(file: 'wl-bootstrap-plan.json', returnPojo: true)
      echo "公共任务：${plan.entries.collect { it.job + '：' + it.action }.join('；')}"
      plan.entries.findAll { it.reason }.each { echo "处理：${it.job} · ${it.reason}" }
      if (planned != 0 || plan.entries.any { it.action == 'blocked' }) error('同名任务有自定义配置，停止覆盖；见归档。')
      if (plan.entries.any { it.action == 'create' }) {
        timeout(time: 20, unit: 'MINUTES') { input message: '确认创建缺少的公共任务？不会启动业务构建或定时任务。', ok: '确认创建' }
        withEnv(["WL_BOOTSTRAP_PLAN_HASH=${plan.planHash}"]) {
          sh 'node "$WL_QUALITY_CLI" jenkins bootstrap --config "$WL_CLUSTER_FILE" --confirm --plan-hash "$WL_BOOTSTRAP_PLAN_HASH" --out wl-bootstrap-result.json'
          def result = readJSON(file: 'wl-bootstrap-result.json', returnPojo: true)
          echo "公共任务：${result.status}；共${result.entries.size()}项。"
        }
      } else echo '公共任务：common-jobs-verified；已有任务全部匹配，无需重复创建。'
    }
  }
  }
}
def call(Map cfg, def bootstrap) {
  env.WL_GATE_FAILURE_CONFIG_DIR = cfg.configDir
  env.WL_GATE_JENKINS_ORIGIN = cfg.jenkinsOrigin ?: env.WL_GATE_JENKINS_ORIGIN
  env.WL_GATE_FAILURE_REGISTRY = cfg.registry ?: ''
  node(cfg.agentLabel) {
    withEnv(["WL_NODE_BIN_DIR=${env.WL_NODE_BIN_DIR ?: cfg.nodeBinDir ?: '/usr/bin'}", "PATH+WLNODE=${env.WL_NODE_BIN_DIR ?: cfg.nodeBinDir ?: '/usr/bin'}"]) {
    timeout(time: cfg.role == 'fleet' ? 120 : 30, unit: 'MINUTES') {
      try {
        if (cfg.role != 'job') {
          def options = [disableConcurrentBuilds()]
          if (cfg.role == 'node') {
            def enabled = params.ENABLE_MONITOR == true
            options.add(parameters([booleanParam(name: 'TEST_NOTIFICATION', defaultValue: false, description: '仅测试流水线机器人签名推送'), booleanParam(name: 'ENABLE_MONITOR', defaultValue: enabled, description: '启用每5分钟发现项目、检查接入缺项并提醒；不代替业务九维检查'), booleanParam(name: 'RETRY_NOTIFICATION', defaultValue: false, description: '核对群记录后补发本轮缺项通知，可能重复；仅本次'), booleanParam(name: 'RETRY_UNCONFIRMED_CHECK', defaultValue: false, description: '核对队列和运行记录后重试未确认CHECK，可能重复；仅本次')]))
            options.add(pipelineTriggers(enabled ? [cron('H/5 * * * *')] : []))
          }
          if (cfg.role == 'fleet') options.add(parameters([
            choice(name: 'ACTION', choices: ['准备公共任务', '盘点', '预览', '接入', '续跑', '核验', '回退'], description: '首轮准备公共任务，之后按批准登记批量接入'),
            string(name: 'BATCH', defaultValue: '', description: '续跑、核验、回退填写原批次ID')]))
          if (['automation', 'review'].contains(cfg.role)) {
            def enabled = params.ENABLE_SCHEDULER == true
            options.add(parameters([booleanParam(name: 'ENABLE_SCHEDULER', defaultValue: enabled, description: '联验通过后启用每分钟执行；关闭后运行一次即停止调度')]))
            options.add(pipelineTriggers(enabled ? [cron('* * * * *')] : []))
          }
          properties(options)
        }
        stage('执行节点自检') { env.WL_GATE_PHASE = '执行节点自检'; withEnv(["WL_CENTRAL_AUTOMATION_CONFIG=${cfg.configDir}/automation-config.json", "WL_REVIEW_PUBLISH_CONFIG=${cfg.configDir}/review-publish-config.json"]) { bootstrap.wlGatePreflight(mode: cfg.role == 'job' ? 'job' : cfg.role, gateRoot: cfg.gateRoot, runtimeHash: cfg.runtimeHash, registry: cfg.role == 'job' || cfg.role == 'verify' ? cfg.registry : '') } }
        withEnv(["WL_APPROVED_GATE_CLI=${cfg.gateRoot}/bin/wl-skills-gate.js", "WL_APPROVED_GATE_SETUP=${cfg.gateRoot}/bin/wl-quality-setup.js", "WL_CENTRAL_CONFIG=${cfg.configDir}", "WL_GATE_BINDINGS=${cfg.registry}", "PATH+WLGATE=${env.WL_NODE_BIN_DIR ?: '/usr/bin'}"]) {
          if (cfg.role == 'job') {
            load("${cfg.gateRoot}/templates/ci/jenkins-gate.groovy").call(cfg)
          } else if (cfg.role == 'node') {
            if (params.TEST_NOTIFICATION) stage('飞书连通测试') { env.WL_GATE_PHASE = '飞书连通测试'; bootstrap.wlGateNotificationTest() }
            else wlOpsRun(cfg)
          } else if (cfg.role == 'verify') {
            stage('核验Gate接线') { env.WL_GATE_PHASE = '核验Gate接线';
              withCredentials([usernamePassword(credentialsId: 'wl-jenkins-ci-readonly', usernameVariable: 'WL_JENKINS_READ_USER', passwordVariable: 'WL_JENKINS_READ_TOKEN')]) {
                sh 'node "$WL_APPROVED_GATE_CLI" jenkins verify-jobs --registry "$WL_GATE_BINDINGS"'
              }
            }
          } else if (cfg.role == 'review') {
            stage('签发已明确授权的九维Review') { env.WL_GATE_PHASE = '签发已明确授权的九维Review';
              withCredentials([
                file(credentialsId: 'wl-review-signing-key', variable: 'WL_REVIEW_PRIVATE_KEY_FILE'),
                string(credentialsId: 'wl-ci-review-readonly-token', variable: 'WL_GITLAB_READ_TOKEN'),
                usernamePassword(credentialsId: 'wl-jenkins-ci-readonly', usernameVariable: 'WL_JENKINS_READ_USER', passwordVariable: 'WL_JENKINS_READ_TOKEN')]) {
                sh 'node "$WL_APPROVED_GATE_CLI" review-publish --config "$WL_CENTRAL_CONFIG/review-publish-config.json"'
              }
            }
          } else if (cfg.role == 'automation') {
            stage('采集、对账与分类通知') { env.WL_GATE_PHASE = '采集、对账与分类通知';
              withCredentials([
                string(credentialsId: 'wl-feishu-ci-webhook', variable: 'WL_FEISHU_CI_WEBHOOK'),
                string(credentialsId: 'wl-feishu-ci-signing-secret', variable: 'WL_FEISHU_CI_SECRET'),
                string(credentialsId: 'wl-feishu-project-webhook', variable: 'WL_FEISHU_PROJECT_WEBHOOK'),
                string(credentialsId: 'wl-feishu-project-signing-secret', variable: 'WL_FEISHU_PROJECT_SECRET'),
                usernamePassword(credentialsId: 'wl-jenkins-ci-readonly', usernameVariable: 'WL_JENKINS_READ_USER', passwordVariable: 'WL_JENKINS_READ_TOKEN'),
                string(credentialsId: 'wl-ci-review-readonly-token', variable: 'WL_GITLAB_READ_TOKEN'),
                usernamePassword(credentialsId: 'wl-jenkins-build-dispatch', usernameVariable: 'WL_JENKINS_BUILD_USER', passwordVariable: 'WL_JENKINS_BUILD_TOKEN'),
                string(credentialsId: 'wl-quality-sso-client-secret', variable: 'WL_SSO_CLIENT_SECRET')]) {
                sh '''#!/bin/sh
set -eu
set +x
node "$WL_APPROVED_GATE_SETUP" central --config-dir "$WL_CENTRAL_CONFIG" --send --separate-review-signer --json
node "$WL_APPROVED_GATE_CLI" automation --config "$WL_CENTRAL_CONFIG/automation-config.json" --send
'''
              }
            }
          } else if (cfg.role == 'fleet') {
            dir('wl-fleet-public') { deleteDir() }
            stage('批量接入维护') { env.WL_GATE_PHASE = '批量接入维护';
              def action = params.ACTION ?: '准备公共任务'
              def batch = (params.BATCH ?: '').trim()
              if (action == '准备公共任务') { wlPrepareJobs(cfg) }
              else {
                if (['盘点', '预览', '接入'].contains(action) && batch) error('本动作的批次ID应留空。')
                if (['续跑', '核验', '回退'].contains(action) && !batch) error('请填写原批次ID。')
                if (action == '盘点') { wlFleetRun(cfg, 'inventory') }
                else if (action == '预览') { wlFleetRun(cfg, 'plan') }
                else if (action == '核验') { wlFleetRun(cfg, 'verify', batch) }
                else if (['接入', '续跑', '回退'].contains(action)) {
                  def preview = action == '接入' ? wlFleetRun(cfg, 'plan') : wlFleetRun(cfg, 'show', batch)
                  if (!preview.approvers) error('未配置批准人，停止写入。')
                  timeout(time: 20, unit: 'MINUTES') {
                    def by = input message: "确认${action}这 ${preview.counts.total} 个任务？清单见归档。", ok: '确认执行', submitter: preview.approvers.join(','), submitterParameter: 'APPROVED_BY'
                    writeFile file: 'wl-fleet-public/approval.txt', text: "batch=${preview.planId}\nplanHash=${preview.planHash}\naction=${action}\napprovedBy=${by}\n"
                  }
                  wlFleetRun(cfg, action == '回退' ? 'rollback' : 'apply', preview.planId.toString(), preview.planHash.toString())
                } else error('未知批量维护动作。')
              }
            }
          } else error('未知公共入口角色。')
        }
      } catch (Exception failure) {
        bootstrap.wlGateCaptureFailure(failure)
        bootstrap.wlGateFailureNotice()
        throw failure
      } finally {
        archiveArtifacts artifacts: '.wl-gate-bootstrap/**,wl-fleet-public/*,wl-bootstrap-public/*.json,review-delivery/**', allowEmptyArchive: true
      }
    }
    }
  }
}
return this
