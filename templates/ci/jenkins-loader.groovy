
// Installed by Gate outside every project workspace. No shared Git repository.
def adapter = null
def target = null
withEnv(["WL_NODE_BIN_DIR=${env.WL_NODE_BIN_DIR ?: '__WL_NODE_BIN_DIR__'}", "PATH+WLNODE=${env.WL_NODE_BIN_DIR ?: '__WL_NODE_BIN_DIR__'}"]) {
try {
  env.WL_GATE_PHASE = '公共入口定位'
  wlGatePreflight(mode: 'node', gateRoot: '__WL_GATE_ROOT__', runtimeHash: '__WL_RUNTIME_HASH__')
  def routeDir = "wl-quality-route-${java.util.UUID.randomUUID().toString()}"
  dir(routeDir) {
    withEnv(['WL_QUALITY_CLI=__WL_GATE_ROOT__/bin/wl-quality.js', 'WL_QUALITY_CLUSTER_FILE=__WL_CLUSTER_FILE__', "PATH+WLGATE=${env.WL_NODE_BIN_DIR ?: '/usr/bin'}"]) {
      sh 'node "$WL_QUALITY_CLI" jenkins context --config "$WL_QUALITY_CLUSTER_FILE" --verify-entry --out context.json'
    }
    target = new groovy.json.JsonSlurperClassic().parseText(readFile('context.json'))
    deleteDir()
  }
  adapter = load('__WL_GATE_ROOT__/templates/ci/jenkins-native.groovy')
} catch (Exception failure) {
  wlGateCaptureFailure(failure)
  wlGateFailureNotice()
  throw failure
}
}
def bootstrap = this
// Return first: the caller releases the router executor before allocating a
// business/signing Agent. This also works with a single executor on a node.
return { -> adapter.call(target, bootstrap) }
