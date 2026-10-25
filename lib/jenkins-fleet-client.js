import {jenkinsTransport} from './jenkins-auth.js';
export const fleetAssert=(ok,msg)=>{if(!ok)throw Error(msg);};
export const jobPath=job=>{fleetAssert(typeof job==='string'&&job.length<=250&&/^[\p{L}\p{N}_][\p{L}\p{N}_. -]*(?:\/[\p{L}\p{N}_][\p{L}\p{N}_. -]*)*$/u.test(job),'需要准确的Job路径，视图名不能当Job');return job.split('/').map(v=>'job/'+encodeURIComponent(v)).join('/')+'/';};
export function fleetClient({origin,env=process.env,write=false,fetchImpl=fetch}){
 const url=new URL(origin);fleetAssert(url.protocol==='https:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash,'批量接入只使用批准的HTTPS Jenkins入口');
 const prefix=write||!env.WL_JENKINS_READ_USER?'WL_JENKINS_CONFIG':'WL_JENKINS_READ';
 const user=env[prefix+'_USER'],mode=env[prefix+'_AUTH_MODE']||(env[prefix+'_PASSWORD']&&!env[prefix+'_TOKEN']?'password':'auto');
 const token=mode==='password'?(env[prefix+'_PASSWORD']||env[prefix+'_TOKEN']):env[prefix+'_TOKEN'];
 fleetAssert(typeof user==='string'&&user&&!/[:\r\n]/.test(user)&&typeof token==='string'&&token&&!/[\r\n]/.test(token),'缺少Jenkins登录账号及所选密码／API Token；配置写入仅使用安装管理认证');
 const transport=jenkinsTransport({origin,user,secret:token,authMode:mode,fetchImpl});
 const request=async(method,route,body)=>{
  const endpoint=new URL(route,url);fleetAssert(endpoint.origin===url.origin&&!endpoint.username&&!endpoint.password,'请求越出批准Jenkins入口');
  if(method!=='GET')fleetAssert(write,'只读盘点不写入Jenkins');
  return transport.request(method,route,body);
 };
 const json=async route=>{const r=await request('GET',route);fleetAssert(r.status===200,'Jenkins查询失败：HTTP '+r.status);try{return JSON.parse(r.body);}catch{throw Error('Jenkins未返回有效JSON');}};
 return {request,json,async config(job){const r=await request('GET',jobPath(job)+'config.xml');if(r.status===404)return null;fleetAssert(r.status===200,'无法读取Job配置：HTTP '+r.status+'；核对范围内权限');return r.body;},async busy(job){const r=await json(jobPath(job)+'api/json?tree=inQueue,lastBuild[number,building]');return r.inQueue===true||r.lastBuild?.building===true;},async write(job,xml,create=false){const parts=job.split('/'),leaf=parts.pop();const route=create?(parts.length?jobPath(parts.join('/')):'')+'createItem?name='+encodeURIComponent(leaf):jobPath(job)+'config.xml';const r=await request('POST',route,xml);fleetAssert(r.status<400,'Jenkins拒绝配置写入：HTTP '+r.status+'；API Token无需关闭CSRF，核对配置/创建权限');return r.status;}};
}
