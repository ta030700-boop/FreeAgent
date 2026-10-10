// Exercise the actual approval function with a minimal DOM and extension transport.
const fs=require("fs"),assert=require("assert");
const source=fs.readFileSync(__dirname+"/core/main.js","utf8");
const fn=source.slice(source.indexOf("  async function approveTool("),source.indexOf("  async function runTool("));
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.style={};this.textContent="";this.disabled=false;}
  append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
  remove(){this.parent.children=this.parent.children.filter(child=>child!==this);}
  focus(){}
}
function fixture({allowed=false,saveOK=true}={}) {
  const document={body:new Element("body"),createElement:tag=>new Element(tag),addEventListener:()=>{},removeEventListener:()=>{}};
  const A={stop:false},calls=[];
  const bg=async msg=>{calls.push(msg);return msg.type==="tool_permission"?{ok:true,allowed,context:"connection-1"}:saveOK?{ok:true}:{ok:false,error:"Storage unavailable"};};
  const approve=new Function("document","bg","A","setInterval","clearInterval",fn+"\nreturn approveTool;")(document,bg,A,setInterval,clearInterval);
  const button=text=>document.body.children[0].children[0].children.find(child=>child.tag==="button"&&child.textContent===text);
  return {document,A,calls,approve,button};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  let f=fixture();let result=f.approve("run_python",{code:"print(1)"});await tick();
  assert(f.button("Always allow this tool"));f.button("Approve once").onclick();assert.equal(await result,true);
  assert.equal(f.calls.length,1);assert.equal(f.document.body.children.length,0);
  console.log("PASS Approve once executes without saving a grant");
  f=fixture();result=f.approve("run_python",{code:"print(1)"});await tick();await f.button("Always allow this tool").onclick();
  assert.equal(await result,true);assert.deepEqual(f.calls[1],{type:"allow_tool",name:"run_python",context:"connection-1"});
  console.log("PASS Always allow saves the exact tool and reviewed connection");
  f=fixture({allowed:true});assert.equal(await f.approve("run_python",{code:"different arguments"}),true);assert.equal(f.document.body.children.length,0);
  console.log("PASS a saved grant skips the dialog on the next call");
  f=fixture();result=f.approve("run_shell",{code:"echo hi"});await tick();f.button("Deny").onclick();assert.equal(await result,false);assert.equal(f.calls.length,1);
  console.log("PASS Deny does not save approval");
  f=fixture({saveOK:false});result=f.approve("run_shell",{code:"echo hi"});await tick();await f.button("Always allow this tool").onclick();
  assert.equal(f.document.body.children.length,1);assert.equal(f.button("Approve once").disabled,false);
  assert(f.document.body.children[0].children[0].children.some(child=>child.textContent.includes("Storage unavailable")));
  f.button("Deny").onclick();assert.equal(await result,false);
  console.log("PASS storage failure leaves the dialog open and allows denial");
  f=fixture({allowed:true});f.A.stop=true;assert.equal(await f.approve("run_python",{}),false);
  console.log("PASS Stop takes priority over a saved approval");
})().catch(error=>{console.error(error);process.exitCode=1;});
