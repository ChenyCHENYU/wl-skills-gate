// Load this asset from the approved Gate installation/shared library, not an MR workspace.
// Requires HTML Publisher and a Jenkins credential limited to reading these report jobs.
def call(Map cfg = [:]) {
  if (!fileExists('quality-reports/quality-summary.json')) {
    error('本轮未生成原始质量报告，不发布旧文件或发送详情按钮')
  }
  sh '''
    set -eu
    : "${WL_APPROVED_GATE_CLI:?approved fixed Gate CLI}"
    : "${BUILD_URL:?specific Jenkins build URL}"
    : "${WL_QUALITY_REPORT_ARCHIVE_ROOT:?approved persistent report volume outside WORKSPACE}"
    test -d "$WL_QUALITY_REPORT_ARCHIVE_ROOT"
    case "$WL_QUALITY_REPORT_ARCHIVE_ROOT/" in /*) ;; *) exit 2 ;; esac
    case "$WL_QUALITY_REPORT_ARCHIVE_ROOT/" in "$WORKSPACE/"*) printf '%s\\n' '报告持久卷不能是临时工作区'; exit 2 ;; esac
    node "$WL_APPROVED_GATE_CLI" report-publication archive \
      --summary quality-reports/quality-summary.json \
      --review-index quality-reports/review-latest.json \
      --out-dir quality-reports/report-archives \
      --jenkins-build-url "$BUILD_URL" --out quality-reports/report-publication.json
    node "$WL_APPROVED_GATE_CLI" report-publication archive \
      --summary quality-reports/quality-summary.json \
      --review-index quality-reports/review-latest.json \
      --out-dir "$WL_QUALITY_REPORT_ARCHIVE_ROOT" \
      --jenkins-build-url "$BUILD_URL" --out quality-reports/report-retention.json
  '''
  def publication = new groovy.json.JsonSlurperClassic().parseText(readFile('quality-reports/report-publication.json'))
  def retained = new groovy.json.JsonSlurperClassic().parseText(readFile('quality-reports/report-retention.json'))
  if (publication.archiveId != retained.archiveId || publication.htmlSha256 != retained.htmlSha256) error('持久归档与待发布报告不一致')
  publishHTML(target: [allowMissing: false, alwaysLinkToLastBuild: false, keepAll: true,
    reportDir: "quality-reports/report-archives/batches/${publication.archiveId}",
    reportFiles: "${publication.relativeDirectory}/index.html",
    reportName: 'wl-quality', reportTitles: '九维质量检查详情'])
  withEnv(["WL_REPORT_ARCHIVE_MANIFEST=${publication.manifestFile}"]) {
    withCredentials([usernamePassword(credentialsId: cfg.readerCredentialId ?: 'wl-quality-report-reader',
        usernameVariable: 'WL_JENKINS_REPORT_USER', passwordVariable: 'WL_JENKINS_REPORT_TOKEN')]) {
      sh '''
        set -eu
        node "$WL_APPROVED_GATE_CLI" report-publication verify \
          --manifest "$WL_REPORT_ARCHIVE_MANIFEST" --jenkins-origin "$JENKINS_URL" \
          --out quality-reports/report-publication-check.json
      '''
    }
  }
  // Central notifications consume this verified, build-specific URL; never latest/lastBuild.
  return new groovy.json.JsonSlurperClassic().parseText(readFile('quality-reports/report-publication-check.json'))
}
return this
