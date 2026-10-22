import {createHash} from 'node:crypto';
import {parseXml} from './xml.js';
import {stableStringify} from './util.js';
const hash=v=>createHash('sha256').update(v).digest('hex');
export const escapeXml=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export const xmlNode=(name,text='',children=[],attrs={})=>({name,text,children,attrs});
export const xmlOne=(parent,name,required=true)=>{const found=parent.children.filter(c=>c.name===name);if(found.length>1 || required&&found.length!==1)throw Error('Job配置缺失或重复字段：'+name);return found[0];};
export const xmlDescendants=node=>[node,...node.children.flatMap(xmlDescendants)];
export const xmlSet=(parent,node)=>{parent.children=parent.children.filter(c=>c.name!==node.name);parent.children.push(node);};
export function serializeJobXml(node){const attrs=Object.keys(node.attrs).sort().map(k=>' '+k+'="'+escapeXml(node.attrs[k])+'"').join('');const text=node.children.length&&!node.text.trim()?'':node.text;return '<'+node.name+attrs+'>'+escapeXml(text)+node.children.map(serializeJobXml).join('')+'</'+node.name+'>';}
// Only this Declarative metadata action is excluded. Pipeline, parameters,
// triggers, authorization properties and all other configuration remain pinned.
const TRACKER='org.jenkinsci.plugins.pipeline.modeldefinition.actions.DeclarativeJobPropertyTrackerAction';
export function jenkinsJobConfigHash(xml,scheme='raw') {
  if(scheme==='raw')return hash(xml);
  if(scheme!=='stable-v1')throw Error('未知Jenkins配置摘要协议');
  const tree=parseXml(Buffer.isBuffer(xml)?xml.toString('utf8'):xml);
  const canonical=(node,parent)=>{
    if(parent==='actions'&&node.name===TRACKER)return null;
    let children=node.children.map(n=>canonical(n,node.name)).filter(Boolean);
    if(node.name==='properties')children.sort((a,b)=>a.name.localeCompare(b.name));
    return {name:node.name,attrs:Object.fromEntries(Object.entries(node.attrs).sort(([a],[b])=>a.localeCompare(b))),text:node.children.length&&!node.text.trim()?'':node.text.replace(/\r\n/g,'\n'),children};
  };
  return hash(stableStringify(canonical(tree,null)));
}
export function jobContract(xml) {
 const tree=parseXml(Buffer.isBuffer(xml)?xml.toString('utf8'):xml);
 if(tree.name!=='flow-definition')throw Error('只自动接入普通Pipeline任务');
 const definition=xmlOne(tree,'definition');if(definition.attrs.class!=='org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition')throw Error('Job必须使用受控Pipeline script');
 const script=xmlOne(definition,'script').text.replace(/\r\n/g,'\n').trim(),sandbox=xmlOne(definition,'sandbox').text;
 const triggers=xmlDescendants(tree).filter(n=>n.name==='triggers').flatMap(n=>n.children).map(n=>({type:n.name,fields:Object.fromEntries(n.children.map(c=>[c.name,c.name==='secretToken'?!!c.text.trim():c.text]))}));
 const props=xmlOne(tree,'properties',false),parameters=props?.children.filter(n=>n.name==='hudson.model.ParametersDefinitionProperty').flatMap(n=>xmlOne(n,'parameterDefinitions').children.map(v=>({type:v.name,name:xmlOne(v,'name').text,defaultValue:xmlOne(v,'defaultValue',false)?.text||'',description:xmlOne(v,'description',false)?.text||'',trim:xmlOne(v,'trim',false)?.text||'false'})))||[];
 return {script,sandbox,disabled:xmlOne(tree,'disabled').text,triggers,parameters,concurrent:props?.children.some(n=>n.name==='org.jenkinsci.plugins.workflow.job.properties.DisableConcurrentBuildsJobProperty')||false};
}
export function renderFleetJob({beforeXml=null,script,binding,mode,secret,disabled=false}){
 const tree=beforeXml?parseXml(beforeXml):xmlNode('flow-definition','',[],{plugin:'workflow-job'});
 if(tree.name!=='flow-definition')throw Error('不覆盖非Pipeline任务');
 let properties=xmlOne(tree,'properties',false)||xmlNode('properties');
 xmlSet(properties,xmlNode('org.jenkinsci.plugins.workflow.job.properties.DisableConcurrentBuildsJobProperty','',[xmlNode('abortPrevious','false')]));
 xmlSet(properties,xmlNode('hudson.model.ParametersDefinitionProperty','',[xmlNode('parameterDefinitions','',[
  xmlNode('hudson.model.StringParameterDefinition','',[xmlNode('name','WL_REVIEW_SHA'),xmlNode('description','受控续建传入；CHECK无需填写'),xmlNode('defaultValue'),xmlNode('trim','false')]),
  xmlNode('hudson.model.StringParameterDefinition','',[xmlNode('name','WL_GATE_DISPATCH_ID'),xmlNode('description','自动续建追踪ID；不授予审核权限'),xmlNode('defaultValue'),xmlNode('trim','false')])])]));
 // Remove competing trigger containers; only the explicit branch Push survives.
 properties.children=properties.children.filter(n=>n.name!=='org.jenkinsci.plugins.workflow.job.properties.PipelineTriggersJobProperty');
 tree.children=tree.children.filter(n=>n.name!=='triggers');
 let triggers=[];
 if(mode==='check'){
  const old=beforeXml&&xmlDescendants(parseXml(beforeXml)).find(n=>n.name==='com.dabsquared.gitlabjenkins.GitLabPushTrigger');
  const token=old?.children.find(n=>n.name==='secretToken')?.text||secret;
  if(!token)throw Error('创建CHECK需要统一GitLab/Jenkins Webhook Secret；不使用飞书签名密钥');
  triggers=[xmlNode('com.dabsquared.gitlabjenkins.GitLabPushTrigger','',[
   xmlNode('triggerOnPush','true'),xmlNode('triggerOnMergeRequest','false'),xmlNode('triggerOpenMergeRequestOnPush','never'),xmlNode('triggerOnNoteRequest','false'),xmlNode('triggerOnPipelineEvent','false'),xmlNode('branchFilterType','NameBasedFilter'),xmlNode('includeBranchesSpec',binding.branch),xmlNode('excludeBranchesSpec'),xmlNode('secretToken',token)
  ])];
 }
 properties.children.push(xmlNode('org.jenkinsci.plugins.workflow.job.properties.PipelineTriggersJobProperty','',[xmlNode('triggers','',triggers)]));
 xmlSet(tree,properties);xmlSet(tree,xmlNode('definition','',[xmlNode('script',script),xmlNode('sandbox','true')],{class:'org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition',plugin:'workflow-cps'}));
 xmlSet(tree,xmlNode('description',`WL Gate managed | ${binding.project} | ${binding.branch} | ${binding.scope} | ${mode}`));
 xmlSet(tree,xmlNode('disabled',String(disabled)));if(!xmlOne(tree,'actions',false))tree.children.unshift(xmlNode('actions'));
 if(!xmlOne(tree,'keepDependencies',false))xmlSet(tree,xmlNode('keepDependencies','false'));
 return serializeJobXml(tree)+'\n';
}
export function isManagedJob(xml){try{const t=parseXml(xml),d=xmlOne(t,'description',false)?.text||'',s=xmlOne(xmlOne(t,'definition'),'script').text;return d.startsWith('WL Gate managed | ') || s.includes('templates/ci/jenkins-gate.groovy')&&s.includes('WL_REVIEW_SHA');}catch{return false;}}

// Verify the managed contract and every existing unrelated setting. Jenkins may
// serialize plugin version attributes and encrypt secretToken on round-trip.
export function fleetWriteMatches(xml,entry) {
 try {
  if(stableStringify(jobContract(xml))!==stableStringify(entry.contract))return false;
  if(!entry.beforeXml)return true;
  const protectedSettings=value=>{
   const tree=parseXml(value);
   tree.children=tree.children.filter(n=>!['definition','description','disabled','triggers','actions'].includes(n.name));
   const properties=xmlOne(tree,'properties',false);
   if(properties)properties.children=properties.children.filter(n=>!['org.jenkinsci.plugins.workflow.job.properties.DisableConcurrentBuildsJobProperty','hudson.model.ParametersDefinitionProperty','org.jenkinsci.plugins.workflow.job.properties.PipelineTriggersJobProperty'].includes(n.name));
   for(const node of xmlDescendants(tree))if(node.attrs.plugin)node.attrs.plugin=node.attrs.plugin.split('@')[0];
   return jenkinsJobConfigHash(serializeJobXml(tree),'stable-v1');
  };
  return protectedSettings(xml)===protectedSettings(entry.desiredXml);
 }catch{return false;}
}
