// 内置确定性修复只处理可证明冗余的语法；不执行项目提供的修复命令。
import path from 'node:path';
import {readFileSync,writeFileSync,readdirSync,lstatSync,realpathSync,mkdirSync,renameSync,unlinkSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import ts from 'typescript';
import {parse as parseVue} from '@vue/compiler-sfc';
import {safePath,git} from './source-state.js';
import {stableStringify} from './util.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const engineHash=hash(readFileSync(new URL(import.meta.url)));
const assert=(value,message)=>{if(!value)throw Error(message);};
const sourceFile=file=>/\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|vue)$/.test(file)&&!file.endsWith('.d.ts');
const comments=text=>/\/\*|\/\//.test(text);
const literal=node=>ts.isStringLiteral(node)?['string',node.text]:ts.isNumericLiteral(node)?['number',node.text]:[ts.SyntaxKind.TrueKeyword,ts.SyntaxKind.FalseKeyword,ts.SyntaxKind.NullKeyword].includes(node.kind)?['keyword',node.kind]:null;

export function previewSafeSource(source,file='source.ts') {
 const edits=[],skipped=[];
 const blocks=[];
 if(file.endsWith('.vue')){
  const parsed=parseVue(source,{filename:file});
  assert(!parsed.errors.length,'Vue源码无法解析，需先人工处理：'+file);
  for(const block of [parsed.descriptor.script,parsed.descriptor.scriptSetup].filter(Boolean)){
   assert(!block.src,'外部script不在当前文件修复范围：'+file);
   blocks.push({text:block.content,offset:block.loc.start.offset,kind:block.lang==='tsx'?ts.ScriptKind.TSX:ts.ScriptKind.TS});
  }
 }else blocks.push({text:source,offset:0,kind:/\.[jt]sx$/.test(file)?ts.ScriptKind.TSX:ts.ScriptKind.TS});
 for(const block of blocks){
  const ast=ts.createSourceFile(file,block.text,ts.ScriptTarget.Latest,true,block.kind);
  assert(ast.parseDiagnostics.length===0,'源码语法失效，需先人工处理：'+file);
  const nodeTest=/^scripts\/tests\/.*\.(?:test|spec)\.mjs$/.test(file)&&ast.statements.some(n=>ts.isImportDeclaration(n)&&n.moduleSpecifier.text==='node:test');
  const identifiers=new Set();let urlShadowed=false;
  const bindings=node=>{
   if(ts.isIdentifier(node))identifiers.add(node.text);
   if((ts.isVariableDeclaration(node)||ts.isBindingElement(node)||ts.isParameter(node)||ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node)||ts.isImportSpecifier(node)||ts.isNamespaceImport(node)||ts.isImportClause(node))&&node.name&&ts.isIdentifier(node.name)&&node.name.text==='URL')urlShadowed=true;
   ts.forEachChild(node,bindings);
  };bindings(ast);
  let urlHelper='wlFileURLToPath';while(identifiers.has(urlHelper))urlHelper+='Safe';
  let urlConversions=0;
  const add=(node,previous,rule)=>{
   const start=previous.end,end=node.end,text=block.text.slice(start,end);
   if(comments(text)){skipped.push({rule,reason:'冗余项含注释，保留人工核对',line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1});return;}
   assert(/^\s*,[\s\S]*$/.test(text),'候选分隔符不明确，停止修复');
   edits.push({start:start+block.offset,end:end+block.offset,rule});
  };
  const visit=node=>{
   if(nodeTest&&!urlShadowed&&ts.isPropertyAccessExpression(node)&&node.name.text==='pathname'&&ts.isNewExpression(node.expression)&&node.expression.expression.getText(ast)==='URL'){
    const args=node.expression.arguments||[];
    const meta=n=>n&&ts.isPropertyAccessExpression(n)&&n.name.text==='url'&&ts.isMetaProperty(n.expression)&&n.expression.keywordToken===ts.SyntaxKind.ImportKeyword;
    if(args.length===1&&meta(args[0])||args.length===2&&ts.isStringLiteral(args[0])&&!/^[a-z][\w+.-]*:/i.test(args[0].text)&&meta(args[1])){
     edits.push({start:node.getStart(ast)+block.offset,end:node.end+block.offset,text:`${urlHelper}(${node.expression.getText(ast)})`,rule:'node-file-url-path'});urlConversions++;
    }
   }
   if(ts.isNamedImports(node)){
    const seen=new Set();
    node.elements.forEach((item,index)=>{
     const key=JSON.stringify([item.propertyName?.text||item.name.text,item.name.text,item.isTypeOnly]);
     if(seen.has(key)&&index>0)add(item,node.elements[index-1],'duplicate-import-binding');
     seen.add(key);
    });
   }
   if(ts.isObjectLiteralExpression(node)){
    for(let i=1;i<node.properties.length;i++){
     const prior=node.properties[i-1],item=node.properties[i];
     if(!ts.isPropertyAssignment(prior)||!ts.isPropertyAssignment(item)||ts.isComputedPropertyName(prior.name)||ts.isComputedPropertyName(item.name))continue;
     const key=ts.isIdentifier(item.name)||ts.isStringLiteral(item.name)||ts.isNumericLiteral(item.name)?item.name.text:null;
     if(!key||key==='__proto__'||key!==prior.name.text)continue;
     const a=literal(prior.initializer),b=literal(item.initializer);
     if(a&&b&&JSON.stringify(a)===JSON.stringify(b))add(item,prior,'adjacent-identical-literal-property');
    }
   }
   ts.forEachChild(node,visit);
  };
  visit(ast);
  if(urlConversions){
   const imports=ast.statements.filter(ts.isImportDeclaration),position=imports.length?imports.at(-1).end:ast.statements[0]?.getStart(ast)||0;
   edits.push({start:position+block.offset,end:position+block.offset,text:`\nimport {fileURLToPath as ${urlHelper}} from 'node:url';\n`,rule:'node-file-url-helper'});
  }
 }
 // 多个连续冗余项可以相邻，不能让有交叠的修改覆盖未知源码。
 edits.sort((a,b)=>a.start-b.start);
 for(let i=1;i<edits.length;i++)assert(edits[i-1].end<=edits[i].start,'修复候选交叠，保留人工核对');
 let output=source;
 for(const edit of [...edits].reverse())output=output.slice(0,edit.start)+(edit.text||'')+output.slice(edit.end);
 return {output,edits,skipped};
}

