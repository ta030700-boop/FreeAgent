// SPDX-License-Identifier: GPL-3.0-or-later
// Explicit command envelopes only. Unmarked JSON examples stay inert.
const ZSParse = (() => {
  const START_M = "###AGENT_TOOL###", END_M = "###END_AGENT_TOOL###";
  // These inherited interface names now refer to raw CODE blocks.
  const LUA_START_RE = /###\s*CODE\s*:\s*(run_python|run_shell)\s*###/i;
  const LUA_END_RE = /###\s*END_CODE\s*###/i;
  const CMD_KEY_RE = /"(?:command|tool)"\s*:\s*"/;
  const DSML_RE = /<[\s\/]*[|｜][\s|｜]*DSML[\s|｜]*[|｜]/i;
  function matchBrace(text, start) {
    let depth = 0, quote = false, escape = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (escape) escape = false;
        else if (c === "\\") escape = true;
        else if (c === '"') quote = false;
      } else if (c === '"') quote = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return i;
    }
    return -1;
  }
  function looseJSON(raw) {
    try { return JSON.parse(raw); } catch {}
    let out = "", quote = false, escape = false;
    for (const c of raw) {
      if (quote) {
        if (escape) { escape = false; out += c; continue; }
        if (c === "\\") { escape = true; out += c; continue; }
        if (c === '"') quote = false;
        if (c === "\n") { out += "\\n"; continue; }
        if (c === "\r") { out += "\\r"; continue; }
        if (c === "\t") { out += "\\t"; continue; }
      } else if (c === '"') quote = true;
      out += c;
    }
    return JSON.parse(out);
  }
  function extractJson(raw) { try { return looseJSON(raw.trim()); } catch { return null; } }
  function normalizeCall(o) {
    if (!o || typeof o !== "object" || Array.isArray(o) || typeof o.command !== "string" || !o.command.trim()) return null;
    const args = o.params === undefined ? {} : o.params;
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    if (Object.keys(o).some(k => !["command", "params"].includes(k))) return null;
    return {tool: o.command, arguments: args};
  }
  function findLuaStart(text, from = 0) {
    const m = LUA_START_RE.exec(text.slice(from));
    return m ? {pos: from + m.index, len: m[0].length, tool: m[1].toLowerCase()} : {pos: -1, len: 0};
  }
  function findLuaEnd(text, from = 0) {
    const m = LUA_END_RE.exec(text.slice(from)); return m ? from + m.index : -1;
  }
  function hasToolSignature(text) { return text.includes(START_M) || LUA_START_RE.test(text) || CMD_KEY_RE.test(text); }
  function hasOpenToolBlock(text) {
    if (parseToolCalls(text).length) return false;
    let from = 0;
    while (true) {
      const start = text.indexOf(START_M, from); if (start < 0) break;
      const end = text.indexOf(END_M, start + START_M.length); if (end < 0) return true;
      from = end + END_M.length;
    }
    from = 0;
    while (true) {
      const start = findLuaStart(text, from); if (start.pos < 0) break;
      const end = findLuaEnd(text, start.pos + start.len); if (end < 0) return true;
      from = end + LUA_END_RE.exec(text.slice(end))[0].length;
    }
    return false;
  }
  function parseToolCalls(text) {
    const found = []; let from = 0, invalid = false;
    while (true) {
      const start = text.indexOf(START_M, from); if (start < 0) break;
      const bodyStart = start + START_M.length;
      const first = bodyStart + (text.slice(bodyStart).match(/^\s*/)?.[0].length || 0);
      const jsonEnd = text[first] === "{" ? matchBrace(text, first) : -1;
      const end = jsonEnd >= 0 ? jsonEnd + 1 + (text.slice(jsonEnd + 1).match(/^\s*/)?.[0].length || 0) : -1;
      if (end < 0 || !text.startsWith(END_M, end)) { invalid = true; break; }
      const call = normalizeCall(extractJson(text.slice(bodyStart, jsonEnd + 1)));
      if (!call) invalid = true; else found.push({pos: start, end: end + END_M.length, call});
      from = end + END_M.length;
    }
    from = 0;
    while (true) {
      const start = findLuaStart(text, from); if (start.pos < 0) break;
      // A marker inside JSON string data is not another executable block.
      if (found.some(v => start.pos > v.pos && start.pos < v.end)) {
        from = found.find(v => start.pos > v.pos && start.pos < v.end).end;
        continue;
      }
      const end = findLuaEnd(text, start.pos + start.len);
      if (end < 0) { invalid = true; break; }
      const source = text.slice(start.pos + start.len, end).trim();
      if (!source) invalid = true;
      else found.push({pos: start.pos, call: {tool: start.tool, arguments: {[start.tool === "run_python" ? "code" : "command"]: source}}});
      from = end + LUA_END_RE.exec(text.slice(end))[0].length;
    }
    return invalid ? [] : found.sort((a,b) => a.pos-b.pos).map(v => v.call);
  }
  function toolNameFromText(text) {
    const raw = LUA_START_RE.exec(text); if (raw) return raw[1].toLowerCase();
    return /"command"\s*:\s*"([^"]*)/.exec(text)?.[1]?.trim() || "command";
  }
  function isInjectedFeedback(text) { return /^\s*(?:Output of '|ERROR\b|\(System note:)/.test(text); }
  function hasCommandShape(text) { return hasToolSignature(text) || DSML_RE.test(text); }
  function salvageCutOff() { return null; } // Never guess an executable repair.
  return {START_M, END_M, LUA_START_RE, LUA_END_RE, CMD_KEY_RE, DSML_RE, matchBrace, extractJson,
    normalizeCall, findLuaStart, findLuaEnd, hasToolSignature, hasOpenToolBlock, parseToolCalls,
    toolNameFromText, isInjectedFeedback, hasCommandShape, salvageCutOff};
})();
