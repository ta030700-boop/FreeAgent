// Execute the actual shared loop against deterministic provider/transport fixtures.
const fs=require("fs"), assert=require("assert");
const main=fs.readFileSync(__dirname+"/core/main.js","utf8");
const a=main.indexOf("  async function agentLoop(base) {");
const b=main.indexOf("\n  // Mark the current assistant turn",a);
const loopSource=main.slice(a,b);
const ZS=new Function(fs.readFileSync(__dirname+"/core/config.js","utf8")+";return ZS;")();
const ZSParse=new Function(fs.readFileSync(__dirname+"/core/parser.js","utf8")+";return ZSParse;")();
async function simulate(replies, feedback) {
  const A={imageTools:new Set(),bridge:{connected:true},toolList:[],started:true};
  const sent=[],banners=[];
  const vars={A,ZS,ZSParse,document:{hidden:false},diag:()=>{},
    P:{setInputLock:()=>{},isHardGenerating:()=>false},
    ui:{showStop:()=>{},inputCover:()=>{},banner:(...v)=>banners.push(v),toast:()=>{}},
    waitForResponse:async()=>{if(!replies.length)throw Error("Unexpected extra turn");return replies.shift();},
    submitAndGetBase:async text=>{sent.push(text);return 1;},waitVisible:async()=>true,waitFor:async()=>false,
    decorate:{toolBox:()=>{}},bareToolName:n=>n,argSummary:()=>"",callBody:()=>"",rememberExecuted:()=>{},
    runTool:async()=>feedback,rememberHalted:()=>{},bumpSys:()=>{},withSysResend:s=>s,
    bodyLooksFailed:()=>false,outSummary:()=>"",rememberImageTool:()=>{}};
  const loop=new Function(...Object.keys(vars),loopSource+";return agentLoop;")(...Object.values(vars));
  await loop(0);return {A,sent,banners};
}
(async()=>{
  let r=await simulate(Array.from({length:3},()=>({kind:"parse_error",reason:"malformed",raw:"bad"})),"");
  assert.equal(r.sent.length,2);assert(r.banners.some(v=>v[1]==="Repeated command format errors"));assert.equal(r.A.running,false);
  console.log("PASS loop stops after three format errors");
  r=await simulate(Array.from({length:3},()=>({kind:"tool",calls:[{tool:"a"},{tool:"b"}]})),"");
  assert.equal(r.sent.length,2);assert(r.banners.some(v=>v[2].includes("one command")));
  console.log("PASS loop stops repeated multiple-command replies");
  r=await simulate([{kind:"tool",calls:[{tool:"run_python",arguments:{code:"print(1)"}}]}],"ERROR: user denied approval for 'run_python'.");
  assert.equal(r.sent.length,0);assert(r.banners.some(v=>v[2].includes("denied")));
  console.log("PASS denied approval ends the run without feedback retries");
})().catch(e=>{console.error(e);process.exitCode=1;});
