// Exercise provider selection and saved choice without browser dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function popup(saved={}) {
  const elements=Object.fromEntries(['version','token','port','provider','status','workspace','servers','pair','reconnect','open'].map(id=>[id,{value:'',textContent:''}]));
  const writes=[],tabs=[];
  const context={document:{getElementById:id=>elements[id]},chrome:{storage:{local:{get:(_,cb)=>cb(saved),set:value=>writes.push(value)}},tabs:{create:value=>tabs.push(value)},runtime:{getManifest:()=>({version:'0.1.3'}),onMessage:{addListener:()=>{}},sendMessage:(_,cb)=>cb({connected:true,tools:23,servers:[]})}},setTimeout:()=>{},setInterval:()=>{}};
  vm.runInNewContext(fs.readFileSync(__dirname+'/popup.js','utf8'),context);
  return {elements,writes,tabs};
}
let p=popup();p.elements.open.onclick();assert.equal(p.tabs[0].url,'https://chat.deepseek.com/');
console.log('PASS default provider opens DeepSeek');
p.elements.provider.value='chatgpt';p.elements.provider.onchange();p.elements.open.onclick();assert.equal(p.elements.open.textContent,'Open ChatGPT');assert.equal(p.tabs[1].url,'https://chatgpt.com/');assert.equal(p.writes[0].zaPreferredProvider,'chatgpt');
console.log('PASS selecting ChatGPT updates the launch button, saves and opens its chat');
p=popup({zaPreferredProvider:'chatgpt',zaToken:'local-test-token',zaPort:17614});p.elements.open.onclick();assert.equal(p.elements.provider.value,'chatgpt');assert.equal(p.tabs[0].url,'https://chatgpt.com/');assert.equal(p.elements.token.value,'local-test-token');assert.equal(p.elements.port.value,17614);
console.log('PASS saved ChatGPT choice restores without changing bridge pairing');
p=popup({zaPreferredProvider:'__proto__'});p.elements.open.onclick();assert.equal(p.tabs[0].url,'https://chat.deepseek.com/');p.elements.provider.value='https://example.invalid';p.elements.open.onclick();assert.equal(p.tabs[1].url,'https://chat.deepseek.com/');
console.log('PASS invalid stored or selected values only open an allowed provider');
