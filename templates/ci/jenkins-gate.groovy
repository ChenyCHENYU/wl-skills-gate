// Native Jenkins glue only. Policy, hashes, admission and execution live in Gate.
def call(Map cfg) {
  def context = null
  def admission = null
  def cleanWorkspace = false
  withEnv(["WL_GATE_CLI=${cfg.gateRoot}/bin/wl-skills-gate.js", "WL_GATE_BINDINGS=${cfg.registry}"]) {
    try {
      stage('接入预检') { env.WL_GATE_PHASE = '接入预检';
        context = readJSON(text: sh(returnStdout: true, script:
          'node "$WL_GATE_CLI" jenkins inspect --registry "$WL_GATE_BINDINGS"').trim(), returnPojo: true)
        env.WL_GATE_PROJECT = context.project
        echo "Gate：${context.project} / ${context.branch} / ${context.scope} / ${context.mode}"
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
      }
      if (context.mode == 'check') {
        stage('质量检查与九维证据') { env.WL_GATE_PHASE = '质量检查与九维证据';
          def checked = sh(returnStatus: true, script: 'node "$WL_GATE_CLI" jenkins check --registry "$WL_GATE_BINDINGS"')
          if (checked != 0) {
            env.WL_GATE_FAILURE_KIND = checked == 1 && fileExists('quality-reports/quality-summary.json') ? 'quality' : 'execution'
            error("质量检查未通过：${checked}；本次报告由中央采集后分类通知。")
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
          withEnv(["WL_APPROVED_GATE_CLI=${cfg.gateRoot}/bin/wl-skills-gate.js", "WL_QUALITY_REPORT_ARCHIVE_ROOT=${context.reportArchiveRoot}"]) {
            try {
              load("${cfg.gateRoot}/templates/ci/jenkins-quality-report.groovy").call(readerCredentialId: context.reportReaderCredentialId)
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
