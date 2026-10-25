// UI adapters provide hidden collect(); secrets remain in the calling process.
const fail=(message,action)=>{throw Object.assign(new Error(message),{code:'READ-CREDENTIAL',action});};
export async function collectJenkinsAuth({collect,user,authMode,token,password}={}){
 if(!user||/[:\r\n\x00]/.test(user))fail('Jenkins登录用户名格式无效','填写实际Jenkins登录用户名，不填内部凭据编号。');
 let mode=authMode;
 if(!mode&&token&&!password)mode='token';
 if(!mode&&password&&!token)mode='password';
 if(!mode){const choice=await collect('Jenkins认证方式：1 API Token（推荐），2 登录密码；回车选1');mode=choice===''||choice==='1'?'token':choice==='2'?'password':null;}
 if(!['token','password'].includes(mode))fail('未选择有效的Jenkins认证方式','输入1使用API Token，或输入2使用Jenkins登录密码。');
 const secret=await collect(mode==='password'?'该Jenkins账号的登录密码':'该Jenkins账号本人生成的API Token',mode==='password'?password:token,true);
 if(!secret||/[\r\n\x00]/.test(secret))fail('所选Jenkins认证信息格式无效','重新隐藏输入所选登录密码或API Token；密码与Token不能混填。');
 return{user,secret,authMode:mode};
}

export async function collectJenkinsReadAuth({collect,installationLogin,env={}}={}){
 const user=(await collect('Jenkins巡检登录用户名（已有账号即可，回车沿用本次安装账号）',env.WL_JENKINS_READ_USER))||installationLogin?.user;
 if(user==='wl-jenkins-ci-readonly')fail('填入的是内部凭据编号，不是Jenkins登录用户名','填写实际登录用户名；无需创建同名账号，原凭据未修改。');
 const shared=user===installationLogin?.user;
 if(shared){
  let choice=env.WL_JENKINS_ALLOW_SHARED_READ_ACCOUNT==='1'?'1':await collect('巡检与本次安装使用同一账号。输入1确认复用本次认证并保存为日常巡检凭据，输入2另输该账号的认证；其他输入取消且不保存');
  if(choice!=='1'&&choice!=='2')fail('未确认保存同一账号的巡检凭据','原凭据未修改；可重新运行后确认复用，或填写其他已有Jenkins账号。');
  if(choice==='1'&&installationLogin.secret)return{...installationLogin,sharedAccountPersistenceApproved:true};
 }
 const login=await collectJenkinsAuth({collect,user,authMode:env.WL_JENKINS_READ_AUTH_MODE,token:env.WL_JENKINS_READ_TOKEN,password:env.WL_JENKINS_READ_PASSWORD});
 return{...login,sharedAccountPersistenceApproved:shared};
}
