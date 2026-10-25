import{test}from'node:test';import assert from'node:assert/strict';
import{jenkinsTransport}from'../../lib/jenkins-auth.js';
import{collectJenkinsAuth,collectJenkinsReadAuth}from'../../lib/jenkins-login.js';
import{fleetClient}from'../../lib/jenkins-fleet-client.js';
const origin='https://jenkins.example.invalid/',user='fixture-user',secret='fixture-private-secret';
const crumb=()=>new Response(JSON.stringify({crumbRequestField:'Jenkins-Crumb',crumb:'abc123'}),{headers:{'Set-Cookie':'JSESSIONID=fixture-session; Path=/; HttpOnly'}});
test('Token写入保持原路径，无额外crumb请求；密码GET同样使用Basic且不写入',async()=>{
 for(const authMode of['token','password']){let n=0;const c=jenkinsTransport({origin,user,secret,authMode,fetchImpl:async(url,o)=>{n++;assert.equal(o.headers.Authorization,'Basic '+Buffer.from(user+':'+secret).toString('base64'));assert.equal(o.redirect,'error');return new Response('ok');}});assert.equal((await c.request(authMode==='token'?'POST':'GET','whoAmI/api/json')).status,200);assert.equal(n,1);}
});
test('密码POST获取crumb并保留同一会话，后续写入复用；Cookie和校验字段不出站',async()=>{
 let gets=0,writes=0;const c=jenkinsTransport({origin,user,secret,authMode:'password',fetchImpl:async(url,o)=>{
  assert.equal(new URL(url).origin,new URL(origin).origin);if(o.method==='GET'){gets++;return crumb();}
  writes++;assert.equal(o.headers.Cookie,'JSESSIONID=fixture-session');assert.equal(o.headers['Jenkins-Crumb'],'abc123');assert.equal(o.body,'body');return new Response('ok');
 }});
 await c.request('POST','createItem?name=fixture','body');await c.request('POST','job/fixture/config.xml','body');assert.equal(gets,1);assert.equal(writes,2);
 await assert.rejects(c.request('POST','https://other.invalid/','body'),/越出批准/);assert.equal(writes,2);
});
test('仅明确拒绝的CSRF请求可取会话后重试一次，权限403及未知网络结果不重复写入',async()=>{
 for(const mode of['crumb','permission','unknown','response-lost']){let posts=0,gets=0;const c=jenkinsTransport({origin,user,secret,fetchImpl:async(url,o)=>{if(o.method==='GET'){gets++;return crumb();}posts++;if(mode==='unknown')throw Error(secret);if(mode==='response-lost')return{status:200,headers:new Headers(),body:(async function*(){throw Error(secret);})()};if(posts===1)return new Response(mode==='crumb'?'No valid crumb was included':'permission denied',{status:403});return new Response('ok');}});
  if(['unknown','response-lost'].includes(mode)){await assert.rejects(c.request('POST','createItem'),e=>e.code==='WRITE-UNKNOWN'&&!e.message.includes(secret));assert.equal(posts,1);assert.equal(gets,0);}
  else{const r=await c.request('POST','createItem');assert.equal(r.status,mode==='crumb'?200:403);assert.equal(posts,mode==='crumb'?2:1);assert.equal(gets,mode==='crumb'?1:0);}
 }
});
for(const mode of['no-cookie','login-html','bad-field','bad-value','issuer401','issuer403','twice-rejected'])test('密码CSRF校验失败不冒充权限或成功 '+mode,async()=>{
 let posts=0;const c=jenkinsTransport({origin,user,secret,authMode:'password',fetchImpl:async(url,o)=>{if(o.method==='POST'){posts++;return new Response('No valid crumb',{status:403});}if(mode==='login-html')return new Response('<html>login</html>');if(mode.startsWith('issuer'))return new Response('',{status:mode==='issuer401'?401:403});return new Response(JSON.stringify({crumbRequestField:mode==='bad-field'?'Authorization':'Jenkins-Crumb',crumb:mode==='bad-value'?'bad\nheader':'abc123'}),{headers:mode==='no-cookie'?{}:{'Set-Cookie':'JSESSIONID=fixture-session; Path=/'}});}});
 await assert.rejects(c.request('POST','createItem'),e=>e.code==='CSRF'&&!e.message.includes(secret));assert.equal(posts,mode==='twice-rejected'?2:0);
});
test('现有服务器未启用crumb时不改安全设置，按实际POST结果处理',async()=>{
 let n=0;const c=jenkinsTransport({origin,user,secret,authMode:'password',fetchImpl:async(url,o)=>{n++;return new Response('',{status:o.method==='GET'?404:200});}});assert.equal((await c.request('POST','createItem')).status,200);assert.equal(n,2);
});
test('同一安装账号明确确认后复用，不再强制独立账号；取消不返回秘密',async()=>{
 const login={user,secret,authMode:'password'};let prompts=[];const c=async(q)=>{prompts.push(q);return prompts.length===1?user:'1';};const r=await collectJenkinsReadAuth({collect:c,installationLogin:login});assert.equal(r.secret,secret);assert.equal(r.authMode,'password');assert.equal(r.sharedAccountPersistenceApproved,true);assert.equal(prompts.length,2);
 prompts=[];await assert.rejects(collectJenkinsReadAuth({collect:async q=>{prompts.push(q);return prompts.length===1?user:'0';},installationLogin:login}),/未确认保存/);assert.equal(prompts.length,2);
});
test('不同账号可选择密码或Token，同一账号也可明确另输新认证；不会自动切换认证方式',async()=>{
 for(const mode of['token','password']){const answers=['another-user',mode==='token'?'1':'2',secret];const r=await collectJenkinsReadAuth({collect:async()=>answers.shift(),installationLogin:{user,secret:'installer-secret',authMode:'token'}});assert.equal(r.user,'another-user');assert.equal(r.authMode,mode);assert.equal(r.secret,secret);assert.equal(r.sharedAccountPersistenceApproved,false);}
 const answers=[user,'2','2','new-password'];const r=await collectJenkinsReadAuth({collect:async()=>answers.shift(),installationLogin:{user,secret,authMode:'token'}});assert.equal(r.secret,'new-password');assert.equal(r.authMode,'password');assert(r.sharedAccountPersistenceApproved);
});
test('已有非交互Token配置兼容，密码空格不截断；错误选项和凭据ID不接受',async()=>{
 const r=await collectJenkinsAuth({collect:async(q,v)=>v,user,token:secret});assert.equal(r.authMode,'token');
 const p=await collectJenkinsAuth({collect:async(q,v)=>v,user,password:'  exact password  '});assert.equal(p.secret,'  exact password  ');
 const answers=['9'];await assert.rejects(collectJenkinsAuth({collect:async()=>answers.shift(),user}),/认证方式/);
 await assert.rejects(collectJenkinsReadAuth({collect:async()=> 'wl-jenkins-ci-readonly',installationLogin:{user,secret,authMode:'token'}}),/内部凭据编号/);
});

test('核心只读和写入客户端支持显式密码环境变量，仍禁止只读客户端写入',async()=>{
 const env={WL_JENKINS_CONFIG_USER:user,WL_JENKINS_CONFIG_PASSWORD:secret,WL_JENKINS_CONFIG_AUTH_MODE:'password',WL_JENKINS_READ_USER:'reader',WL_JENKINS_READ_PASSWORD:'reader-password'};
 const read=fleetClient({origin,env,fetchImpl:async(url,o)=>{assert.equal(o.headers.Authorization,'Basic '+Buffer.from('reader:reader-password').toString('base64'));return new Response('{}');}});
 await read.json('whoAmI/api/json');await assert.rejects(read.request('POST','createItem'),/只读/);
 let writes=0;const writer=fleetClient({origin,env,write:true,fetchImpl:async(url,o)=>{assert.equal(o.headers.Authorization,'Basic '+Buffer.from(user+':'+secret).toString('base64'));if(o.method==='GET')return crumb();writes++;assert.equal(o.headers['Jenkins-Crumb'],'abc123');return new Response('');}});
 await writer.write('test','<project/>',true);assert.equal(writes,1);
});
