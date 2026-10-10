// SPDX-License-Identifier: GPL-3.0-or-later
const $=id=>document.getElementById(id);
$("version").textContent="v"+chrome.runtime.getManifest().version;
chrome.storage.local.get(["zaToken","zaPort"],r=>{$("token").value=r.zaToken||"";$("port").value=r.zaPort||17613;});
function render(s) {
  $("status").textContent=s.connected?`Connected · ${s.tools} tools`:s.error||(s.pairingRequired?"Paste the pairing token below.":"Bridge offline. Start it on your computer.");
  $("workspace").textContent=s.connected?"Workspace: "+(s.workspace||""):"";
  $("servers").textContent=(s.servers||[]).map(v=>`${v.alive?"●":"○"} ${v.id}: ${v.tools} tools`).join("\n");
}
function refresh(){chrome.runtime.sendMessage({type:"status"},s=>{if(s)render(s);});}
$("pair").onclick=()=>chrome.runtime.sendMessage({type:"pair",token:$("token").value,port:$("port").value},r=>{$("status").textContent=r.ok?"Connecting…":r.error;setTimeout(refresh,500);});
$("reconnect").onclick=()=>chrome.runtime.sendMessage({type:"reconnect"},()=>setTimeout(refresh,500));
$("open").onclick=()=>chrome.tabs.create({url:"https://chat.deepseek.com/"});
chrome.runtime.onMessage.addListener(m=>{if(m.type==="zs-status")render(m);});
refresh();setInterval(refresh,2000);
