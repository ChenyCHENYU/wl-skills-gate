#!/usr/bin/env node
import path from 'node:path';
import {runSetupCli} from '../lib/setup.js';
import {writeExclusiveJson} from '../lib/control-store.js';
import {projectInitializationRoute} from '../lib/init-route.js';
try {
  const args=process.argv.slice(2),command=args.shift()||'init';
  if(command==='--version'){const {GATE_VERSION,gateRuntimeHash}=await import('../lib/jenkins-integration.js');console.log('wl-quality '+GATE_VERSION+' '+gateRuntimeHash());}
  else if(command==='init'){
    const forwarded=[...args];let root=process.cwd();const index=forwarded.indexOf('--root');if(index>=0)root=path.resolve(forwarded[index+1]||'.');
    const route=projectInitializationRoute({root});
    if(route.mode==='workspace'){const sourceIndex=forwarded.indexOf('--registry');if(sourceIndex>=0)forwarded.splice(sourceIndex,2);}
    else if(!forwarded.includes('--registry')&&route.registry)forwarded.push('--registry',route.registry);
    process.exitCode=await runSetupCli([route.mode,...forwarded]);
  }else if(command==='jenkins'&&args[0]==='context'){
    args.shift();const options={},flags=new Set(['--verify-entry']);
    while(args.length){const k=args.shift();if(!['--role','--config','--out','--verify-entry'].includes(k)||Object.hasOwn(options,k))throw Error('未知或重复context参数');if(flags.has(k))options[k]=true;else{const v=args.shift();if(!v||v.startsWith('--'))throw Error('context参数缺值');options[k]=v;}}
    const {resolveJenkinsContext,defaultClusterFile}=await import('../lib/jenkins-cluster.js');const result=await resolveJenkinsContext({role:options['--role'],configFile:options['--config']||defaultClusterFile(process.env),verifyEntry:options['--verify-entry']===true});
    if(options['--out'])writeExclusiveJson(path.resolve(options['--out']),result);else process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }else if(command==='jenkins'&&args[0]==='install'){
    args.shift();const o={};while(args.length){const k=args.shift();if(!['--config','--preview','--json','--confirm','--plan-hash'].includes(k)||Object.hasOwn(o,k))throw Error('未知或重复安装参数');if(['--preview','--json','--confirm'].includes(k))o[k]=true;else{const v=args.shift();if(!v||v.startsWith('--'))throw Error('安装参数缺值');o[k]=v;}}
    if(!o['--config']||o['--preview']&&o['--confirm'])throw Error('安装需要--config，预览不能同时执行');
    const {readControlledJson}=await import('../lib/control-store.js');const {planJenkinsInstallation,applyJenkinsInstallation}=await import('../lib/jenkins-installation.js');const input=readControlledJson(o['--config']),plan=planJenkinsInstallation(input);let result=plan;
    if(o['--confirm'])result=applyJenkinsInstallation({...input,confirm:true,planHash:o['--plan-hash']});
    else if(!o['--preview']&&process.stdin.isTTY&&process.stdout.isTTY&&!o['--json']){const {createInterface}=await import('node:readline/promises');console.log(JSON.stringify(plan,null,2));const prompt=createInterface({input:process.stdin,output:process.stdout});try{if((await prompt.question('输入1确认准备公共入口，Enter取消：')).trim()==='1')result=applyJenkinsInstallation({...input,confirm:true,planHash:plan.planHash});}finally{prompt.close();}}
    console.log(JSON.stringify(result,null,2));
  }else if(command==='jenkins'&&args[0]==='ops'){args.shift();const {runOpsCli}=await import('../lib/jenkins-ops.js');process.exitCode=await runOpsCli(args);}
  else if(command==='jenkins'&&args[0]==='bootstrap'){args.shift();const {runBootstrapCli}=await import('../lib/jenkins-node-bootstrap.js');process.exitCode=await runBootstrapCli(args);}
  else throw Error('用法：wl-quality init；wl-quality jenkins context|install|bootstrap。');
}catch(error){console.error('[wl-quality] '+error.message);process.exitCode=2;}
