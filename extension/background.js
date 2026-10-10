// SPDX-License-Identifier: GPL-3.0-or-later
// Paired loopback connection, per-tab cancellation, no implicit execution retries.
const PROVIDER_URLS = ["https://chat.deepseek.com/*", "https://chatgpt.com/*", "https://chat.openai.com/*", "https://gemini.google.com/*", "https://www.kimi.ai/*", "https://kimi.ai/*", "https://chat.z.ai/*", "https://chat.qwen.ai/*", "https://arena.ai/*", "https://www.meta.ai/*", "https://meta.ai/*"];
let ws = null, connected = false, token = "", port = 17613, nextId = 1, retryTimer, heartbeat, lastFrame = 0, connecting = false;
let snapshot = {connected:false, mcpAlive:false, tools:0, servers:[], studio:null};
const pending = new Map(), active = new Map();
let permissionQueue = Promise.resolve();
// Keep grants private to this extension and scoped to the paired bridge/workspace.
// Serialize storage updates so approvals from different chat tabs cannot overwrite each other.
function toolPermission(msg) {
  const operation = permissionQueue.then(async () => {
    if (msg.type === "reset_tool_permissions") {
      await chrome.storage.local.set({zaToolPermissions:{}});
      return {ok:true};
    }
    if (!connected || !snapshot.workspace || !snapshot.catalogue?.some(t => t.name === msg.name && t.approval))
      return {ok:false,allowed:false,error:"Connect the bridge and select an available tool first."};
    const context = snapshot.permissionContext;
    if (msg.type === "allow_tool" && msg.context !== context)
      return {ok:false,error:"Bridge connection changed. Review the tool again."};
    const scope = JSON.stringify([token,port,snapshot.workspace]);
    const saved = await chrome.storage.local.get("zaToolPermissions");
    if (!connected || snapshot.permissionContext !== context)
      return {ok:false,allowed:false,error:"Bridge connection changed. Review the tool again."};
    const grants = saved.zaToolPermissions || {};
    const tools = Array.isArray(grants[scope]) ? grants[scope] : [];
    if (msg.type === "allow_tool") {
      await chrome.storage.local.set({zaToolPermissions:{...grants,[scope]:[...new Set([...tools,msg.name])]}});
    }
    return {ok:true,allowed:msg.type === "allow_tool" || tools.includes(msg.name),context};
  });
  permissionQueue = operation.catch(() => {});
  return operation;
}
function status() { return {type:"zs-status", ...snapshot, connected}; }
function broadcast() {
  chrome.runtime.sendMessage(status()).catch(() => {});
  chrome.tabs.query({url:PROVIDER_URLS}, tabs => {
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, status()).catch(() => {});
  });
}
function failPending(error) {
  for (const [id, p] of pending) { clearTimeout(p.timer); p.resolve({ok:false, error, kind:"disconnected"}); }
  pending.clear(); active.clear();
}
async function connect() {
  if (connecting) return;
  if (ws && [WebSocket.OPEN,WebSocket.CONNECTING].includes(ws.readyState)) return;
  connecting = true;
  clearTimeout(retryTimer);
  let settings;
  try { settings = await chrome.storage.local.get(["zaToken", "zaPort"]); }
  catch(e) { connecting = false; throw e; }
  token = settings.zaToken || ""; port = Number(settings.zaPort || 17613);
  if (!token) { connecting = false; snapshot.pairingRequired = true; broadcast(); return; }
  snapshot.pairingRequired = false;
  let socket;
  try { socket = new WebSocket(`ws://127.0.0.1:${port}`); ws = socket; }
  finally { connecting = false; }
  socket.onopen = () => { socket.send(JSON.stringify({type:"auth",token})); };
  socket.onmessage = e => {
    if (ws !== socket) return;
    lastFrame = Date.now();
    let m; try { m=JSON.parse(e.data); } catch { return; }
    if (m.type === "connected" || m.type === "tools") {
      const permissionContext = !connected || snapshot.workspace !== m.workspace ? crypto.randomUUID() : snapshot.permissionContext;
      connected = true;
      snapshot = {...snapshot, connected:true, mcpAlive:true, studio:true, studioApp:true, studioProc:true, permissionContext,
                  tools:m.tools?.length || 0, servers:m.servers || [], workspace:m.workspace, catalogue:m.tools || []};
      snapshot.error = null; broadcast();
      if (!heartbeat) heartbeat=setInterval(() => {
        if (connected && Date.now()-lastFrame > 30000) { socket.close(); return; }
        if (connected) send({type:"ping"},10000);
      },10000);
    }
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer); pending.delete(m.id); active.delete(m.id);
      if (m.type === "tool_result") p.resolve(m);
      else if (m.type === "tools") p.resolve({ok:true, tools:m.tools});
      else p.resolve({ok:m.ok !== false && m.type !== "error", ...m});
    }
  };
  socket.onclose = e => {
    if (ws !== socket) return;
    ws = null; connected = false; clearInterval(heartbeat); heartbeat=null;
    failPending("Bridge connection closed; operations were cancelled where supported.");
    snapshot = {...snapshot, connected:false, mcpAlive:false, studio:null, tools:0, servers:[],
                error:e.code===4401 ? "Pairing token rejected. Paste the current bridge token." : e.code===4403 ? "Extension origin rejected." : null};
    broadcast();
    if (![4401,4403].includes(e.code)) retryTimer=setTimeout(connect,2000);
  };
  socket.onerror = () => { try { socket.close(); } catch {} };
}
async function send(obj, timeout=135000, tabId=null) {
  if (!connected) {
    await connect();
    const start=Date.now();
    while (!connected && ws && Date.now()-start<6000) await new Promise(r=>setTimeout(r,100));
  }
  if (!connected || !ws || ws.readyState!==WebSocket.OPEN) return {ok:false,kind:"disconnected",error:snapshot.error || "Pair the extension and start the bridge."};
  return new Promise(resolve => {
    const id=nextId++;
    const timer=setTimeout(() => {
      pending.delete(id); active.delete(id);
      if (obj.type==="call_tool" && connected) send({type:"cancel_tool",target_id:id},5000);
      resolve({ok:false,kind:"timeout",error:"Tool exceeded the extension timeout. Cancellation was requested; do not blindly retry side effects."});
    },timeout);
    pending.set(id,{resolve,timer});
    if (obj.type==="call_tool") active.set(id,tabId);
    try { ws.send(JSON.stringify({...obj,id})); }
    catch(e) { clearTimeout(timer); pending.delete(id); active.delete(id); resolve({ok:false,error:String(e)}); }
  });
}
chrome.runtime.onMessage.addListener((msg,sender,reply) => {
  (async () => {
    try {
      if (!msg || typeof msg.type!=="string") return reply({ok:false,error:"Invalid message"});
      switch(msg.type) {
        case "status": if (!connected) connect(); return reply(status());
        case "list_tools": return reply(await send({type:"list_tools"},10000));
        case "tool_permission": case "allow_tool": case "reset_tool_permissions": return reply(await toolPermission(msg));
        case "call_tool": return reply(await send({type:"call_tool",name:msg.name,arguments:msg.arguments,approved:msg.approved===true},150000,sender.tab?.id));
        case "cancel_active": {
          const ids=[...active].filter(([id,tab])=>tab===sender.tab?.id).map(([id])=>id);
          await Promise.all(ids.map(id=>send({type:"cancel_tool",target_id:id},5000)));
          return reply({ok:true,cancelled:ids.length});
        }
        case "restart_mcp": return reply(await send({type:"restart_mcp"},10000));
        case "add_server": case "remove_server": return reply({ok:false,error:"Edit config.json locally and restart the bridge to change MCP servers."});
        case "pair": {
          if (sender.tab) return reply({ok:false,error:"Pairing is available only in the extension popup."});
          if (typeof msg.token!=="string" || msg.token.trim().length<32 || !Number.isInteger(Number(msg.port)) || Number(msg.port)<1024 || Number(msg.port)>65535)
            return reply({ok:false,error:"Paste the bridge token and a port between 1024 and 65535."});
          await chrome.storage.local.set({zaToken:msg.token.trim(),zaPort:Number(msg.port)});
          clearTimeout(retryTimer); const old=ws; ws=null; connected=false; if(old) old.close();
          clearInterval(heartbeat); heartbeat=null; failPending("Pairing changed");
          await connect(); return reply({ok:true});
        }
        case "reconnect": {
          clearTimeout(retryTimer); const old=ws; ws=null; connected=false; if(old) old.close();
          clearInterval(heartbeat); heartbeat=null; failPending("Reconnecting; pending operations were cancelled.");
          await connect(); return reply({ok:true});
        }
        default: return reply({ok:false,error:"Unknown message"});
      }
    } catch(e) { reply({ok:false,error:String(e)}); }
  })(); return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  for (const [id,tab] of active) if(tab===tabId) send({type:"cancel_tool",target_id:id},5000);
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
