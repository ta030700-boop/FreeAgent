// Actual service worker against a fake Chrome runtime and WebSocket.
const fs=require("fs"),vm=require("vm"),assert=require("assert");
let listener, sockets=[], frameTimers=[];
const stores={zaToken:"test-token-that-is-long-enough-123456",zaPort:17613};
class WS {
  static OPEN=1;static CONNECTING=0;
  constructor(url){this.url=url;this.readyState=0;this.sent=[];sockets.push(this);}
  send(raw){this.sent.push(JSON.parse(raw));}
  close(){this.readyState=3;this.onclose?.({code:1000});}
}
const chrome={storage:{local:{get:async()=>stores,set:async v=>Object.assign(stores,v)}},
  runtime:{sendMessage:async()=>{},onMessage:{addListener:f=>listener=f},onStartup:{addListener:()=>{}},onInstalled:{addListener:()=>{}}},
  tabs:{query:(q,f)=>f([]),sendMessage:async()=>{},onRemoved:{addListener:()=>{}}}};
const context={chrome,WebSocket:WS,crypto:require("crypto").webcrypto,console,setTimeout,clearTimeout,setInterval:f=>{frameTimers.push(f);return frameTimers.length;},clearInterval:()=>{},Date,Map,Promise};
vm.runInNewContext(fs.readFileSync(__dirname+"/background.js","utf8"),context);
const tick=()=>new Promise(r=>setImmediate(r));
const message=(msg,tab)=>new Promise(resolve=>listener(msg,tab?{tab:{id:tab}}:{},resolve));
const catalogue=[{name:"run_python",approval:true},{name:"run_shell",approval:true},{name:"addon/run_python",approval:true}];
const authenticate=(socket,workspace="project")=>socket.onmessage({data:JSON.stringify({type:"connected",tools:catalogue,servers:[{id:"local",alive:true,tools:2}],workspace})});
(async()=>{
  await tick();const socket=sockets[0];assert(socket.url.endsWith(":17613"));socket.readyState=1;socket.onopen();
  assert.equal(socket.sent[0].type,"auth");assert.equal(socket.sent[0].token,stores.zaToken);
  let s=await message({type:"status"});assert.equal(s.connected,false);console.log("PASS worker authenticates before advertising readiness");
  authenticate(socket);
  s=await message({type:"status"});assert.equal(s.connected,true);assert.equal(s.workspace,"project");console.log("PASS authenticated catalogue and workspace reach the popup");
  const pending=message({type:"call_tool",name:"run_python",arguments:{code:"print(1)"},approved:true},7);await tick();
  const call=socket.sent.find(v=>v.type==="call_tool");assert.equal(call.approved,true);
  const cancelled=message({type:"cancel_active"},7);await tick();
  const cancel=socket.sent.find(v=>v.type==="cancel_tool");assert.equal(cancel.target_id,call.id);
  socket.onmessage({data:JSON.stringify({type:"cancelled",id:cancel.id,ok:true})});await cancelled;
  socket.onmessage({data:JSON.stringify({type:"tool_result",id:call.id,ok:false,kind:"cancelled",error:"Stopped"})});
  const result=await pending;assert.equal(result.ok,false);assert.equal(result.kind,"cancelled");console.log("PASS per-tab Stop reaches the matching bridge request");
  const denied=await message({type:"pair",token:stores.zaToken,port:17613},7);assert.equal(denied.ok,false);console.log("PASS chat content scripts cannot change pairing");
  let permission=await message({type:"tool_permission",name:"run_python"},7);assert.equal(permission.allowed,false);
  const saved=await message({type:"allow_tool",name:"run_python",context:permission.context},7);assert.equal(saved.ok,true);
  assert.equal((await message({type:"tool_permission",name:"run_python"},8)).allowed,true);
  assert.equal((await message({type:"tool_permission",name:"addon/run_python"},8)).allowed,false);
  assert.equal((await message({type:"allow_tool",name:"unknown",context:permission.context},7)).ok,false);
  console.log("PASS saved permission crosses tabs and matches exact available tool names");
  const onceContext=permission.context;
  authenticate(socket,"different-project");
  assert.equal((await message({type:"tool_permission",name:"run_python"},7)).allowed,false);
  assert.equal((await message({type:"allow_tool",name:"run_shell",context:onceContext},7)).ok,false);
  authenticate(socket);permission=await message({type:"tool_permission",name:"run_python"},7);assert.equal(permission.allowed,true);
  console.log("PASS workspace changes isolate grants and reject stale dialogs");
  await Promise.all(["run_shell","addon/run_python"].map(name=>message({type:"allow_tool",name,context:permission.context},7)));
  for(const name of ["run_python","run_shell","addon/run_python"]) assert.equal((await message({type:"tool_permission",name},8)).allowed,true);
  console.log("PASS concurrent grants preserve both tab choices");
  vm.runInNewContext(fs.readFileSync(__dirname+"/background.js","utf8"),{...context});await tick();
  const fresh=sockets.at(-1);fresh.readyState=1;fresh.onopen();authenticate(fresh);
  assert.equal((await message({type:"tool_permission",name:"run_python"},7)).allowed,true);
  console.log("PASS grants survive a fresh service worker");
  const oldToken=stores.zaToken;stores.zaToken="different-paired-bridge-token-123456789";
  vm.runInNewContext(fs.readFileSync(__dirname+"/background.js","utf8"),{...context});await tick();
  const other=sockets.at(-1);other.readyState=1;other.onopen();authenticate(other);
  assert.equal((await message({type:"tool_permission",name:"run_python"},7)).allowed,false);
  stores.zaToken=oldToken;stores.zaPort=17614;
  vm.runInNewContext(fs.readFileSync(__dirname+"/background.js","utf8"),{...context});await tick();
  const otherPort=sockets.at(-1);otherPort.readyState=1;otherPort.onopen();authenticate(otherPort);
  assert.equal((await message({type:"tool_permission",name:"run_python"},7)).allowed,false);
  console.log("PASS pairing and port changes isolate saved permissions");
  await message({type:"reset_tool_permissions"},7);assert.equal(Object.keys(stores.zaToolPermissions).length,0);
  assert.equal((await message({type:"tool_permission",name:"run_python"},7)).allowed,false);
  console.log("PASS reset clears all saved scopes");
})().catch(e=>{console.error(e);process.exitCode=1;});