function inventory(root,targets){
 assert(Array.isArray(targets)&&targets.length>0,'需要显式源码范围');
 const files=new Set();
 const visit=relative=>{
  assert(relative==='src'||relative.startsWith('src/')||relative==='scripts/tests'||relative.startsWith('scripts/tests/'),'安全修复仅允许src或scripts/tests，不能修改配置、依赖或部署脚本');
  const full=safePath(root,relative),stat=lstatSync(full);
  assert(!stat.isSymbolicLink(),'修复范围不能含符号链接');
  if(stat.isDirectory())for(const name of readdirSync(full).sort())visit(relative+'/'+name);
  else if(stat.isFile()&&sourceFile(relative)){assert(stat.nlink===1,'修复范围含硬链接，保留人工处理');files.add(relative);}
 };
 targets.forEach(visit);return [...files].sort();
}
const planHash=plan=>{const {planHash:ignored,...rest}=plan;return hash(stableStringify(rest));};

export function planSafeRepair({root=process.cwd(),targets=['src']}={}){
 root=realpathSync(root);
 const files=inventory(root,targets),items=[],skipped=[];
 for(const file of files){
  const full=safePath(root,file),source=readFileSync(full,'utf8');
  let result;
  try{result=previewSafeSource(source,file);}catch(error){
   if(!/源码.*解析|源码语法失效|外部script/.test(error.message))throw error;
   skipped.push({file,reason:error.message,rule:'manual-syntax-repair'});continue;
  }
  skipped.push(...result.skipped.map(item=>({file,...item})));
  if(!result.edits.length)continue;
  assert(previewSafeSource(result.output,file).edits.length===0,'修复不幂等：'+file);
  items.push({file,beforeHash:hash(source),afterHash:hash(result.output),edits:result.edits});
 }
 const inventoryState=files.map(file=>({file,hash:hash(readFileSync(safePath(root,file))),mode:lstatSync(safePath(root,file)).mode&0o777}));
 const plan={schemaVersion:1,kind:'wl-safe-syntax-repair',engineHash,root,targets,head:git(['rev-parse','HEAD'],root),inventory:inventoryState,items,skipped,qualityPassed:false,buildAuthorized:false};
 plan.planHash=planHash(plan);return plan;
}

