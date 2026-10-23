// Machine-local convenience only. This record is never a CI authorization source.
import path from 'node:path';
import {homedir} from 'node:os';
import {existsSync,readFileSync,writeFileSync,mkdirSync,lstatSync,realpathSync,readdirSync,renameSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {nodeRangeSatisfied} from './onboard-environment.js';
import {javaReferenceLock,JAVA_REFERENCE_VERSION,javaDistributionHome} from './java-distribution.js';
import {stableStringify} from './util.js';
import {gateRuntimeHash} from './jenkins-integration.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
const json=x=>JSON.stringify(x,null,2)+'\n';
const fail=message=>{throw new Error(`[quality] 本机环境：${message}；重新运行项目初始化入口确认环境，检查不会跳过。`);};
const ENV={node:'WL_QUALITY_NODE',manager:'WL_QUALITY_PM',maven:'WL_QUALITY_MAVEN',python:'WL_QUALITY_PYTHON',buildJdk:'WL_BUILD_JAVA_HOME',scanJdk:'WL_SCAN_JAVA_HOME',javaScan:'WL_JAVA_SCAN_HOME'};
const CI_STAGES=new Set(['ci','target','promotion','promote','release','deployment','deploy','controller']);
export function controlledProjectEnvironment({env=process.env,stage}={}){
 return !!(env.JENKINS_URL||env.GITLAB_CI||env.CI_PIPELINE_ID||env.WL_GATE_DISPATCH_ID||env.WL_REVIEW_SHA||CI_STAGES.has(stage)||CI_STAGES.has(env.WL_GATE_STAGE)||env.CI&&!/^(?:0|false|no)$/i.test(env.CI));
}
function clean(value){if(typeof value!=='string'||!path.isAbsolute(value)||value.length>8192||/[\x00-\x1f\x7f]/.test(value))fail('只接受无控制字符的绝对路径');return path.resolve(value);}
function plain(file,{directory=false}={}){
 file=clean(file);let current=path.parse(file).root;
 for(const part of file.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const st=lstatSync(current);if(st.isSymbolicLink())fail(`路径不接受符号链接：${current}`);}
 const st=lstatSync(file);if(directory?!st.isDirectory():!st.isFile())fail(`路径类型不正确：${file}`);return file;
}
function canonical(file,directory=false){return plain(realpathSync(clean(file)),{directory});}
function execute(executable,args,env){const r=spawnSync(executable,args,{env:{...env,COREPACK_ENABLE_NETWORK:'0',COREPACK_ENABLE_AUTO_PIN:'0'},encoding:'utf8',shell:false,timeout:15000,maxBuffer:1024*1024});if(r.status!==0||r.error||r.signal)fail(`执行器校验失败：${executable}`);return `${r.stdout||''}\n${r.stderr||''}`.trim();}
function command(name,env){if(path.isAbsolute(name))return canonical(name);for(const dir of (env.PATH||'').split(path.delimiter).filter(Boolean)){for(const suffix of process.platform==='win32'?['','.exe','.cmd']:['']){const file=path.join(dir,name+suffix);if(existsSync(file)){try{return canonical(file);}catch{}}}}return null;}
function tool(name,value,env,launch){let source=path.isAbsolute(value||'')?value:null;if(!source)for(const directory of(env.PATH||'').split(path.delimiter).filter(Boolean)){const candidate=path.join(directory,value||name);if(existsSync(candidate)){source=candidate;break;}}const executable=source?canonical(source):command(value||name,env);if(!executable)fail(`缺少 ${name}，请在首次初始化选择已安装执行器`);const raw=execute(executable,name==='maven'?['-version']:name==='pnpm'?['--version','--config.manage-package-manager-versions=false']:['--version'],env);
 let version=name==='maven'?raw.match(/Apache Maven\s+([\d.]+)/)?.[1]:raw.match(/(?:^|\b)(?:v|Python\s+)?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/)?.[1];
 if(!version)fail(`${name} 未返回有效版本`);if(name==='node'&&!nodeRangeSatisfied('>=22.13.0 <23 || >=24',version))fail(`Node ${version} 不受支持，需要22.13+（22系列）或24+`);
 if(name==='python'&&(Number(version.split('.')[0])!==3||Number(version.split('.')[1])<10))fail(`Python ${version} 不受支持，需要3.10+`);
 const directory=launch?.directory||canonical(path.dirname(source||executable),true),launcher=launch?.launcher||path.basename(source||executable);if(!launcher||launcher!==path.basename(launcher)||canonical(path.join(directory,launcher))!==executable)fail(`${name} 启动器已变化`);return {executable,directory,launcher,sha256:hash(readFileSync(executable)),version};}
function jdk(home,env){home=canonical(home,true);const executable=plain(path.join(home,'bin',process.platform==='win32'?'java.exe':'java'));const compiler=plain(path.join(home,'bin',process.platform==='win32'?'javac.exe':'javac'));
 const raw=execute(executable,['-version'],env),version=raw.match(/(?:openjdk|java) version\s+"([^"]+)"/i)?.[1]||raw.match(/openjdk\s+([\d.]+)/i)?.[1];if(!version)fail(`不能识别JDK：${home}`);const major=Number(version.startsWith('1.')?version.split('.')[1]:version.split(/[._+-]/)[0]);if(!Number.isInteger(major)||major<8)fail(`JDK版本不支持：${version}`);return {home,executable,compiler,sha256:hash(readFileSync(executable)),compilerSha256:hash(readFileSync(compiler)),version,major};}
export function projectEnvironmentDirectory(root){root=realpathSync(root);const r=spawnSync('git',['-C',root,'rev-parse','--absolute-git-dir'],{encoding:'utf8',shell:false});if(r.status!==0)fail('项目必须是Git工作副本');const gitDir=canonical(r.stdout.trim(),true),directory=path.join(gitDir,'wl-quality');if(existsSync(directory))plain(directory,{directory:true});return {root,gitDir,directory,file:path.join(directory,'project-environment.json'),nodeFile:path.join(directory,'node-runtime')};}
function readRecord(location){if(!existsSync(location.file))return null;plain(location.file);const stat=lstatSync(location.file);if(stat.size>65536||process.platform!=='win32'&&((stat.mode&0o077)!==0||typeof process.getuid==='function'&&stat.uid!==process.getuid()))fail('本机记录必须由当前账号持有且仅本人可读写');const value=JSON.parse(readFileSync(location.file,'utf8'));if(value.schemaVersion!==1||value.kind!=='wl-local-project-environment'||value.root!==location.root||value.gitDir!==location.gitDir||value.platform!==process.platform||value.arch!==process.arch||value.notCiAuthorization!==true||!value.tools||Object.keys(value.tools).some(k=>!Object.hasOwn(ENV,k)))fail('本机记录身份或结构无效');return value;}
function analyze(home){home=canonical(home,true);const prepared=javaDistributionHome({WL_JAVA_SCAN_HOME:home});plain(prepared,{directory:true});const lock=javaReferenceLock();for(const item of lock.files){if(!item.path||path.isAbsolute(item.path)||item.path.split('/').some(p=>!p||p==='.'||p==='..'))fail('分析器锁包含无效路径');const file=plain(path.join(prepared,item.path));if(lstatSync(file).size!==item.bytes||hash(readFileSync(file))!==item.sha256)fail(`固定Java分析器摘要不符：${item.path}`);}return {home:prepared,version:JAVA_REFERENCE_VERSION};}
function validate(name,value,env){if(!value||typeof value!=='object')fail(`${name} 记录缺失`);let actual;if(['buildJdk','scanJdk'].includes(name))actual=jdk(value.home,env);else if(name==='javaScan')actual=analyze(value.home);else actual=tool(name==='manager'?value.name:name,value.executable,env,{directory:plain(value.directory,{directory:true}),launcher:value.launcher});if(name==='manager')actual.name=value.name;if(stableStringify(actual)!==stableStringify(value))fail(`${name} 路径、版本或摘要已变化`);return actual;}
function javaCandidates(env,searchRoots){const homes=new Set();for(const h of [env.WL_BUILD_JAVA_HOME,env.WL_SCAN_JAVA_HOME,env.JAVA_HOME])if(h)homes.add(h);
 const java=command('java',env);if(java)homes.add(path.dirname(path.dirname(java)));
 for(const base of searchRoots||[path.join(homedir(),'.jdks'),'/Library/Java/JavaVirtualMachines','/usr/lib/jvm',path.join(env.ProgramFiles||'C:\\Program Files','Java')])if(existsSync(base))for(const child of readdirSync(base).sort()){const home=path.join(base,child);for(const p of [path.join(home,'Contents/Home'),home])if(existsSync(path.join(p,'bin',process.platform==='win32'?'java.exe':'java')))homes.add(p);}
 const found=[];for(const home of homes)try{const item=jdk(home,env);if(!found.some(x=>x.home===item.home))found.push(item);}catch{}return found.sort((a,b)=>b.major-a.major||a.home.localeCompare(b.home));}
function selectedManager(name,version,env){
 const candidates=[name];if(name==='pnpm'&&version){for(const base of [env.COREPACK_HOME,path.join(env.XDG_CACHE_HOME||path.join(homedir(),'.cache'),'node/corepack/v1'),path.join(homedir(),'Library/Caches/node/corepack/v1')].filter(Boolean))candidates.push(path.join(base,'pnpm',version,'bin/pnpm.cjs'));for(const base of [env.PNPM_HOME,path.join(homedir(),'Library/pnpm'),path.join(homedir(),'.local/share/pnpm')].filter(Boolean))candidates.push(path.join(base,'.tools/pnpm',version,'bin/pnpm'));}
 let last;for(const candidate of candidates)try{const value={...tool(name,candidate,env),name};if(!version||value.version===version)return value;last=`${name}@${value.version}`;}catch(error){last=error.message;}fail(`缺少项目固定${name}@${version||'已安装版本'}；${last||''}；只检查已安装执行器和固定本机缓存，不自动下载`);
}
const shellQuote=value=>"'"+String(value).replaceAll("'", "'\"'\"'")+"'";
function localLaunchers(location,tools){if(!tools.manager||tools.manager.launcher===tools.manager.name)return {};const name=tools.manager.name;if(!/^[a-z][a-z0-9-]*$/.test(name))fail('包管理器命令名无效');return {[name]:`#!/bin/sh\nexec ${shellQuote(tools.node.executable)} ${shellQuote(tools.manager.executable)} "$@"\n`};}
function validateLaunchers(location,tools){const expected=localLaunchers(location,tools);if(!Object.keys(expected).length)return null;const directory=path.join(location.directory,'bin');plain(directory,{directory:true});if(readdirSync(directory).sort().join(',')!==Object.keys(expected).sort().join(','))fail('本机工具转发目录含未登记命令');for(const[name,bytes]of Object.entries(expected))if(readFileSync(plain(path.join(directory,name)),'utf8')!==bytes)fail('本机包管理器转发器已变化');return directory;}
function requestedJava(root){const file=path.join(root,'pom.xml');if(!existsSync(file))return null;const text=readFileSync(file,'utf8');for(const key of ['maven.compiler.release','maven.compiler.target','maven.compiler.source','java.version']){const m=text.match(new RegExp('<'+key.replaceAll('.','\\.')+'>\\s*(1\\.)?(\\d+)\\s*</'+key.replaceAll('.','\\.')+'>'));if(m)return Number(m[2]);}return null;}
export function planProjectEnvironment({root=process.cwd(),kind='auto',env=process.env,searchRoots,javaRequired}={}){
 if(controlledProjectEnvironment({env}))return {schemaVersion:1,kind:'local-project-environment-plan',status:'disabled-in-ci',blockers:[],changes:[],tools:{},notCiAuthorization:true};
 const location=projectEnvironmentDirectory(root),prior=readRecord(location),tools={},blockers=[];if(kind==='auto')kind=existsSync(path.join(location.root,'pom.xml'))?'backend':'frontend';
 const get=(name,fn)=>{try{tools[name]=fn();}catch(error){blockers.push({id:`LOCAL-${name.toUpperCase()}`,field:ENV[name],reason:error.message,nextOwner:'当前开发者/项目负责人'});}};
 get('node',()=>env.WL_QUALITY_NODE?tool('node',env.WL_QUALITY_NODE,env):prior?.tools.node?validate('node',prior.tools.node,env):tool('node',process.execPath,env));
 const packageFile=path.join(location.root,kind==='backend'?'quality-tools/package.json':'package.json'),pkg=existsSync(packageFile)?JSON.parse(readFileSync(packageFile,'utf8')):{};
 const manager=kind==='backend'?'npm':String(pkg.packageManager||'pnpm').split('@')[0];
 get('manager',()=>{const value=env.WL_QUALITY_PM?{...tool(manager,env.WL_QUALITY_PM,env),name:manager}:prior?.tools.manager?.name===manager?validate('manager',prior.tools.manager,env):selectedManager(manager,String(pkg.packageManager||'').split('@')[1],env);if(kind==='frontend'&&pkg.packageManager&&pkg.packageManager!==`${value.name}@${value.version}`)fail(`包管理器 ${value.name}@${value.version} 与项目固定 ${pkg.packageManager} 不符`);return value;});
 const policyFile=path.join(location.root,'quality/policy.yml');
 const needsJava=javaRequired??(kind==='backend'&&(!existsSync(policyFile)||/java-scan|\bmvn\b|java-unit/.test(readFileSync(policyFile,'utf8'))));
 if(needsJava){
 const candidates=javaCandidates(env,searchRoots),required=requestedJava(location.root);
 get('buildJdk',()=>{const value=env.WL_BUILD_JAVA_HOME?jdk(env.WL_BUILD_JAVA_HOME,env):prior?.tools.buildJdk?validate('buildJdk',prior.tools.buildJdk,env):candidates.find(x=>x.major===required)||candidates.find(x=>!required||x.major>=required)||fail(`没有匹配项目${required||''}的构建JDK；首次初始化输入JDK目录`);if(required&&value.major<required)fail(`构建JDK${value.major}低于项目要求${required}，请确认新的构建JDK`);return value;});
 get('scanJdk',()=>{const value=env.WL_SCAN_JAVA_HOME?jdk(env.WL_SCAN_JAVA_HOME,env):prior?.tools.scanJdk?validate('scanJdk',prior.tools.scanJdk,env):candidates.find(x=>x.major>=11)||fail('缺少扫描JDK11+；首次初始化输入JDK目录');if(value.major<11)fail('扫描JDK需要11+，不能使用构建JDK8代替');return value;});
 get('python',()=>env.WL_QUALITY_PYTHON?tool('python',env.WL_QUALITY_PYTHON,env):prior?.tools.python?validate('python',prior.tools.python,env):tool('python',['python3','python3.13','python3.12','python3.11','python3.10'].map(x=>command(x,env)).find(Boolean)||'python3',env));
 get('maven',()=>env.WL_QUALITY_MAVEN?tool('maven',env.WL_QUALITY_MAVEN,{...env,JAVA_HOME:tools.buildJdk?.home||env.JAVA_HOME}):prior?.tools.maven?validate('maven',prior.tools.maven,{...env,JAVA_HOME:tools.buildJdk?.home||env.JAVA_HOME}):tool('maven','mvn',{...env,JAVA_HOME:tools.buildJdk?.home||env.JAVA_HOME}));
 get('javaScan',()=>env.WL_JAVA_SCAN_HOME?analyze(env.WL_JAVA_SCAN_HOME):prior?.tools.javaScan?validate('javaScan',prior.tools.javaScan,env):analyze(javaDistributionHome(env)));
 }
 const desired={schemaVersion:1,kind:'wl-local-project-environment',root:location.root,gitDir:location.gitDir,platform:process.platform,arch:process.arch,notCiAuthorization:true,tools};
 const launchers=localLaunchers(location,tools);
 const nodeBytes=tools.node?`${tools.node.sha256}\n${tools.node.executable}\n`:null;
 const nodeBefore=existsSync(location.nodeFile)?readFileSync(plain(location.nodeFile),'utf8'):null;
 const changes=Object.keys(tools).filter(k=>stableStringify(prior?.tools[k]??null)!==stableStringify(tools[k])).map(name=>({name,action:prior?.tools[name]?'update':'register',version:tools[name].version,path:tools[name].home||tools[name].executable}));
 const launcherDirectory=path.join(location.directory,'bin');
 for(const[name,bytes]of Object.entries(launchers))if(!existsSync(path.join(launcherDirectory,name))||readFileSync(plain(path.join(launcherDirectory,name)),'utf8')!==bytes)changes.push({name:`${name}-launcher`,action:'register',version:tools.manager.version,path:path.join(launcherDirectory,name)});
 if(nodeBytes&&nodeBytes!==nodeBefore)changes.push({name:'node-bootstrap',action:nodeBefore?'update':'register',version:tools.node.version,path:location.nodeFile});
 const plan={schemaVersion:1,kind:'local-project-environment-plan',root:location.root,projectKind:kind,runtimeFingerprint:gateRuntimeHash(),gitDir:location.gitDir,recordFile:location.file,nodeBeforeHash:nodeBefore===null?null:hash(nodeBefore),beforeHash:existsSync(location.file)?hash(readFileSync(location.file)):null,desired,tools,changes,blockers,status:blockers.length?'blocked':changes.length?'confirmation-required':'unchanged',notCiAuthorization:true};plan.planHash=hash(stableStringify(plan));return plan;
}
export function applyProjectEnvironment({plan,planHash=plan?.planHash,confirm=false,env=process.env}={}){
 if(controlledProjectEnvironment({env}))fail('CI不接受开发者本机环境登记');if(!confirm||!plan||plan.planHash!==planHash)fail('本机环境需要实际计划摘要与明确确认');const expected={...plan};delete expected.planHash;if(hash(stableStringify(expected))!==planHash||plan.runtimeFingerprint!==gateRuntimeHash()||plan.blockers.length)fail('环境计划已变化或存在缺项');
 const location=projectEnvironmentDirectory(plan.root);if(location.file!==plan.recordFile||location.gitDir!==plan.gitDir||(existsSync(location.file)?hash(readFileSync(plain(location.file))):null)!==plan.beforeHash||(existsSync(location.nodeFile)?hash(readFileSync(plain(location.nodeFile))):null)!==plan.nodeBeforeHash)fail('确认期间本机记录已变化，本次零写入');
 for(const[name,value]of Object.entries(plan.tools))validate(name,value,{...env,...(plan.tools.buildJdk?{JAVA_HOME:plan.tools.buildJdk.home}:{}),PATH:[plan.tools.node?.directory,...(env.PATH||'').split(path.delimiter)].filter(Boolean).join(path.delimiter)});
 if(plan.status==='unchanged')return {status:'unchanged',file:location.file,notCiAuthorization:true};
 mkdirSync(location.directory,{recursive:true,mode:0o700});plain(location.directory,{directory:true});if(process.platform!=='win32'&&(lstatSync(location.directory).mode&0o077)!==0)fail('本机记录目录必须仅本人可访问');
 const write=(file,bytes,mode=0o600)=>{if(existsSync(file))plain(file);const tmp=file+'.'+randomUUID()+'.tmp';try{writeFileSync(tmp,bytes,{flag:'wx',mode});renameSync(tmp,file);}finally{rmSync(tmp,{force:true});}};
 const launchers=localLaunchers(location,plan.tools);if(Object.keys(launchers).length){const directory=path.join(location.directory,'bin');mkdirSync(directory,{recursive:true,mode:0o700});plain(directory,{directory:true});for(const[name,bytes]of Object.entries(launchers))write(path.join(directory,name),bytes,0o700);}
 write(location.nodeFile,`${plan.tools.node.sha256}\n${plan.tools.node.executable}\n`);write(location.file,json(plan.desired));
 return {status:'registered',file:location.file,tools:Object.keys(plan.tools),notCiAuthorization:true};
}
export function resolveProjectEnvironment({root=process.cwd(),env=process.env,stage}={}){
 if(controlledProjectEnvironment({env,stage}))return {env:{...env},status:'disabled-in-ci',record:null,notCiAuthorization:true};
 let location;try{location=projectEnvironmentDirectory(root);}catch(error){if(!existsSync(path.join(root,'.git')))return {env:{...env},status:'not-registered',record:null,notCiAuthorization:true};throw error;}
 const record=readRecord(location);if(!record)return {env:{...env},status:'not-registered',record:null,notCiAuthorization:true};
 const next={...env},resolved={};for(const name of ['node','manager','buildJdk','scanJdk','python','maven','javaScan'].filter(name=>record.tools[name])){const value=record.tools[name],validationEnv={...env,...(resolved.buildJdk?{JAVA_HOME:resolved.buildJdk.home}:{}),PATH:[resolved.node?.directory,...(env.PATH||'').split(path.delimiter)].filter(Boolean).join(path.delimiter)};
  const override=env[ENV[name]],sameOverride=override&&(name==='javaScan'||['buildJdk','scanJdk'].includes(name)?path.resolve(override)===value.home:canonical(override)===value.executable);resolved[name]=override&&!sameOverride?name==='javaScan'?analyze(override):['buildJdk','scanJdk'].includes(name)?jdk(override,validationEnv):{...tool(name==='manager'?value.name:name,override,validationEnv),...(name==='manager'?{name:value.name}:{})}:validate(name,value,validationEnv);
  next[ENV[name]]=resolved[name].home||resolved[name].executable;
 }
 if(resolved.buildJdk)next.JAVA_HOME=resolved.buildJdk.home;
 const launcherDirectory=validateLaunchers(location,resolved);
 const directories=[launcherDirectory,resolved.node?.directory,resolved.manager?.directory,resolved.maven?.directory,resolved.python?.directory,resolved.buildJdk&&path.join(resolved.buildJdk.home,'bin')].filter(Boolean);
 next.PATH=[...new Set([...directories,...(env.PATH||'').split(path.delimiter).filter(Boolean)])].join(path.delimiter);
 return {env:next,status:'loaded',record:location.file,tools:resolved,notCiAuthorization:true};
}
export function activateProjectEnvironment(options={}){const target=options.env||process.env,result=resolveProjectEnvironment({...options,env:target}),before=new Map();if(result.status==='loaded')for(const key of [...Object.values(ENV),'JAVA_HOME','PATH'])if(result.env[key]!==target[key]){before.set(key,target[key]);if(result.env[key]===undefined)delete target[key];else target[key]=result.env[key];}return {...result,restore(){for(const[key,value]of before)if(value===undefined)delete target[key];else target[key]=value;}};}
