// Native Jenkins glue only. Policy, hashes, admission and execution live in Gate.
def call(Map cfg) {
  def context = null
  def admission = null
  def cleanWorkspace = false
  def wiring = null
  withEnv(["WL_GATE_CLI=${cfg.gateRoot}/bin/wl-skills-gate.js", "WL_GATE_BINDINGS=${cfg.registry}"]) {
    try {
      stage('接入预检') { env.WL_GATE_PHASE = '接入预检';
        context = readJSON(text: sh(returnStdout: true, script:
          'node "$WL_GATE_CLI" jenkins inspect --registry "$WL_GATE_BINDINGS"').trim(), returnPojo: true)
        env.WL_GATE_PROJECT = context.project
        echo "Gate：${context.project} / ${context.branch} / ${context.scope} / ${context.mode}"
        // Only this Job is read twice. Credentials end before checkout and
        // before any project command; no fleet polling or all-Job scan.
        withCredentials([usernamePassword(credentialsId: context.reportReaderCredentialId,
          usernameVariable: 'WL_JENKINS_READ_USER', passwordVariable: 'WL_JENKINS_READ_TOKEN')]) {
          wiring = readJSON(text: sh(returnStdout: true, script: '''#!/bin/sh
set -eu
set +x
node "$WL_GATE_CLI" jenkins verify-jobs --registry "$WL_GATE_BINDINGS" --job "$JOB_NAME"
''').trim(), returnPojo: true)
        }
      }
      stage('检出固定目标') { env.WL_GATE_PHASE = '检出固定目标';
        deleteDir()
        cleanWorkspace = true
        checkout(changelog: true, poll: false, scm: [
          $class: 'GitSCM', branches: [[name: "origin/${context.branch}"]],
          userRemoteConfigs: [[name: 'origin', url: context.repository, credentialsId: context.scmCredentialId,
            refspec: "+refs/heads/${context.branch}:refs/remotes/origin/${context.branch}"]],
          extensions: [[$class: 'CloneOption', shallow: false, noTags: true, honorRefspec: true],
            [$class: 'LocalBranch', localBranch: context.branch]]
        ])
        sh 'mkdir -p quality-reports/ci-integration'
        writeJSON file: 'quality-reports/ci-integration/job-wiring.json', json: wiring
      }
      if (context.mode == 'check') {
        stage('质量检查与九维证据') { env.WL_GATE_PHASE = '质量检查与九维证据';
          def checked = sh(returnStatus: true, script: 'node "$WL_GATE_CLI" jenkins check --registry "$WL_GATE_BINDINGS"')
          if (checked != 0) {
            env.WL_GATE_FAILURE_KIND = checked == 1 && fileExists('quality-reports/quality-summary.json') ? 'quality' : 'execution'
            error("质量检查未通过（退出码${checked}），后续构建停止。")
          }
        }
      } else {
        stage('固定依赖准备') { env.WL_GATE_PHASE = '固定依赖准备';
          sh 'node "$WL_GATE_CLI" jenkins prepare --registry "$WL_GATE_BINDINGS"'
        }
        stage('正式Review与严格准入') { env.WL_GATE_PHASE = '正式Review与严格准入';
          withCredentials([
            string(credentialsId: context.credentials.gitlabRead, variable: 'WL_GITLAB_READ_TOKEN'),
            usernamePassword(credentialsId: context.credentials.jenkinsRead,
              usernameVariable: 'WL_JENKINS_READ_USER', passwordVariable: 'WL_JENKINS_READ_TOKEN')
          ]) {
            admission = readJSON(text: sh(returnStdout: true, script:
              'node "$WL_GATE_CLI" jenkins admit --registry "$WL_GATE_BINDINGS"').trim(), returnPojo: true)
          }
          if (admission.status != 'admitted' || !(admission.admissionHash ==~ /[a-f0-9]{64}/)) error('Gate未产生本轮严格准入，不执行构建')
        }
        stage('批准业务构建') { env.WL_GATE_PHASE = '批准业务构建';
          withEnv(["WL_GATE_ADMISSION_HASH=${admission.admissionHash}"]) {
            def built = sh(returnStatus: true, script:
              'node "$WL_GATE_CLI" jenkins build --registry "$WL_GATE_BINDINGS" --admission-hash "$WL_GATE_ADMISSION_HASH"')
            if (built != 0) error("业务构建或固定准备失败：${built}")
          }
          archiveArtifacts artifacts: context.artifactGlob, allowEmptyArchive: false
          archiveArtifacts artifacts: 'quality-reports/ci-integration/build-result.json,quality-reports/ci-integration/business-artifacts.zip', allowEmptyArchive: false
        }
      }
    } catch (Exception failure) {
      env.WL_GATE_FAILURE_MESSAGE = (failure.message ?: failure.class.simpleName).take(1200)
      throw failure
    } finally {
      try {
        // Never publish leftovers if failure occurred before the clean checkout.
        if (cleanWorkspace && context?.mode == 'check' && fileExists('quality-reports/quality-summary.json')) {
          env.WL_GATE_PHASE = '报告发布与结果通知'
          withEnv(["WL_APPROVED_GATE_CLI=${cfg.gateRoot}/bin/wl-skills-gate.js", "WL_QUALITY_REPORT_ARCHIVE_ROOT=${context.reportArchiveRoot}"]) {
            try {
              load("${cfg.gateRoot}/templates/ci/jenkins-quality-report.groovy").call(readerCredentialId: context.reportReaderCredentialId)
              // Quality reporting is event driven by this CHECK. It does not
              // require the optional cluster inventory or a polling scheduler.
              env.WL_GATE_FAILURE_KIND = 'quality'
              withEnv(["WL_CHECK_NOTICE_CONFIG=${cfg.configDir}"]) {
                withCredentials([
                  string(credentialsId: 'wl-feishu-ci-webhook', variable: 'WL_FEISHU_CI_WEBHOOK'),
                  string(credentialsId: 'wl-feishu-ci-signing-secret', variable: 'WL_FEISHU_CI_SECRET'),
                  usernamePassword(credentialsId: context.reportReaderCredentialId, usernameVariable: 'WL_JENKINS_REPORT_USER', passwordVariable: 'WL_JENKINS_REPORT_TOKEN')
                ]) {
                  def notified = sh(returnStatus: true, script: '''#!/bin/sh
set -eu
set +x
node "$WL_GATE_CLI" jenkins notify-check --registry "$WL_GATE_BINDINGS" --config-dir "$WL_CHECK_NOTICE_CONFIG" > quality-reports/ci-integration/notification.json
''')
                  if (notified != 0) {
                    currentBuild.result = 'UNSTABLE'
                    echo '当前检查报告已发布；通知未完整确认，查看本轮notification.json，禁止自动重发或据此放行。'
                  }
                }
              }
            } catch (Exception publicationFailure) {
              env.WL_GATE_FAILURE_KIND = 'execution'
              throw publicationFailure
            }
          }
        }
      } finally {
        if (cleanWorkspace) archiveArtifacts artifacts: 'quality-reports/**', allowEmptyArchive: true
      }
    }
  }
}
return this
