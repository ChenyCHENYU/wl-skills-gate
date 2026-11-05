// 发布版本只以package.json为准，同步受管模板；不变更依赖版本或下载依赖。
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const check=process.argv.slice(2);
if(check.length>1||check.length===1&&check[0]!=='--check')throw Error('用法：sync-package-version.mjs [--check]');
const version=JSON.parse(readFileSync(path.join(root,'package.json'))).version;
if(!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version))throw Error('包版本无效');
const definitions=[
 ['npm-shrinkwrap.json',value=>{value.version=version;value.packages[''].version=version;}],
 ['templates/onboarding/backend/quality-tools.package.json',value=>{value.devDependencies['@agile-team/wl-skills-gate']=version;}],
 ['templates/ci/check-project.config.json',value=>{value.gateVersion=version;}],
 ['templates/quality/rules.lock.json',value=>{value['wl-skills-gate']=version;}]
];
const changed=[];
for(const [relative,update]of definitions){
 const file=path.join(root,relative),original=readFileSync(file,'utf8'),value=JSON.parse(original);update(value);
 const next=JSON.stringify(value,null,2)+'\n';
 if(JSON.stringify(JSON.parse(original))===JSON.stringify(value))continue;
 changed.push(relative);if(!check.length)writeFileSync(file,next);
}
for(const [relative,pattern,replacement]of [
 ['templates/ci/jenkins-bootstrap.py',/env\.get\("WL_BOOTSTRAP_GATE_VERSION", "[^"\n]+"\)/,`env.get("WL_BOOTSTRAP_GATE_VERSION", "${version}")`],
 ['README.md',/本轮统一使用`[^`\n]+`固定版本/,`本轮统一使用\`${version}\`固定版本`]
]){
 const file=path.join(root,relative),original=readFileSync(file,'utf8');
 if(!pattern.test(original))throw Error('受管版本位置未找到：'+relative);
 const next=original.replace(pattern,replacement);
 if(next!==original){changed.push(relative);if(!check.length)writeFileSync(file,next);}
}
if(check.length&&changed.length)throw Error('版本锁未同步：'+changed.join('、')+'；运行npm version或本脚本后再验证');
console.log(JSON.stringify({version,status:check.length?'verified':'synchronized',changed}));
