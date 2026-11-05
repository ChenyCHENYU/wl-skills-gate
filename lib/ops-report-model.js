const groups=[
  ['access','账号与访问',/JENKINS-AUTH|JENKINS-PERMISSION|JOB-UNREADABLE|credential|permission|auth/i,'运维'],
  ['project','项目接入',/PROJECT-GATE|PROJECT-CONFIG|GATE-VERSION|DECLARED-|INSTALLED-|ENGINES-|REVIEW-FILE/i,'技术经理'],
  ['wiring','流水线接线',/SCM-LOCATION|UNCONTROLLED-JOB|JOB-ENTRY|APPROVED-PINS|DUPLICATE-REGISTRY|CHECK-DISPATCH/i,'工程维护者与运维'],
  ['central','公共配置',/REGISTRY|CENTRAL-CONFIG|binding|fleet|policy|automation/i,'工程维护者'],
  ['execution','执行与报告',/.*/,'运维与执行人'],
];
export const OPS_REPORT_CATEGORIES=groups.map(([id,label,,owner])=>({id,label,owner}));
export function opsGapCategory(gap){
  const [id,label,,owner]=groups.find(row=>row[2].test(String(gap?.id||'')));
  return {id,label,owner};
}
export function opsReportView(report){
  const projects=Array.isArray(report.projects)?report.projects:[];
  const globalGaps=Array.isArray(report.globalGaps)?report.globalGaps:[];
  const entries=[...globalGaps.map(g=>({...g,source:'公共配置'})),...projects.flatMap(p=>(p.gaps||[]).map(g=>({...g,source:p.project||'仓库未定位',projectKey:p.key,job:p.jobs?.join('、')||''})))];
  const categories=OPS_REPORT_CATEGORIES.map(c=>({...c,entries:entries.filter(e=>opsGapCategory(e).id===c.id)}));
  const access=globalGaps.filter(g=>['JENKINS-AUTH','JENKINS-PERMISSION'].includes(g.id));
  return {projects,globalGaps,entries,categories,access,noProjects:projects.length===0,
    roots:access.length?access:globalGaps.filter(g=>g.id!=='NO-TARGETS'),
    counts:{repositories:new Set(projects.map(p=>p.project).filter(Boolean)).size,scopes:projects.length,
      attention:projects.filter(p=>p.status!=='ready').length,ready:projects.filter(p=>p.status==='ready').length,
      unknown:projects.filter(p=>!p.project||!p.branch||p.status==='unverified').length},
    state:projects.length===0?'业务项目未检查':report.status==='ready'?'接入前置就绪':'接入检查需处理'};
}
