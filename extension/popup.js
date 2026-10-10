// SPDX-License-Identifier: GPL-3.0-or-later
const $=id=>document.getElementById(id);
$("version").textContent="v"+chrome.runtime.getManifest().version;
const CHAT_PROVIDERS = {
  deepseek:{name:"DeepSeek",url:"https://chat.deepseek.com/"},
  chatgpt:{name:"ChatGPT",url:"https://chatgpt.com/"},
  gemini:{name:"Gemini",url:"https://gemini.google.com/"},
  kimi:{name:"Kimi",url:"https://www.kimi.ai/"},
  glm:{name:"GLM / Z.ai",url:"https://chat.z.ai/"},
  qwen:{name:"Qwen",url:"https://chat.qwen.ai/"},
  arena:{name:"Arena (Direct)",url:"https://arena.ai/"},
  meta:{name:"Meta AI",url:"https://www.meta.ai/"}
};
function selectedProvider(){return Object.hasOwn(CHAT_PROVIDERS,$("provider").value)?$("provider").value:"deepseek";}
function updateProviderButton(){$("open").textContent="Open "+CHAT_PROVIDERS[selectedProvider()].name;}
chrome.storage.local.get(["zaToken","zaPort","zaPreferredProvider"],r=>{$("token").value=r.zaToken||"";$("port").value=r.zaPort||17613;$("provider").value=Object.hasOwn(CHAT_PROVIDERS,r.zaPreferredProvider)?r.zaPreferredProvider:"deepseek";updateProviderButton();});
$("provider").onchange=()=>{updateProviderButton();chrome.storage.local.set({zaPreferredProvider:selectedProvider()});};
function render(s) {
  $("status").textContent=s.connected?`Connected · ${s.tools} tools`:s.error||(s.pairingRequired?"Paste the pairing token below.":"Bridge offline. Start it on your computer.");
  $("workspace").textContent=s.connected?"Workspace: "+(s.workspace||""):"";
  $("servers").textContent=(s.servers||[]).map(v=>`${v.alive?"●":"○"} ${v.id}: ${v.tools} tools`).join("\n");
}
function refresh(){chrome.runtime.sendMessage({type:"status"},s=>{if(s)render(s);});}
$("pair").onclick=()=>chrome.runtime.sendMessage({type:"pair",token:$("token").value,port:$("port").value},r=>{$("status").textContent=r.ok?"Connecting…":r.error;setTimeout(refresh,500);});
$("reconnect").onclick=()=>chrome.runtime.sendMessage({type:"reconnect"},()=>setTimeout(refresh,500));
$("open").onclick=()=>chrome.tabs.create({url:CHAT_PROVIDERS[selectedProvider()].url});
chrome.runtime.onMessage.addListener(m=>{if(m.type==="zs-status")render(m);});
refresh();setInterval(refresh,2000);
