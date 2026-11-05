import path from "node:path";
import { runCommand, quote } from "../exec.js";

export function typecheckFindings(output,root,dimension='编码规范'){
 const rows=[];
 for(const line of output.split(/\r?\n/)){
  const match=/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.*)$/.exec(line);
  if(!match)continue;
  const file=path.relative(root,path.resolve(root,match[1])).split(path.sep).join('/');
  if(!file||file==='..'||file.startsWith('../')||path.isAbsolute(file))throw Error('类型诊断文件超出项目范围');
  rows.push({ruleId:'TS/'+match[4],severity:'error',file,line:Number(match[2]),message:match[4]+': '+match[5],dimension,autoFixable:false,baselineAllowed:false,fixCommand:null,
   suggestion:file.startsWith('node_modules/')?'由平台依赖维护者核对类型契约并升级固定包，不直接修改node_modules':'按此文件和行号核对真实类型与调用契约，修复后复扫',context:JSON.stringify({column:Number(match[3]),owner:file.startsWith('node_modules/')?'platform-dependency':'project'})});
 }
 return rows;
}

export async function run(check, ctx) {
  const binPath = check.bin || path.join(ctx.root, "node_modules", ".bin", "vue-tsc");
  const args = check.args || "--noEmit";
  const command = `${quote(binPath)} ${args}`;
  const r = await runCommand(command, { cwd: ctx.root, timeoutMs: Number(check.timeoutMs) || 600000 });
  if (r.timedOut) return { status: "invalid", reason: "类型检查执行超时（工具异常，按 invalid 处理）" };
  if (r.code === null || r.code === 126 || r.code === 127) {
    return {
      status: "invalid",
      reason: `类型检查器不可用: ${binPath}（退出码 ${r.code}）。请先安装：npm i -D vue-tsc typescript，或在 policy 中配置实际 bin；失败关闭，不降级为 warning`,
    };
  }
  if (r.code === 0) return { status: "ok", findings: [], toolVersion: binPath };
  if (![1, 2].includes(r.code)) return { status: "invalid", reason: `类型检查异常退出（${r.code}）` };
  const output = `${r.stdout || ""}\n${r.stderr || ""}`.trim();
  if(r.truncated)return {status:'invalid',reason:'类型诊断输出被截断，不能当作完整结果'};
  let diagnostics;
  try{diagnostics=typecheckFindings(output,ctx.root,check.dimension||'编码规范');}catch(error){return {status:'invalid',reason:error.message};}
  if(diagnostics.length)return {status:'ok',findings:diagnostics,toolVersion:binPath,metrics:{diagnostics:diagnostics.length,project:diagnostics.filter(f=>!f.file.startsWith('node_modules/')).length,platformDependency:diagnostics.filter(f=>f.file.startsWith('node_modules/')).length}};
  return {
    status: "ok",
    findings: [
      {
        ruleId: "TS/TYPEERROR",
        severity: "error",
        file: "(project)",
        line: null,
        message: `类型检查失败，首批输出:\n${output.slice(0, 1500)}`,
        dimension: check.dimension || "编码规范",
        autoFixable: false,
        baselineAllowed: false,
        fixCommand: null,
        context: "typecheck-exit-1",
      },
    ],
    toolVersion: binPath,
  };
}
