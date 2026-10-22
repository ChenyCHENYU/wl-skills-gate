export const fleetAssert=(ok,msg)=>{if(!ok)throw Error(msg);};
export const jobPath=job=>{fleetAssert(typeof job==='string'&&job.length<=250&&/^[\p{L}\p{N}_][\p{L}\p{N}_. -]*(?:\/[\p{L}\p{N}_][\p{L}\p{N}_. -]*)*$/u.test(job),'需要准确的Job路径，视图名不能当Job');return job.split('/').map(v=>'job/'+encodeURIComponent(v)).join('/')+'/';};
export function fleetClient({origin,env=process.env,write=false,fetchImpl=fetch}){
 const url=new URL(origin);fleetAssert(url.protocol==='https:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash,'批量接入只使用批准的HTTPS Jenkins入口');
 const user=env[write?'WL_JENKINS_CONFIG_USER':'WL_JENKINS_READ_USER']||(write?null:env.WL_JENKINS_CONFIG_USER),token=env[write?'WL_JENKINS_CONFIG_TOKEN':'WL_JENKINS_READ_TOKEN']||(write?null:env.WL_JENKINS_CONFIG_TOKEN);
 fleetAssert(typeof user==='string'&&user&&!/[:\r\n]/.test(user)&&typeof token==='string'&&token&&!/[\r\n]/.test(token),'缺少Jenkins服务账号/API Token；配置写入只允许WL_JENKINS_CONFIG_USER/TOKEN');
 const auth='Basic '+Buffer.from(user+':'+token).toString('base64');
 const request=async(method,route,body)=>{
  const endpoint=new URL(route,url);fleetAssert(endpoint.origin===url.origin&&!endpoint.username&&!endpoint.password,'请求越出批准Jenkins入口');
  if(method!=='GET')fleetAssert(write,'只读盘点不写入Jenkins');
  let response;try{response=await fetchImpl(endpoint.href,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:auth,...(body?{'Content-Type':'application/xml; charset=utf-8'}:{})},...(body?{body}:{})});}catch{throw Error('Jenkins请求未确认；先读取实际配置对账，不按成功登记');}
  const chunks=[];let size=0;for await(const chunk of response.body||[]){size+=chunk.byteLength;fleetAssert(size<=8*1024*1024,'Jenkins响应超出8MiB预算');chunks.push(Buffer.from(chunk));}
  return {status:response.status,body:Buffer.concat(chunks).toString('utf8')};
 };
 const json=async route=>{const r=await request('GET',route);fleetAssert(r.status===200,'Jenkins查询失败：HTTP '+r.status);try{return JSON.parse(r.body);}catch{throw Error('Jenkins未返回有效JSON');}};
 return {request,json,async config(job){const r=await request('GET',jobPath(job)+'config.xml');if(r.status===404)return null;fleetAssert(r.status===200,'无法读取Job配置：HTTP '+r.status+'；核对范围内权限');return r.body;},async busy(job){const r=await json(jobPath(job)+'api/json?tree=inQueue,lastBuild[number,building]');return r.inQueue===true||r.lastBuild?.building===true;},async write(job,xml,create=false){const parts=job.split('/'),leaf=parts.pop();const route=create?(parts.length?jobPath(parts.join('/')):'')+'createItem?name='+encodeURIComponent(leaf):jobPath(job)+'config.xml';const r=await request('POST',route,xml);fleetAssert(r.status<400,'Jenkins拒绝配置写入：HTTP '+r.status+'；API Token无需关闭CSRF，核对配置/创建权限');return r.status;}};
}
