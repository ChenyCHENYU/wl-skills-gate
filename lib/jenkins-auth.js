// One approved origin and one in-memory session per client. Password writes
// retain Jenkins' CSRF protection; an explicit rejected crumb is the only
// response that permits one automatic write retry.
const problem=(code,message)=>Object.assign(new Error(message),{code,action:code==='CSRF'?'保持CSRF开启；核对反向代理是否保留会话Cookie和校验字段，或重新选择API Token后运行同一入口。':code==='WRITE-UNKNOWN'?'先读取Jenkins实际对象及运行记录对账，结果未明前不自动重发写入。':code==='NETWORK'?'核对Jenkins入口、DNS、HTTPS证书与网络后运行同一入口。':'保留当前配置与回执，按明确的账号、地址或响应错误修正后运行同一入口。'});
const expect=(ok,code,message)=>{if(!ok)throw problem(code,message);};
export function jenkinsTransport({origin,user,secret,authMode='auto',redirect='error',fetchImpl=fetch}={}){
 const base=new URL(origin);
 expect(base.protocol==='https:'&&base.pathname==='/'&&!base.username&&!base.password&&!base.search&&!base.hash,'ORIGIN','需要批准的Jenkins HTTPS根地址');
 expect(typeof user==='string'&&user&&!/[:\r\n\x00]/.test(user)&&typeof secret==='string'&&secret&&!/[\r\n\x00]/.test(secret),'AUTH-INPUT','需要实际Jenkins登录用户名和所选密码／API Token');
 expect(['auto','token','password'].includes(authMode),'AUTH-INPUT','Jenkins认证方式仅支持token或password');
 const authorization='Basic '+Buffer.from(user+':'+secret).toString('base64'),cookies=new Map();
 let csrf=null,csrfReady=false;
 const endpoint=route=>{const u=new URL(route,base);expect(u.origin===base.origin&&!u.username&&!u.password&&!u.hash,'ORIGIN','请求越出批准Jenkins入口');return u;};
 const send=async(method,route,body,type)=>{
  const url=endpoint(route),headers={Authorization:authorization,Accept:url.pathname.endsWith('/config.xml')?'application/xml':'application/json'};
  if(cookies.size)headers.Cookie=[...cookies].map(([k,v])=>k+'='+v).join('; ');
  if(method!=='GET'&&csrf)headers[csrf.field]=csrf.value;
  if(body!==undefined)headers['Content-Type']=type||'application/xml; charset=utf-8';
  let response;
  try{response=await fetchImpl(url.href,{method,redirect,signal:AbortSignal.timeout(15000),headers,...(body!==undefined?{body}:{})});}
  catch{throw problem(method==='GET'?'NETWORK':'WRITE-UNKNOWN',method==='GET'?'Jenkins请求未确认；核对入口、网络与TLS证书':'Jenkins写入结果未知；先读取实际配置对账，不盲目重试');}
  const values=response.headers?.getSetCookie?.()||[response.headers?.get?.('set-cookie')].filter(Boolean);
  for(const raw of values){const first=raw.split(';',1)[0],i=first.indexOf('='),name=first.slice(0,i),value=first.slice(i+1);expect(i>0&&/^[A-Za-z0-9_.-]{1,100}$/.test(name)&&!/[\r\n\x00]/.test(value)&&value.length<=4096,'RESPONSE','Jenkins会话Cookie格式异常');cookies.set(name,value);}
  expect(cookies.size<=16,'RESPONSE','Jenkins会话Cookie数量异常');
  const chunks=[];let size=0;
  try{for await(const chunk of response.body||[]){size+=chunk.byteLength;expect(size<=8*1024*1024,'RESPONSE','Jenkins响应超出8MiB预算');chunks.push(Buffer.from(chunk));}}
  catch(e){if(e.code==='RESPONSE')throw e;throw problem(method==='GET'?'NETWORK':'WRITE-UNKNOWN',method==='GET'?'Jenkins响应读取未完成':'Jenkins写入响应读取未完成；先对账，不自动重试');}
  return{status:response.status,body:Buffer.concat(chunks).toString('utf8'),headers:response.headers};
 };
 const crumb=async()=>{
  const r=await send('GET','crumbIssuer/api/json');
  // A missing issuer is compatible with an existing server without CSRF;
  // this client never disables the server setting.
  if(r.status===404){csrf=null;csrfReady=true;return;}
  expect(r.status===200,'CSRF','无法获取Jenkins会话校验（HTTP '+r.status+'）；核对认证、权限及反向代理');
  let v;try{v=JSON.parse(r.body);}catch{throw problem('CSRF','Jenkins未返回有效CSRF校验数据；不能用登录页代替');}
  expect(typeof v.crumbRequestField==='string'&&/^[A-Za-z][A-Za-z0-9-]{0,99}$/.test(v.crumbRequestField)&&!['authorization','cookie','host','content-length','content-type','origin','referer','set-cookie'].includes(v.crumbRequestField.toLowerCase())&&typeof v.crumb==='string'&&/^[A-Za-z0-9._~+/=-]{1,512}$/.test(v.crumb),'CSRF','Jenkins CSRF校验字段无效');
  expect(cookies.size>0,'CSRF','Jenkins未返回会话Cookie；检查代理保留Set-Cookie，或改用API Token');
  csrf={field:v.crumbRequestField,value:v.crumb};csrfReady=true;
 };
 return{async request(method,route,body,type){
  expect(['GET','POST'].includes(method),'METHOD','Jenkins客户端仅允许GET或POST');endpoint(route);
  if(method==='POST'&&authMode==='password'&&!csrfReady)await crumb();
  let r=await send(method,route,body,type);
  if(method==='POST'&&r.status===403&&/No valid crumb|No CSRF token|invalid csrf|invalid crumb/i.test(r.body)){
   await crumb();r=await send(method,route,body,type);
   expect(!(r.status===403&&/No valid crumb|No CSRF token|invalid csrf|invalid crumb/i.test(r.body)),'CSRF','Jenkins会话校验仍被拒绝；核对代理会话／Cookie，或选择API Token，不关闭CSRF');
  }
  return r;
 }};
}
