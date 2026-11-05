import path from 'node:path';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {controlledPath} from './control-store.js';
import {digest} from './jenkins-integration.js';
import {renderOpsReportPage,OPS_REPORT_STYLES} from './ops-report-page.js';

export function archiveOpsReportPage({report,directory}){
  directory=controlledPath(directory);mkdirSync(directory,{recursive:true,mode:0o700});
  const html=renderOpsReportPage(report),files={'index.html':html,'report.css':OPS_REPORT_STYLES};
  for(const [name,bytes] of Object.entries(files)){
    const file=controlledPath(path.join(directory,name));
    if(existsSync(file)){
      if(readFileSync(file,'utf8')!==bytes)throw Error('已有巡检报告不可覆盖；保留历史原件，使用新的巡检运行记录');
    }else writeFileSync(file,bytes,{flag:'wx',mode:0o600});
  }
  return {runId:report.runId,htmlSha256:digest(html),styleSha256:digest(OPS_REPORT_STYLES),directory,qualityPassed:false,buildAuthorized:false};
}