// 应用时重新计算完整计划，拒绝篡改或漂移；输出目录固定，不写Git暂存区。
export function applySafeRepair(plan,{confirm=false}={}){
 assert(confirm,'安全修复需显式--confirm');
 assert(!process.env.JENKINS_URL,'Jenkins检查节点不自动改业务源码；请在开发工作区修复并正常提交复检');
 assert(plan?.kind==='wl-safe-syntax-repair'&&plan.planHash===planHash(plan)&&plan.engineHash===engineHash,'修复计划或执行器已变化，零写入');
 const current=planSafeRepair({root:plan.root,targets:plan.targets});
 assert(stableStringify(current)===stableStringify(plan),'源码、HEAD或候选在预览后变化，零写入');
 const id=randomUUID(),outDir=safePath(plan.root,'quality-reports/safe-repair/'+id);
 mkdirSync(outDir,{recursive:true});
 const written=[],prepared=plan.items.map(item=>{
  const full=safePath(plan.root,item.file),source=readFileSync(full,'utf8'),next=previewSafeSource(source,item.file).output;
  assert(hash(source)===item.beforeHash&&hash(next)===item.afterHash,'修复源码已漂移，零写入');
  return {item,full,source,next,mode:lstatSync(full).mode&0o777};
 });
 const atomic=(file,text,mode)=>{const temporary=file+'.wl-safe-'+id;writeFileSync(temporary,text,{flag:'wx',mode});try{renameSync(temporary,file);}catch(error){unlinkSync(temporary);throw error;}};
 writeFileSync(path.join(outDir,'plan.json'),JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});
 const checkpoint=status=>writeFileSync(path.join(outDir,'state.json'),JSON.stringify({status,completed:written.map(e=>e.item.file),planHash:plan.planHash,sourceRestoreAutomaticallyAuthorized:false},null,2),{mode:0o600});
 checkpoint('prepared');
 try{
  for(let i=0;i<prepared.length;i++){
   const entry=prepared[i];
   assert(hash(readFileSync(entry.full))===entry.item.beforeHash,'执行期间源码变化，停止并恢复本次修改');
   writeFileSync(path.join(outDir,String(i)+'.before'),entry.source,{flag:'wx',mode:0o600});
   atomic(entry.full,entry.next,entry.mode);written.push(entry);
   assert(hash(readFileSync(entry.full))===entry.item.afterHash,'修复后回读不一致');
   checkpoint('applying');
  }
 }catch(error){
  const concurrent=[];
  for(const entry of written.reverse()){
   if(hash(readFileSync(entry.full))!==entry.item.afterHash){concurrent.push(entry.item.file);continue;}
   atomic(entry.full,entry.source,entry.mode);
  }
  writeFileSync(path.join(outDir,'failure.json'),JSON.stringify({reason:error.message,concurrent,ownChangesRestored:!concurrent.length},null,2));
  throw Error(error.message+(concurrent.length?'；存在并发修改，保留备份待人工恢复':''));
 }
 const result={kind:'wl-safe-syntax-repair-receipt',planHash:plan.planHash,root:plan.root,changedFiles:written.map(e=>e.item.file),mechanicalEdits:plan.items.reduce((n,e)=>n+e.edits.length,0),skipped:plan.skipped,verification:'pending-full-rescan',qualityPassed:false,buildAuthorized:false,closed:false,outDir};
 checkpoint('applied-pending-full-rescan');
 writeFileSync(path.join(outDir,'receipt.json'),JSON.stringify(result,null,2));
 return result;
}
