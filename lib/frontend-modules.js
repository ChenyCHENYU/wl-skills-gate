// 只读解析实际Vite配置依赖图中的模块声明；不加载或执行项目配置。
import path from 'node:path';
import {existsSync,readFileSync,lstatSync} from 'node:fs';
import ts from 'typescript';
import {safePath} from './source-state.js';

export function frontendModuleDeclarations(root){
 const queue=['vite.config.ts','vite.config.js','vite.config.mts','vite.config.mjs'].filter(f=>existsSync(path.join(root,f)));
 const visited=new Set(),remotes=new Map(),virtual=new Map();
 const resolve=(from,spec)=>{
  if(!spec.startsWith('.'))return null;
  const base=path.resolve(root,path.dirname(from),spec),relative=path.relative(root,base).split(path.sep).join('/');
  if(relative==='..'||relative.startsWith('../')||relative.startsWith('node_modules/')||relative.startsWith('src/'))return null;
  for(const candidate of [relative,...['.ts','.js','.mjs','.mts','/index.ts','/index.js'].map(ext=>relative+ext)])if(existsSync(path.join(root,candidate))&&lstatSync(safePath(root,candidate)).isFile())return candidate;
  return null;
 };
 while(queue.length){
  const file=queue.shift();if(visited.has(file))continue;visited.add(file);
  if(visited.size>512)throw Error('Vite配置依赖图超出读取预算');
  const source=readFileSync(safePath(root,file),'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  const bindings=new Map(),plugins=new Set();let hasResolver=false;
  const inspect=node=>{
   if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
    const spec=node.moduleSpecifier.text,child=resolve(file,spec);if(child)queue.push(child);
    if(spec==='@originjs/vite-plugin-federation'&&node.importClause?.name&&existsSync(path.join(root,'node_modules',spec,'package.json')))plugins.add(node.importClause.name.text);
   }
   if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer){
    if(bindings.has(node.name.text))bindings.set(node.name.text,null);else bindings.set(node.name.text,node.initializer);
   }
   if(ts.isMethodDeclaration(node)&&node.name?.getText(ast)==='resolveId')hasResolver=true;
   ts.forEachChild(node,inspect);
  };inspect(ast);
  const object=(node,seen=new Set())=>{
   if(!node)return null;
   if(ts.isIdentifier(node)){if(seen.has(node.text))return null;seen.add(node.text);return object(bindings.get(node.text),seen);}
   if(!ts.isObjectLiteralExpression(node))return null;
   const result=new Map();
   for(const p of node.properties){
    if(ts.isSpreadAssignment(p)){const spread=object(p.expression,new Set(seen));if(!spread)return null;for(const [k,v]of spread)result.set(k,v);}
    else if(ts.isPropertyAssignment(p)&&!ts.isComputedPropertyName(p.name))result.set(p.name.text,p.initializer);
    else if(ts.isShorthandPropertyAssignment(p))result.set(p.name.text,p.name);
    else return null;
   }
   return result;
  };
  const collect=node=>{
   if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&plugins.has(node.expression.text)){
    const config=object(node.arguments[0]),declared=object(config?.get('remotes'));
    for(const name of declared?.keys()||[])if(/^[A-Za-z0-9_-]{1,120}$/.test(name))remotes.set(name,{name,source:file});
    virtual.set('virtual:__federation__',{name:'virtual:__federation__',source:file,provider:'@originjs/vite-plugin-federation'});
   }
   if(hasResolver&&ts.isStringLiteral(node)&&/^virtual:[A-Za-z0-9_:/.-]+$/.test(node.text))virtual.set(node.text,{name:node.text,source:file,provider:'local-vite-resolveId'});
   ts.forEachChild(node,collect);
  };collect(ast);
 }
 return {configFiles:[...visited].sort(),remotes:[...remotes.values()],virtual:[...virtual.values()],remoteAvailabilityVerified:false};
}

export function declaredFrontendModule(spec,declarations){
 return declarations.virtual.some(item=>item.name===spec)||declarations.remotes.some(item=>spec.startsWith(item.name+'/'));
}
