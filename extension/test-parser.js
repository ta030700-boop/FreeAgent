// Deterministic command-protocol regression tests, no browser dependencies.
const fs = require("fs"), assert = require("assert");
const p = new Function(fs.readFileSync(__dirname+"/core/parser.js","utf8")+";return ZSParse;")();
const envelope = obj => `###AGENT_TOOL###\n${JSON.stringify(obj)}\n###END_AGENT_TOOL###`;
let passed=0;
function test(name,fn){fn();passed++;console.log("PASS "+name);}
test("marked JSON call",()=>assert.equal(p.parseToolCalls(envelope({command:"read_file",params:{path:"a.txt"}}))[0].tool,"read_file"));
test("paramless catalogue",()=>assert.deepEqual(p.parseToolCalls(envelope({command:"list_commands"}))[0].arguments,{}));
test("unmarked examples never execute",()=>assert.equal(p.parseToolCalls('Example only: {"command":"run_shell","params":{"command":"echo hi"}}').length,0));
test("old Lua commands never execute",()=>assert.equal(p.parseToolCalls('###LUA###return 1###END_LUA###').length,0));
test("raw Python keeps quotes and lines",()=>assert.equal(p.parseToolCalls('###CODE:run_python###\nprint("hi")\nprint(2)\n###END_CODE###')[0].arguments.code,'print("hi")\nprint(2)'));
test("raw shell maps to command",()=>assert.equal(p.parseToolCalls('###CODE:run_shell###\necho "ok"\n###END_CODE###')[0].arguments.command,'echo "ok"'));
test("multiple calls are detected",()=>assert.equal(p.parseToolCalls(envelope({command:"read_file",params:{path:"a"}})+envelope({command:"read_file",params:{path:"b"}})).length,2));
test("mixed JSON and raw calls are detected",()=>assert.equal(p.parseToolCalls(envelope({command:"system_info"})+'###CODE:run_python###print(1)###END_CODE###').length,2));
test("array arguments rejected",()=>assert.equal(p.parseToolCalls(envelope({command:"read_file",params:[1]})).length,0));
test("unexpected wrapper keys rejected",()=>assert.equal(p.parseToolCalls(envelope({command:"run_shell",params:{command:"x"},approved:true})).length,0));
test("truncated JSON is not repaired",()=>assert.equal(p.salvageCutOff('###AGENT_TOOL###{"command":"run_shell","params":{"command":"echo hi"}'),null));
test("missing end marker never dispatches",()=>assert.equal(p.parseToolCalls('###AGENT_TOOL###{"command":"system_info"}').length,0));
test("valid plus malformed never partially dispatches",()=>assert.equal(p.parseToolCalls(envelope({command:"system_info"})+'###AGENT_TOOL###{broken}###END_AGENT_TOOL###').length,0));
test("braces in string survive",()=>assert.equal(p.parseToolCalls(envelope({command:"write_file",params:{path:"a",content:'{"nested":1}'}}))[0].arguments.content,'{"nested":1}'));
test("markers inside JSON data are not commands",()=>{
  const s=envelope({command:"write_file",params:{path:"a",content:'###AGENT_TOOL### ###END_AGENT_TOOL### ###CODE:run_python### print(1) ###END_CODE###'}});
  assert.equal(p.parseToolCalls(s).length,1);assert.equal(p.hasOpenToolBlock(s),false);
});
test("raw control characters repaired inside strings",()=>assert.equal(p.parseToolCalls('###AGENT_TOOL###{"command":"write_file","params":{"path":"a","content":"line1\nline2"}}###END_AGENT_TOOL###')[0].arguments.content,'line1\nline2'));
test("open raw command detected",()=>assert.equal(p.hasOpenToolBlock('###CODE:run_python###print(1)'),true));
test("DSML detected for correction",()=>assert.equal(p.DSML_RE.test('<|DSML|>tool_calls>'),true));
test("feedback classified",()=>assert.equal(p.isInjectedFeedback("Output of 'read_file':\ntext"),true));
console.log(`${passed} protocol tests passed`);
