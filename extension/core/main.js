// SPDX-License-Identifier: GPL-3.0-or-later
// core/main.js - the provider-agnostic agentic loop, UI and session state.
// Drives any AI chat site through the ZSProvider interface (providers/*.js):
// waits for the model's reply, parses FreeAgent commands (ZSParse), asks the
// background worker to execute them on the local agent MCP bridge, and feeds the
// result back. Camouflages the system prompt ("Starting Up") and tool JSON
// behind animated chips, masks injected input, and exposes a Stop button.
// The model ALWAYS receives an output.
//
// This file must NEVER touch the host site's DOM directly - everything
// site-specific goes through P (the provider). Our OWN UI (panel, chips,
// banners…) is plain DOM we create ourselves and is allowed here.

(() => {
  "use strict";
  const P = ZSProvider;
  const T = P.timings;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log("[zeroscript]", ...a);

  // ── Anti-bot mitigation (EXPERIMENTAL) ──────────────────────────────────
  // Suspected contributor to Arena's captcha: the agentic loop sends turns
  // back-to-back with near-zero, perfectly regular delay (~200ms settle),
  // which behavioral risk-scoring (reCAPTCHA/Cloudflare) can read as a bot
  // signal alongside the necessarily-synthetic input events. This adds a
  // small randomized human-reaction-time delay before each send.
  // REVERT: flip HUMANIZE_SEND to false - single toggle, no other changes needed.
  const HUMANIZE_SEND = false; // didn't prevent Arena's captcha (fires on turn 1 already) - revert
  const SEND_JITTER_MS = [400, 1400]; // [min, max] ms, randomized per send
  function jitterBeforeSend() {
    if (!HUMANIZE_SEND) return Promise.resolve();
    const [lo, hi] = SEND_JITTER_MS;
    return sleep(lo + Math.random() * (hi - lo));
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────
  // Persistent, lightweight breadcrumb log of the agentic loop's key decisions
  // (sends, response kinds, tool start/end, resumes, stops). Read back from the
  // console (filter "[zs-diag]") or window.__zsDiag (also mirrored onto a hidden
  // DOM node for a main-world inspector). Each entry carries a turn snapshot.
  const ZS_DIAG_MAX = 300;
  const _diag = [];
  function diag(event, data) {
    const snap = { ...P.snapshot(), gen: P.isGenerating(), run: A.running };
    const e = { t: Date.now(), iso: new Date().toISOString().slice(11, 23), event,
                data: data || null, snap };
    _diag.push(e);
    if (_diag.length > ZS_DIAG_MAX) _diag.shift();
    try { console.log("[zs-diag]", e.iso, event, JSON.stringify({ ...data, ...snap })); } catch {}
    try {
      let n = document.getElementById("zs-diag-log");
      if (!n) { n = document.createElement("script"); n.type = "application/json"; n.id = "zs-diag-log"; (document.body || document.documentElement).appendChild(n); }
      n.textContent = JSON.stringify(_diag);
    } catch {}
    try { window.__zsDiag = _diag; } catch {}
  }
  P.init({ diag });

  // ── [TRACE] Main-thread stall detector ─────────────────────────────────────
  // The reported bug ("tools spin 15-20s, the chip timer stops rising") can only
  // be a SYNCHRONOUS block of the page's main thread: an async bridge/network wait
  // yields, so the 200ms UI interval (and its chip timer) would keep ticking. This
  // fires every 250ms and, whenever the ACTUAL gap since the last tick is far more
  // than expected, logs the stall. A `stall.detected` with a big `ms` right when
  // the user sees the freeze = the smoking gun; correlate its timestamp with the
  // surrounding diag events (esp. code.snapAll / dom.read.slow) to see WHAT ran.
  {
    const EXPECT = 250, STALL = 800; // only log gaps beyond this many ms
    let _lastTick = Date.now();
    setInterval(() => {
      const now = Date.now();
      const gap = now - _lastTick;
      _lastTick = now;
      if (gap > STALL) {
        diag("stall.detected", { ms: gap, overBy: gap - EXPECT,
          toolRunning: A.toolRunning, running: A.running, injecting: A.injecting });
      }
    }, EXPECT);
  }

  const A = {
    running: false,
    stop: false,
    // stopping: the user clicked Stop and we are winding the loop down. Set the
    // instant the button is clicked so the bar can show immediate "Stopping…"
    // feedback and keep the button steady (no flicker) until the loop's finally
    // clears it - the live generation signal toggles off/on as the loop drains,
    // which otherwise made the Stop button vanish then reappear.
    stopping: false,
    // userStopped: the user deliberately halted generation - via our "■ Stop"
    // button OR the site's native stop. While set, the auto-resume watchdog
    // must NOT relaunch or re-run a tool from the halted turn.
    userStopped: false,
    // lastGenAt: timestamp of the last moment the site was actively generating.
    // The auto-resume watchdog only acts on a tool call from a RECENT live
    // generation - never on a historical turn rendered by opening/scrolling.
    lastGenAt: 0,
    started: false,
    starting: false,
    // The conversation a bootstrap belongs to + a generation counter. If the user
    // navigates to another chat mid/post-bootstrap, syncSessionState bumps the
    // counter (invalidating the in-flight startSession) and clears `starting`, so
    // the new chat shows its own state instead of a stale "Starting…".
    startingKey: null,
    startGen: 0,
    // The conversation a RUNNING loop is bound to. If the user opens a new, empty
    // chat via the site's own button, syncSessionState abandons the loop so the
    // fresh chat shows "Start", not a stale "Agent active".
    loopKey: null,
    // Identity of the assistant turn ALREADY present when the current session
    // started. A page reload can RESTORE an in-progress generation (e.g. an
    // execute_luau that was mid-stream in an A/B turn); that restored turn looks
    // like a fresh live tool finish to the auto-resume watchdog, which then ran it
    // into the NEW conversation the user had just opened (validated live, 2026-06).
    // autoResume never resumes the turn whose id matches this baseline.
    bootBaselineId: null,
    injecting: false,
    toolRunning: false,
    toolStart: 0,
    toolName: "",
    toolItem: null,
    toolArg: "",
    toolList: [],
    toolNames: new Set(),
    // Successful tool calls since the last command-list reminder. DeepSeek (and
    // others) can drift away from the exact command names over a long session,
    // so we re-inject the list every REMIND_TOOLS_EVERY calls (see agentLoop).
    toolCallsSinceReminder: 0,
    // When the system prompt was last re-stated. Diagnostic only - whether one
    // is OWED is derived from the conversation itself, never from a counter
    // (see sinceLastSys / sysResendDue).
    sysResendAt: 0,
    // This page outlived its extension build - nothing works until a reload.
    // Latched (never cleared): the context cannot come back. See bg().
    staleExtension: false,
    bridge: { connected: false, mcpAlive: false, tools: 0 },
    // Images from the most recent tool result, stashed by runTool for the
    // upcoming submitAndGetBase/typeAndSend call to attach as the LAST step
    // before sending (see the comment in runTool's r.images branch).
    pendingImages: null,
    // BARE names of tools observed to return images at least once this session.
    // For the KNOWN local agent vision tool (screen_capture) toolCategory already
    // gives the "screen" chip optimistically at run time; a custom MCP tool's
    // name tells us nothing, so we can't predict it - but once we've SEEN it
    // return an image we can be optimistic on its NEXT call. Populated in the
    // agent loop's result branch when A.pendingImages lands.
    imageTools: new Set(),
    // True while the loop is parked waiting for this tab to come back to the
    // foreground (see waitVisible/parkHidden). Drives the bar's "Paused" state.
    parked: false,
    // Timestamp of the last successful tool-catalogue refresh (see ensureTools).
    toolsAt: 0,
  };

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // Park until the AI tab is the FOREGROUND tab of its window again (or the user
  // halts). Deliberately has NO time cap: a tab minimized/backgrounded for an
  // hour must resume cleanly, not silently time out into a "could not send /
  // not run" failure. (A plain waitFor with a finite timeout returned false on a
  // long minimize, which broke the send loop and ended the agent loop.) Returns
  // false ONLY if the user stopped while we were parked, so callers can break.
  // EVENT-DRIVEN, not polled. A chained setTimeout loop is subject to Chrome's
  // "intensive throttling": once a tab has been hidden >5 min, chained timers are
  // clamped to ONE tick per minute, so a sleep(300) poll could take up to a full
  // minute to notice the tab came back - the user sees the bar sit on "Paused"
  // long after they returned. visibilitychange fires immediately on unhide, so we
  // race it against a slow stop-poll (the stop path is not latency-critical).
  async function waitVisible() {
    if (!document.hidden || A.stop) return !A.stop;
    A.parked = true;
    try { ui.setStarting(); } catch {}
    try {
      await new Promise((resolve) => {
        const done = () => {
          document.removeEventListener("visibilitychange", onVis);
          clearInterval(iv);
          resolve();
        };
        const onVis = () => { if (!document.hidden) done(); };
        document.addEventListener("visibilitychange", onVis);
        // Safety net only: covers a stop click while parked, and the (unlikely)
        // case of a missed visibilitychange event.
        const iv = setInterval(() => { if (A.stop || !document.hidden) done(); }, 1000);
      });
    } finally {
      A.parked = false;
      try { ui.setStarting(); } catch {}
    }
    return !A.stop;
  }

  // Park while the tab is hidden and report how long we were parked, so callers
  // can slide their timers forward by that amount. Without this, every deadline
  // inside waitForResponse (inactivity timeout, warm-up, text-stability) keeps
  // ticking while nothing can be read - which is what turned "user switched to
  // Studio for 5 minutes" into "No response from <site>, the loop has stopped"
  // and left the pending command showing a grey "not run".
  async function parkHidden() {
    if (!document.hidden || A.stop) return 0;
    const t0 = Date.now();
    await waitVisible();
    const parked = Date.now() - t0;
    diag("park.resumed", { parkedMs: parked });
    // Give the site a beat to repaint: a tab that was hidden has no layout, so
    // the first reads after unhide can come back stale/blank.
    if (!A.stop) await sleep(400);
    return parked;
  }

  // Submit `text` as a new turn, masking the input while we type. Returns the
  // assistant-item count BEFORE the reply (waitForResponse waits beyond it).
  // Snapshot the identity of the assistant turn present BEFORE we send. Paired
  // with waitForResponse, this lets "a new reply turn exists" be tested by node
  // identity rather than a raw count - the latter is unreliable on providers that
  // virtualize the message list, where the count stays flat as a new
  // turn appears and old ones detach. Captured at every send site (tool feedback,
  // user message, bootstrap). Providers without lastAssistantId fall back to count.
  function captureSendToken() {
    A.sendToken = P.lastAssistantId ? P.lastAssistantId() : undefined;
  }

  async function submitAndGetBase(text, images) {
    captureSendToken();
    diag("send", { text: String(text).slice(0, 60), busy: P.isBusyNow() });
    A.injecting = true;
    ui.inputCover(true);
    try {
      // Quick 2-point settle: sample the previous response's stream length before
      // and after a 200ms yield. A one-shot React batch flush (the common case)
      // shows no second growth and costs only 200ms. A genuinely still-generating
      // stream shows growth → fall back to the full idle wait.
      const _settleItem = P.lastAssistant();
      const _settleLen0 = _settleItem ? P.streamLen(_settleItem) : 0;
      await sleep(200);
      if (_settleItem && _settleItem === P.lastAssistant() &&
          P.streamLen(_settleItem) > _settleLen0) {
        await waitFor(() => !P.isGenerating(), 4000);
      }
      const base = P.assistantCount();
      const preUser = P.userCount();
      // Arm the optimistic pre-hide for the result turn we're about to inject:
      // the very next NEW user turn is ours, so preHideWholeItems can mask it on
      // creation instead of waiting for its "Output of '…'" caption to render
      // (which lands a tick after the node - especially with an attached image -
      // and would otherwise flash the raw output for the 200/700ms until a sweep
      // nudge catches it). See preHideWholeItems.
      A.injectPreUser = preUser;
      A.injectHideUntil = Date.now() + 2500;
      // "Landed" = a new turn appeared in the DOM. In long chats, list
      // virtualisation can keep counts flat even when our message landed - the
      // textarea-cleared signal below is the primary fast gate.
      const landed = () => P.userCount() > preUser || P.assistantCount() > base;
      // CRITICAL: never type/send while the tab is HIDDEN. Background tabs throttle
      // rendering, which made the landed-check unreliable and caused the SAME
      // feedback to be sent several times. Send ONLY while visible.
      let tries = 0;
      let messageSent = false;
      while (!messageSent && !landed() && tries < 4 && !A.stop) {
        if (document.hidden) {
          diag("send.waitVisible", { tries });
          if (!(await waitVisible()) || A.stop) break; // park (no cap) until foreground; break only on user stop
        }
        await jitterBeforeSend();
        diag("submit.typeAndSend", { hasImages: !!(images && images.length) });
        await P.typeAndSend(text, images);
        // Re-arm the pre-hide window NOW that typeAndSend has returned (the send
        // was just clicked, so our result turn is about to render). The initial
        // arm above can EXPIRE during an image upload - typeAndSend blocks ~3-6s
        // uploading the capture before the turn appears, past the 2.5s window - so
        // without this re-arm the raw "Output of…" + a still-loading (0-byte)
        // thumbnail flash for image feedbacks until a sweep chip lands. Safe: the
        // input is covered and the loop owns this send, so no user turn can slip
        // into the window, and the pre-hide is one-shot (consumes the first turn).
        A.injectHideUntil = Date.now() + 2500;
        // The site clears the textarea as soon as the send is accepted - faster
        // and more reliable than waiting for a DOM turn count change.
        await waitFor(() => {
          if (P.editorText().trim() === "") messageSent = true;
          return messageSent || landed();
        }, 3500);
        tries++;
      }
      if (messageSent) diag("send.cleared", { tries });
      // All retries exhausted with NO evidence the message landed (textarea never
      // cleared, no new turn). Silently returning here left the loop waiting for
      // a reply that will never come (~60s "empty" timeout) with zero explanation
      // - the reported "the tool result just never gets injected" symptom. Tell
      // the user what actually happened so they can nudge the conversation
      // themselves instead of watching a stuck bar.
      if (!messageSent && !landed() && !A.stop) {
        diag("send.failed", { tries });
        ui.banner("warn", "Message could not be sent",
          `${P.displayName} did not accept the injected message after ${tries} attempts. ` +
          `Send a short message yourself (e.g. "continue") to resume the agent.`);
      }
      return base;
    } finally {
      // During Starting Up / the agent loop, the bootstrap or loop owns the cover
      // for the whole phase, so don't lift it here between an injection and the
      // next waitForResponse - it stays up until the loop / bootstrap ends.
      if (!A.starting && !A.running) ui.inputCover(false);
      setTimeout(() => (A.injecting = false), 400);
      // Camouflage the turn we just injected without waiting on the rAF observer
      // (paused in a background tab). A couple of nudges cover the render.
      setTimeout(scheduleSweep, 200);
      setTimeout(scheduleSweep, 700);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RESPONSE WATCHER  (generating-flag driven - robust to DOM churn)
  // ════════════════════════════════════════════════════════════════════════
  async function waitForResponse(base) {
    const t0 = Date.now();
    // INACTIVITY timeout (not total-elapsed): the loop only gives up after this
    // long with NO streaming AND no text change. lastActiveAt is refreshed every
    // tick the model is generating or the reply text grows, so an arbitrarily
    // LONG but still-active response never trips it (the old total-elapsed cap
    // wrongly fired "No response" while the model was still writing past 300s).
    const TIMEOUT = T.RESPONSE_TIMEOUT_MS;
    let lastActiveAt = Date.now();
    const STABLE_MS = T.STABLE_MS; // generating-flag stuck ON but text frozen → done
    let started = false, doneSince = 0, lastLimitScan = 0;
    let lastText = null, lastChangeAt = Date.now(), genFalseSince = 0;
    // ── DIAG: finalisation-latency instrumentation (multi_edit "slow" probe) ──
    // genOffFirstAt: the FIRST moment gen went false after streaming began (does
    // NOT reset on flicker, unlike genFalseSince). genFlickers: how many times gen
    // flipped back true after having been false - a high count means post-stop DOM
    // churn (or a wedged stop button) is what keeps the watcher alive. waitedBlock/
    // waitedFlicker: iterations spent waiting because effectiveBlock held vs because
    // gen was (re)true. These pinpoint which gate causes any tail latency.
    let genOffFirstAt = 0, genFlickers = 0, prevGen = null;
    let waitedBlock = 0, waitedFlicker = 0;
    const finalizeDiag = (kind) => {
      const now = Date.now();
      diag("stopGoneToResp", {
        kind,
        stopGoneToRespMs: genOffFirstAt ? now - genOffFirstAt : null,
        genStableForMs: genFalseSince ? now - genFalseSince : null,
        lastChangeAgoMs: now - lastChangeAt,
        genFlickers, waitedBlock, waitedFlicker,
        totalMs: now - t0,
      });
    };
    let preStartSilent = 0; // nothing produced AND not generating
    let curItem = null, sawContent = false, warmSince = 0; // per-turn "warming up"
    // Last NON-EMPTY reply read for the CURRENT turn. Sites re-render a turn's
    // subtree (React/Monaco churn) and a read can come back "" for a frame at
    // the exact moment the watcher finalizes - the turn then ended as
    // kind:"empty" even though a (possibly cut-off) command was sitting there a
    // tick earlier, leaving a DEAD turn: no parse_error feedback, and the
    // autoResume dedupe (zResume) blocks any later retry (validated live on a
    // Qwen post-stop regenerate, 2026-07). Classify on this fallback instead of
    // declaring empty. Reset whenever the turn NODE changes so a new turn can
    // never inherit the previous turn's text.
    let lastGoodReply = "";
    let reasonSince = 0; // reasoning written but no answer yet (loading phase)
    let noTurnSince = 0; // finalize attempted before this send's reply turn exists
    let unsettledSince = 0; // command-shaped reply whose read is not yet stable
    const WARMUP_MS = T.WARMUP_MS;
    const REASON_NOREPLY_MS = T.REASON_NOREPLY_MS;
    const NO_TURN_GRACE_MS = 30000;
    // Upper bound on holding off a parse verdict while a provider reports its
    // read is unsettled (Qwen A/B dual turn still landing). A genuinely stuck
    // read still resolves after this and is parsed as-is.
    const UNSETTLED_GRACE_MS = 8000;
    // Once the generating flag has been OFF this long, the model has clearly
    // stopped streaming - so an "open tool block" reading is a DOM-churn/parse
    // artifact, not live output, and must not keep the watcher waiting. Provider
    // -neutral: while a model is genuinely streaming, gen stays true and this is
    // never reached.
    const GEN_STOP_GRACE_MS = 2500;

    while (Date.now() - lastActiveAt < TIMEOUT) {
      if (A.stop) return { kind: "stopped" };
      // NEVER let a deadline expire while the tab is in the background. A hidden
      // tab has no layout (innerText reads come back "", getBoundingClientRect is
      // 0x0) and Chrome throttles its timers, so every read here is unreliable -
      // and the site may legitimately keep streaming for as long as the user is
      // away in Studio. Park until the tab is foreground again, then slide EVERY
      // deadline forward by the time we were parked so nothing that was mid-flight
      // when the user switched away expires the moment they come back. This is the
      // fix for "I switched to Studio, came back and the command says 'not run'":
      // the loop used to burn its 5-minute inactivity budget off-screen, end with
      // "No response from <site>", and orphan the pending command.
      if (document.hidden && !A.stop) {
        const parked = await parkHidden();
        if (A.stop) return { kind: "stopped" };
        if (parked) {
          lastActiveAt += parked; lastChangeAt += parked;
          if (doneSince) doneSince += parked;
          if (genFalseSince) genFalseSince += parked;
          if (preStartSilent) preStartSilent += parked;
          if (warmSince) warmSince += parked;
          if (reasonSince) reasonSince += parked;
          if (noTurnSince) noTurnSince += parked;
          if (unsettledSince) unsettledSince += parked;
          if (genOffFirstAt) genOffFirstAt += parked;
        }
        continue; // re-read everything now that the tab has layout again
      }
      const gen = P.isGenerating();
      if (gen) lastActiveAt = Date.now(); // actively generating ⇒ never time out
      const d = P.readAssistant();
      // Sites virtualize their lists, so the absolute assistant count can DROP
      // even as a new reply is added. A count increase still proves a new turn
      // appeared; the generating flag is the reliable "reply has begun" signal.
      // A new reply turn exists. Prefer node IDENTITY (virtualization-proof) when
      // the provider exposes it: the last assistant turn's id differs from the one
      // captured at send time. Fall back to the count test otherwise. Without this,
      // a provider's list virtualisation can keep assistantCount() <= base for a
      // fresh reply, so the reliableCounts gate below waits out the full NO_TURN_GRACE
      // (~30s) before finalising a multi_edit - the "input box stuck until I scroll
      // up" symptom (scrolling re-attached old turns and bumped the count).
      const curTok = P.lastAssistantId ? P.lastAssistantId() : undefined;
      // A NULL token means the provider could not read an identity for the
      // CURRENT last turn (not that the provider lacks ids - that's undefined).
      // Treating null as "no new reply" wedged the watcher on Qwen: a
      // REGENERATED turn is rebuilt WITHOUT the id attribute the normal turns
      // carry, so curTok stayed null, `started` never latched, and the loop
      // sat in the pre-start branch for the full 60s before ending "empty" -
      // the regenerated command (complete in the net tap) was never run and
      // zResume then blocked any retry (validated live via empty.why, 2026-07).
      // Fall back to the count test instead, exactly as for a provider with no
      // lastAssistantId at all.
      const newReply = (curTok !== undefined && curTok !== null)
        ? (curTok !== A.sendToken)
        : P.assistantCount() > base;

      // Track whether the CURRENT turn has produced anything. Reset when the
      // turn node changes (the PREVIOUS turn's content never counts).
      if (d.item !== curItem) { curItem = d.item; sawContent = false; warmSince = 0; lastGoodReply = ""; }
      if ((d.reply && d.reply.length) || (d.thinking && d.thinking.length)) sawContent = true;
      if (d.reply && d.reply.length) lastGoodReply = d.reply;

      if (!started) {
        // CRITICAL: a bare count increase is NOT enough - the empty turn
        // CONTAINER can appear seconds before the first token. Require actual
        // CONTENT (or the generating flag).
        const hasText = !!((d.reply && d.reply.length) || (d.thinking && d.thinking.length));
        if (gen || (newReply && hasText)) { started = true; }
        else {
          // The site can be slow to even CREATE the reply turn. Keep waiting -
          // only give up after a long fully-silent window.
          if (!preStartSilent) preStartSilent = Date.now();
          // diag: WHICH empty-branch fired matters - a dead post-regenerate turn
          // on Qwen kept ending "empty" with a complete command in the net tap,
          // and without the branch name the cause was unfindable from the log.
          if (Date.now() - preStartSilent > 60000) { diag("empty.why", { branch: "preStart", rep: (d.reply||"").length }); return { kind: "empty" }; }
          await sleep(200);
          continue;
        }
      }

      // Track text stability (independent of the generating flag). Compare the
      // NORMALISED reply (collapsed whitespace) so cosmetic re-renders of a large
      // reply - React re-creating the hidden tool <pre>, syntax-highlight passes,
      // copy-bar text churn - don't count as real "changes" and keep resetting
      // lastChangeAt. A churn-poisoned lastChangeAt was stalling finalisation of
      // big multi_edit blocks ~30s (stuckDone never fired); this can only ever
      // reduce false changes, so short replies / other providers are unaffected.
      const replyNorm = (d.reply || "").replace(/\s+/g, " ").trim();
      if (replyNorm !== lastText) { lastText = replyNorm; lastChangeAt = Date.now(); lastActiveAt = Date.now(); }
      // How long the generating flag has been OFF. A mid-stream flicker resets
      // this the instant growth resumes and gen flips back on.
      if (gen) genFalseSince = 0; else if (!genFalseSince) genFalseSince = Date.now();
      // DIAG: first gen-off, and count flickers back to true after a gen-off.
      if (started && !gen && !genOffFirstAt) genOffFirstAt = Date.now();
      if (prevGen === false && gen && genOffFirstAt) genFlickers++;
      prevGen = gen;

      if (Date.now() - lastLimitScan > 1000) {
        lastLimitScan = Date.now();
        const ctx = P.scanError();
        if (ctx) return { kind: "context_limit", detail: ctx };
      }

      // Keep waiting while a tool command is still being streamed (opener written
      // but no end marker yet) so we never parse/finalize half a command.
      const blockActive = ZSParse.hasOpenToolBlock(d.reply) && Date.now() - lastChangeAt < 6000;
      // ...but once generation has clearly stopped (stop indicator gone past the
      // grace window), stop honoring an "open block" - it is DOM churn, not live
      // streaming. Lets a finished big block finalise in seconds instead of
      // waiting out ~30s of re-render churn. Safe: real streaming keeps gen true.
      const genStopped = !gen && genFalseSince && Date.now() - genFalseSince > GEN_STOP_GRACE_MS;
      const effectiveBlock = blockActive && !genStopped;

      // Fallback: generating flag stuck ON (e.g. a wedged stop button - seen
      // live on Gemini after a mid-write halt) but the text has been frozen for
      // a while → stop waiting and finalize. This must BYPASS the gen branch
      // below entirely: falling through while gen stays true used to reset
      // doneSince every iteration, so the watcher never finalized at all.
      // ...but NEVER treat a still-OPEN command block as "done" while the site is
      // genuinely still generating. A model writing a big command (a 3799-char
      // execute_luau seen live on GLM) can pause >STABLE_MS between tokens - that
      // is a mid-write gap, NOT a wedged stop button on a COMPLETE reply. Firing
      // here parsed the half-written JSON and stamped a false "bad JSON" error
      // while GLM was still typing. RESPONSE_TIMEOUT still bounds a truly stuck one.
      const stuckDone = started && d.reply && Date.now() - lastChangeAt > STABLE_MS &&
        !(gen && ZSParse.hasOpenToolBlock(d.reply));
      if ((gen || effectiveBlock) && !stuckDone) {
        // DIAG: attribute this wait. genOffFirstAt set ⇒ we are PAST first stop,
        // so any wait here is tail latency: either gen flickered back on, or an
        // (effective) open-block reading is holding us.
        if (genOffFirstAt) { if (gen) waitedFlicker++; else if (effectiveBlock) waitedBlock++; }
        doneSince = 0;
        await sleep(160);
        continue;
      }
      if (stuckDone && gen) log("generating flag stuck - falling back to text stability");

      // On providers whose turn counts are RELIABLE (semantic elements, no
      // list virtualisation - Gemini), never finalize before the reply turn
      // for THIS send exists. The generating flag can flicker off in the gap
      // between the send and the new <model-response> node spawning, and the
      // watcher used to finalize on the PREVIOUS turn's stable text - a
      // premature loop.end rescued only by autoResume 30-45s later (diag
      // showed `response kind:text` ~2.4s after loop.start with rp unchanged).
      // Bounded so a genuinely dead send still ends the turn.
      if (P.reliableCounts && !newReply) {
        if (!noTurnSince) noTurnSince = Date.now();
        // [TRACE] This is the 30s NO_TURN_GRACE gate. If a Qwen tool turn sits here
        // ~30s EVERY turn, newReply is wrongly stuck false: log the identity values
        // that decide it so we can see whether curTok is null (id missing on the new
        // turn -> count fallback) or equal to sendToken (last turn not advancing).
        const _waited = Date.now() - noTurnSince;
        if (_waited > 800 && (!A._noTurnLoggedAt || Date.now() - A._noTurnLoggedAt > 3000)) {
          A._noTurnLoggedAt = Date.now();
          diag("noTurnGrace.wait", {
            waitedMs: _waited,
            curTok: (P.lastAssistantId ? P.lastAssistantId() : undefined),
            sendToken: A.sendToken,
            assistantCount: P.assistantCount ? P.assistantCount() : undefined,
            base, gen, started, replyLen: (d.reply || "").length });
        }
        if (Date.now() - noTurnSince < NO_TURN_GRACE_MS) { await sleep(200); continue; }
      } else {
        noTurnSince = 0;
        A._noTurnLoggedAt = 0;
      }

      if (!doneSince) doneSince = Date.now();
      if (Date.now() - doneSince < 500) {  // 500ms settle – DOM is stable
        await sleep(120);
        continue;
      }

      // A turn that has produced NOTHING yet is still warming up - never
      // finalize it as empty/truncated/text (a premature retry interrupts it).
      if (!sawContent) {
        if (!warmSince) warmSince = Date.now();
        if (Date.now() - warmSince < WARMUP_MS) { await sleep(200); continue; }
        diag("empty.why", { branch: "warmup", rep: (d.reply||"").length, lastGood: lastGoodReply.length });
        return { kind: "empty" };
      }

      // Still REASONING / loading: thinking written but no answer yet. Don't
      // finalize - wait for the reply, bounded. A manually-stopped turn is
      // exempt so a real stop still ends.
      if (d.thinking && d.thinking.length && !(d.reply && d.reply.length) && !P.turnHalted(d.item)) {
        if (!reasonSince) reasonSince = Date.now();
        if (Date.now() - reasonSince < REASON_NOREPLY_MS) { await sleep(200); continue; }
      } else {
        reasonSince = 0;
      }

      // Blank-read guard: if THIS read came back empty but the same turn had
      // real text a tick ago, classify that text - see lastGoodReply above.
      let r = d.reply;
      if (!r && lastGoodReply) { r = lastGoodReply; diag("reply.blankReadFallback", { len: r.length }); }
      // "Conversation too long" / "server busy" notices are always SHORT system
      // messages; gating on a short reply stops the model's own long output
      // (which may quote those phrases) from tripping them.
      if (r.length < 400 && P.isTooLongMsg(r)) return { kind: "too_long" };
      // Hold off on any "unparseable command" verdict while the provider reports
      // this turn's text is not yet a settled read. Qwen's A/B "dual" turn is the
      // case: its network tap flips `done` the instant the SSE ends, but the
      // candidate-1 DOM we parse can still be mid-render, so a real command looks
      // half-written for a beat. Firing parse_error there sends an ERROR
      // mid-generation and nags a model that did nothing wrong. Only guard when
      // the reply already LOOKS like a command (so a plain-text answer is never
      // delayed) and bound it with UNSETTLED_GRACE_MS. No-op on providers that
      // don't implement replyUnsettled (DeepSeek/Gemini/GLM/Kimi/Arena).
      const cmdShaped = P.replyUnsettled && (
        ZSParse.hasToolSignature(r) ||
        (ZSParse.LUA_END_RE.test(r) && !ZSParse.LUA_START_RE.test(r)) ||
        (/"(?:datamodel_type|edits|old_string|new_string|file_path|target_file)"\s*:/.test(r) &&
          !/"command"\s*:/.test(r))
      );
      if (cmdShaped && P.replyUnsettled(d.item)) {
        if (!unsettledSince) unsettledSince = Date.now();
        if (Date.now() - unsettledSince < UNSETTLED_GRACE_MS) { await sleep(250); continue; }
      } else {
        unsettledSince = 0;
      }
      // A/B "carousel" turn (Qwen): while it is unresolved the site REMOVES the
      // composer from the DOM (validated live: getEditor() is null), so we can't
      // send the tool result until a candidate is picked - and the read reply is a
      // partial candidate, so a command there looks "cut off". Per the product rule
      // we use the FIRST candidate: wait for BOTH candidates to finish generating
      // (you can't select mid-stream), then auto-select Response 1. That collapses
      // the carousel to a normal turn - composer returns - and the normal parse/run
      // path below handles it. Never a parse_error here (the model didn't truncate).
      // No-op for every provider except Qwen. RESPONSE_TIMEOUT still bounds a truly
      // stuck carousel, so this cannot hang.
      if (P.isComparisonTurn && P.isComparisonTurn(d.item)) {
        if (P.isGenerating()) { await sleep(250); continue; }   // both still writing
        if (P.resolveComparison && P.resolveComparison()) {
          diag("carousel.resolved");
          await sleep(400); continue;                            // let it collapse, re-read
        }
        await sleep(250); continue;                              // button not ready yet
      }
      if (ZSParse.hasToolSignature(r)) {
        const calls = ZSParse.parseToolCalls(r);
        if (calls.length) { finalizeDiag("tool"); return { kind: "tool", calls, item: d.item }; }
        // A half-written command + the site's "Continue" button means the command
        // was truncated mid-stream → resume it rather than reporting bad JSON.
        if (P.findContinueBtn()) return { kind: "truncated", text: r, item: d.item };
        // Only fire parse_error if explicit markers were present.
        if (r.includes(ZSParse.START_M) || ZSParse.LUA_START_RE.test(r)) return { kind: "parse_error", reason: "malformed", raw: r, item: d.item };
        // A command opener with no closer (a JSON object that never closed -
        // the model was halted mid-write and there is no Continue affordance):
        // ask the model to rewrite it instead of silently ending the turn.
        // ...unless ONLY the trailing closers were lost (the model hit its
        // output limit with the payload complete - seen live on Qwen: a big
        // multi_edit missing exactly one final "}"). salvageCutOff auto-closes
        // and runs it instead of burning a whole retry turn; it refuses any
        // cut that amputated real content (mid-string / deep deficit), which
        // still falls through to the parse_error feedback. Safe to run here:
        // generation has ended (the open-block branch above kept waiting
        // while it streamed).
        if (ZSParse.hasOpenToolBlock(r)) {
          const saved = ZSParse.salvageCutOff(r);
          if (saved) {
            diag("tool.salvaged", { name: saved.tool });
            finalizeDiag("tool");
            return { kind: "tool", calls: [saved], item: d.item };
          }
          return { kind: "parse_error", reason: "unclosed", raw: r, item: d.item };
        }
        // A closed-looking JSON command envelope that NAMES A REAL TOOL but failed
        // to parse - typically an unescaped " inside a code/string param broke the
        // JSON (seen live on Kimi's execute_blender_code: `name = "Camera_System"`
        // mid-code). Unlike execute_luau there is NO ###CODE:run_python### fallback, so the
        // command silently dropped and the loop finalized the turn as a plain-text
        // answer with no result and no error - a dead turn. Fire a parse_error so
        // the model can fix its JSON. GATED on a known command name so prose that
        // merely quotes {"command":"..."} (a DeepSeek-style explanation, or a
        // placeholder like "command_name") is NOT misread as a broken command and
        // looped on - only a real tool name means a genuine failed call.
        const nm = ZSParse.toolNameFromText(r);
        if (nm && nm !== "command" && (A.toolNames.has(nm) || A.toolNames.has(bareToolName(nm)))) {
          return { kind: "parse_error", reason: "malformed", raw: r, item: d.item };
        }
      }
      // The model answered in its OWN native tool-call markup instead of a
      // FreeAgent command - DeepSeek's DSML invoke/parameter tags (reported by
      // users, 2026-08; DeepSeek is the only provider seen doing it). It carries
      // no "command"/"tool" key and no ###...### markers, so hasToolSignature is
      // false and every guard below misses it too: the turn finalized as a
      // plain-text answer, the tool never ran, and the loop ended on a dead agent.
      // Checked FIRST among the fallthrough guards because the marker is
      // unambiguous - unlike the guards below it needs no known-tool gate, which
      // matters because the degenerate form seen in the wild carries no tool name
      // at all (a bare tool_calls opener followed by prose).
      if (ZSParse.DSML_RE.test(r)) {
        diag("cmd.dsml", { len: r.length });
        return { kind: "parse_error", reason: "dsml", raw: r, item: d.item };
      }
      // Malformed execute_luau: the model wrote the ###END_CODE### closer but
      // FORGOT the ###CODE:run_python### opener, so hasToolSignature missed it and the block
      // never ran (seen on Gemini). Don't silently treat it as a final answer -
      // nudge a rewrite instead of leaving the user stuck on a dead turn.
      if (ZSParse.LUA_END_RE.test(r) && !ZSParse.LUA_START_RE.test(r) && !r.includes(ZSParse.START_M)) {
        return { kind: "parse_error", reason: "luaOpener", raw: r, item: d.item };
      }
      // Malformed command: the model emitted a tool's RAW ARGUMENTS as a bare JSON
      // object (e.g. {"datamodel_type":...,"edits":[...],"file_path":...}) instead of
      // the required {"command":...,"params":...} envelope - it treated the tool as a
      // real callable function (seen on Gemini). Those argument keys never appear in a
      // normal prose answer, so nudge a rewrite rather than ending the turn silently.
      if (/"(?:datamodel_type|edits|old_string|new_string|file_path|target_file)"\s*:/.test(r) &&
          !/"command"\s*:/.test(r)) {
        return { kind: "parse_error", reason: "envelope", raw: r, item: d.item };
      }
      // Malformed command, function-calling flavour: the model named a REAL tool
      // but under the WRONG KEY - {"toolName": "get_studio_state", "studio_id": …}
      // instead of {"command": …, "params": {…}}. It reads as a deliberate call,
      // yet hasToolSignature never fires (no "command" key, no markers) and the
      // argument keys are the tool's own, so neither guard above catches it: the
      // turn finalized as a plain-text answer and the loop ENDED with the user
      // watching a dead agent (seen live on ChatGPT, long session, 2026-08).
      // GATED on the value being a tool we actually have - same reasoning as the
      // toolNameFromText gate above, so prose that merely mentions a tool name in
      // some JSON example is never looped on.
      const wrongKey = /"(?:toolName|tool_name|tool|name|function|action)"\s*:\s*"([A-Za-z0-9_.\/-]+)"/.exec(r);
      if (wrongKey && !/"command"\s*:/.test(r)) {
        const wk = wrongKey[1];
        const hit = knownTool(wk);
        // Log the miss too: the gate depends on how the bridge ADVERTISES names
        // (they can be prefixed per server on a collision), so a silent no-match
        // is exactly the case that is impossible to diagnose after the fact.
        diag("cmd.wrongKey", { name: wk, known: hit, catalogue: A.toolNames.size });
        if (hit) return { kind: "parse_error", reason: "toolKey", raw: r, item: d.item };
      }
      // NOTE: a site "server busy / something went wrong" notice is deliberately
      // NOT special-cased. It falls through to kind:"text" below and simply ENDS
      // the loop as a final answer - no auto-retry. Retrying risked an infinite
      // re-answer loop when the model's OWN prose said "try again", and treating
      // busy as a normal terminal turn is cleaner: the user just re-sends if the
      // site actually hiccuped. (P.isBusyMsg stays on the provider interface,
      // unused by the core, in case a future flow wants it.)
      // The site caps output length and shows a native "Continue" button when it
      // truncates. We try clicking it directly (same turn) in the loop.
      if (P.findContinueBtn()) return { kind: "truncated", text: r, item: d.item };
      if (r === "") { diag("empty.why", { branch: "finalBlank" }); return { kind: "empty" }; }
      return { kind: "text", text: r };
    }
    return { kind: "timeout" };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  TOOL EXECUTION  (always returns a feedback string for the model)
  // ════════════════════════════════════════════════════════════════════════
  // An ORPHANED content script: the extension was reloaded, updated or disabled
  // while this page stayed open, so the script still running here belongs to a
  // version of the extension that no longer exists. Chrome tears down its
  // messaging port, and every chrome.runtime call then fails INSTANTLY with
  // "Extension context invalidated".
  //
  // This must be told apart from a real bridge outage. They are opposite
  // problems with opposite fixes: a bridge outage is fixed by start.bat and
  // resolves itself, while this one can ONLY be fixed by reloading the page and
  // never recovers on its own. Lumping them together (the old behaviour) told
  // the model "the local FreeAgent bridge is unreachable", which sent the user
  // to check a bridge that was perfectly healthy. Diagnosed 2026-08-14 by the
  // giveaway timing: a genuine outage takes 8s (background.js `send` waits via
  // waitForConnection first), an invalidated context comes back in ~1ms.
  //
  // Every user meets this eventually - Chrome auto-updates extensions under
  // open tabs - so it is worth its own message.
  const isContextInvalidated = (m) =>
    /Extension context invalidated|Receiving end does not exist|message port closed/i.test(m || "");

  function bg(msg) {
    return new Promise((resolve) => {
      const fail = (m) => resolve({
        ok: false,
        kind: isContextInvalidated(m) ? "stale-extension" : "disconnected",
        error: m,
      });
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) fail(chrome.runtime.lastError.message);
          else resolve(resp || { ok: false, kind: "disconnected", error: "no response from background" });
        });
      } catch (e) {
        fail(String(e && e.message || e));
      }
    });
  }

  // 'subagent' is always blocked (long-running, hangs the loop). 'screen_capture'
  // is only blocked on providers whose underlying model can't see images
  // (P.supportsVision === false) - see providers/*.js for the per-site flag.
  // Both are filtered out of the advertised command list AND refused in runTool.
  // Addon servers (Blender, Sketchfab, ...) can ALSO ship an image-returning
  // tool under any name we don't know in advance - rather than guess names,
  // any tool result carrying images is caught generically at the point results
  // are handled (see the `r.images.length` branch) and turned into a plain
  // error on non-vision providers, so nothing needs to be predicted here.
  const ALWAYS_BLOCKED_TOOLS = new Set(["subagent"]);
  const VISION_TOOLS = new Set(["screen_capture"]);
  const bareToolName = (name) => (name && name.includes("/") ? name.split("/").pop() : name) || "";
  // Is `name` a tool we actually have? The bridge ADVERTISES names that may carry
  // a per-server prefix when two MCP servers expose the same tool (see
  // list_tools in bridge.py), while the model always writes the bare name - so a
  // plain `A.toolNames.has(bare)` misses, and so does bareToolName(bare), which
  // cannot re-add a prefix it never had. Compare bare-to-bare in BOTH directions.
  const bareKey = (n) => String(n || "").split("/").pop().split(".").pop();
  function knownTool(name) {
    if (!name || !A.toolNames.size) return false;
    if (A.toolNames.has(name) || A.toolNames.has(bareToolName(name))) return true;
    const b = bareKey(name);
    for (const t of A.toolNames) if (bareKey(t) === b) return true;
    return false;
  }
  const isBlockedTool = (name) => {
    const bare = bareToolName(name);
    if (ALWAYS_BLOCKED_TOOLS.has(bare)) return true;
    if (VISION_TOOLS.has(bare) && !P.supportsVision) return true;
    return false;
  };

  // ── Learned image tools (reload-proof "screen" chip) ──────────────────────
  // The known local agent vision tool (screen_capture) is themed "screen" by name via
  // ZS.toolCategory. A custom MCP tool's NAME reveals nothing, so we learn which
  // ones return images and persist that across reloads: with it, a revisited or
  // reloaded conversation still shows the image-capture chip (not the generic
  // wrench), and the NEXT call of a known image tool is optimistic from the start.
  // The marker below is the exact tail runTool appends to a feedback that carries
  // an image (see runTool's r.images branch) - the reload-proof signal, readable
  // straight from the injected result turn's text even when no loop is running.
  const IMAGE_FEEDBACK_RE = /image is attached to THIS message/i;
  function rememberImageTool(name) {
    const bare = bareToolName(name);
    if (!bare || A.imageTools.has(bare)) return;
    A.imageTools.add(bare);
    diag("imageTool.remember", { name: bare, total: A.imageTools.size });
    try { chrome.storage.local.set({ zsImageTools: [...A.imageTools].slice(-200) }); } catch {}
  }
  try {
    chrome.storage.local.get("zsImageTools", (r) => {
      if (r && Array.isArray(r.zsImageTools)) for (const n of r.zsImageTools) A.imageTools.add(n);
      diag("imageTool.loaded", { tools: [...A.imageTools] });
    });
  } catch {}

  // How long a fetched catalogue stays good enough to reuse without a round trip.
  const TOOLS_TTL_MS = 30000;

  // Refresh the tool catalogue - but never pay for it twice in a row.
  //
  // DEGRADED MODE (local agent closed, running on an addon server like Blender)
  // is where this used to hurt: a list_tools whose local agent half is dead blocks the
  // bridge until it gives up, and the extension waited the FULL background timeout
  // for it. The boot sequence calls this three times in a row - startSession(),
  // then the model's list_commands, then list_mcp_servers - so the user watched
  // ~a minute of dead air with the model's reply already finished on screen
  // ("the first commands take forever even though the model clearly stopped
  // writing"). A short TTL collapses those three calls into one, and the caller
  // keeps the catalogue it already has instead of stalling for a fresh one.
  async function ensureTools(force) {
    if (!force && A.toolList.length && Date.now() - A.toolsAt < TOOLS_TTL_MS) {
      diag("tools.cached", { age: Date.now() - A.toolsAt, n: A.toolList.length });
      return A.toolList;
    }
    const t0 = Date.now();
    const r = await bg({ type: "list_tools" });
    diag("tools.fetched", { ms: Date.now() - t0, n: (r && r.tools && r.tools.length) || 0 });
    if (r && r.tools && r.tools.length) {
      const tools = r.tools.filter((t) => !isBlockedTool(t.name));
      A.toolList = tools;
      A.toolNames = new Set(tools.map((t) => t.name));
      A.toolsAt = Date.now();
    }
    return A.toolList;
  }

  async function approveTool(name, args) {
    const permission = await bg({type:"tool_permission",name});
    if (A.stop) return false;
    if (permission?.ok && permission.allowed) return true;
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#000a;display:flex;align-items:center;justify-content:center;font:14px system-ui;color:#edf3ff";
      const panel = document.createElement("div"); panel.style.cssText = "width:min(640px,90vw);max-height:85vh;overflow:auto;background:#141e2d;border:1px solid #7596b8;border-radius:14px;padding:22px";
      const title = document.createElement("h2"); title.textContent = "Approve " + name + "?";
      const explanation = document.createElement("p"); explanation.textContent =
        /run_shell|run_python/.test(name) ? "This runs with your normal computer permissions. The workspace is its working folder, not a security sandbox. Review the exact code below."
        : name === "screen_capture" ? "This captures your desktop and sends the image to this chat provider."
        : "Review the exact operation on your computer. Addon MCP tools can have access outside the workspace.";
      const pre = document.createElement("pre"); pre.textContent = JSON.stringify(args, null, 2); pre.style.cssText = "background:#090f18;padding:12px;overflow:auto;max-height:40vh;white-space:pre-wrap;word-break:break-word";
      const allow = document.createElement("button"); allow.textContent = "Approve once";
      const always = document.createElement("button"); always.textContent = "Always allow this tool";
      always.disabled = !permission?.ok || !permission.context;
      const hint = document.createElement("p"); hint.style.cssText = "font-size:12px;color:#b8c8db";
      hint.textContent = "Always allow skips future prompts for this exact tool, with any arguments, on this paired bridge and workspace. Reset saved approvals in Settings.";
      const deny = document.createElement("button"); deny.textContent = "Deny";
      for (const b of [allow,always,deny]) b.style.cssText = "margin:0 10px 8px 0;border:1px solid #9bb5d0;background:#233a54;color:#fff;border-radius:8px;padding:10px 15px;cursor:pointer";
      let timer, settled = false;
      const done = value => { if (settled) return; settled = true; clearInterval(timer); document.removeEventListener("keydown", escape, true); overlay.remove(); resolve(value); };
      const escape = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); } };
      allow.onclick = () => done(true); deny.onclick = () => done(false);
      always.onclick = async () => {
        always.disabled = true; allow.disabled = true; deny.disabled = true;
        const saved = await bg({type:"allow_tool",name,context:permission.context});
        if (settled) return;
        if (saved?.ok) return done(!A.stop);
        hint.textContent = "Could not save approval: " + (saved?.error || "Extension unavailable. Reload the page.");
        always.disabled = false; allow.disabled = false; deny.disabled = false;
      };
      document.addEventListener("keydown", escape, true);
      panel.append(title,explanation,pre,hint,allow,always,deny); overlay.append(panel); document.body.append(overlay); deny.focus();
      timer = setInterval(() => { if (A.stop) done(false); }, 100);
    });
  }

  async function runTool(call) {
    const name = call.tool, args = call.arguments || {};
    if (A.stop) return "ERROR: stopped before dispatch.";
    if (document.hidden && !(await waitVisible())) return "ERROR: stopped before dispatch.";
    if (name === "list_mcp_servers") {
      await ensureTools();
      return `Output of '${name}':\n` + JSON.stringify(A.bridge.servers || []);
    }
    if (name === "list_commands" || name === "list_tools") {
      await ensureTools();
      if (!A.bridge.connected) return ZS.FEEDBACK.bridgeOffline;
      const server = args.server || "local";
      const scoped = A.toolList.filter(t => (t.server || "local") === server);
      if (!scoped.length) return `ERROR: no tools available for '${server}'. Use list_mcp_servers.`;
      return `Output of '${name}':\n${server} commands:\n` + scoped.map(t =>
        `${t.name}: ${t.description || ""}\nApproval required: ${!!t.approval}\nParameters: ${JSON.stringify(t.inputSchema)}${ZS.TOOL_NOTES[bareToolName(t.name)] ? "\nUsage: " + ZS.TOOL_NOTES[bareToolName(t.name)] : ""}`
      ).join("\n\n");
    }
    const spec = A.toolList.find(t => t.name === name);
    if (!spec) return ZS.FEEDBACK.unknownTool(name, [...A.toolNames]);
    if (isBlockedTool(name)) return `ERROR: '${name}' is unavailable for this provider. Use a text tool instead.`;
    const approved = !!spec.approval;
    if (approved && !(await approveTool(name, args))) {
      A.userStopped = true;
      return `ERROR: user denied approval for '${name}'. Stop this action; do not bypass denial.`;
    }
    if (A.stop) return "ERROR: stopped before dispatch.";
    let stopTimer, capTimer;
    const stopWatch = new Promise(resolve => { stopTimer = setInterval(() => { if (A.stop) resolve({ok:false,kind:"stopped",error:"Stopped by user"}); },100); });
    const cap = new Promise(resolve => { capTimer = setTimeout(() => { bg({type:"cancel_active"}); resolve({ok:false,kind:"timeout",error:"Tool deadline exceeded; cancellation requested."}); },155000); });
    let r;
    try { r = await Promise.race([bg({type:"call_tool",name,arguments:args,approved}),stopWatch,cap]); }
    finally { clearInterval(stopTimer); clearTimeout(capTimer); }
    if (!r) return ZS.FEEDBACK.bridgeOffline;
    if (r.kind === "stale-extension") { ui.staleExtensionAlert(); return ZS.FEEDBACK.staleExtension; }
    if (!r.ok) return `ERROR calling '${name}': ${r.error || r.kind || "Unknown failure"}\nStop on denial/cancellation. Do not blindly repeat a side-effecting operation.`;
    if (r.images?.length) {
      if (!P.supportsVision) return `ERROR: '${name}' returned images, but this provider cannot see them. Use text tools.`;
      ui.showImages(r.images,name); A.pendingImages = r.images;
      return `Output of '${name}':\n${r.text || "Image captured."}\nThe image is attached to THIS message.`;
    }
    return `Output of '${name}':\n${r.text || "Completed with no text output."}`;
  }

  function argSummary(call) {
    if (!call) return "";
    if (call.tool === "run_python" || call.tool === "run_shell") {
      const code = (call.arguments && call.arguments.code) || "";
      const first = code.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
      return first.slice(0, 46);
    }
    const a = call.arguments || {};
    const k = Object.keys(a)[0];
    if (!k) return "";
    let v = String(a[k]);
    if (v.length > 34) v = v.slice(0, 31) + "…";
    return `${k}: ${v}`;
  }

  // An MCP tool can report its OWN failure as a NORMAL result ("Output of '…':
  // Error executing code: …") instead of our ERROR wrapper - so a
  // startsWith("ERROR") test alone paints a FAILED call ✓ green and shows the
  // error as its summary (seen live on Blender's execute_blender_code, and it
  // will hit EVERY future MCP server the same way). Treat a result whose FIRST
  // line opens with an error lead-in as failed too. Deliberately PHRASE-based,
  // not the bare words "error"/"failed", so a genuine success line like
  // "Failed: 0" / "Error count: 0" is NOT misread as a failure.
  const BODY_ERR_RE =
    /^\s*(error executing|error:|erreur|exception|traceback|communication error|failed to|could ?not|cannot |unable to|fatal)\b/i;
  const stripOutputPrefix = (feedback) => feedback.replace(/^Output of '[^']*':\n?/, "");
  function bodyLooksFailed(feedback) {
    if (!feedback || feedback.startsWith("ERROR")) return false; // wrapper already flags it
    const first = stripOutputPrefix(feedback).split("\n").map((s) => s.trim()).find(Boolean) || "";
    return BODY_ERR_RE.test(first);
  }
  // True failure = OUR wrapper prefix OR an MCP tool's in-body error lead-in.
  const feedbackIsError = (feedback) => feedback.startsWith("ERROR") || bodyLooksFailed(feedback);

  // Some tools answer with raw JSON on one line, and a 44-char slice of it makes
  // a chip that says nothing: list_roblox_studios read
  // `{"studios":[{"id":"8521cfad-f8d9-46f4-8cbe-2`. Summarise the SHAPE instead,
  // in the same spirit as the boot chip's "25 commands". Returns null when the
  // body isn't JSON, so plain-text outputs keep their first line unchanged.
  function jsonSummary(body) {
    if (!/^[[{]/.test(body) || body.length > 200000) return null;
    let v;
    try { v = JSON.parse(body); } catch { return null; }
    if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
    if (!v || typeof v !== "object") return null;
    const keys = Object.keys(v);
    // The common MCP shape: one wrapper key holding the list. Its name is already
    // plural ("studios", "scripts"), so it reads correctly as-is - just drop the
    // trailing "s" when there is exactly one, so it says "1 studio".
    if (keys.length === 1 && Array.isArray(v[keys[0]])) {
      const n = v[keys[0]].length;
      const word = n === 1 ? keys[0].replace(/s$/, "") : keys[0];
      return `${n} ${word}`;
    }
    // Otherwise show the scalar fields - that's what a human would read off.
    const scalars = keys
      .filter((k) => v[k] === null || typeof v[k] !== "object")
      .map((k) => `${k}: ${v[k]}`);
    if (scalars.length) return scalars.join(", ").slice(0, 44);
    return `${keys.length} field${keys.length === 1 ? "" : "s"}`;
  }

  function outSummary(feedback) {
    if (!feedback) return "";
    const isErr = feedbackIsError(feedback);
    const body = stripOutputPrefix(feedback).trim();
    if (!body) return "";
    // Errors are prose and read fine as-is; only reshape successful JSON.
    if (!isErr) { const j = jsonSummary(body); if (j) return j; }
    const all = body.split("\n").map((l) => l.trim()).filter(Boolean);
    const lines = all.length;
    // On SUCCESS, skip a leading non-fatal warning/note some MCP tools print
    // before the real status so the chip shows the useful line, not the noise.
    let first = all[0] || "";
    if (!isErr && lines > 1 && /^(warning|warn|note|deprecat|info)\b/i.test(first)) {
      first = all.find((l) => !/^(warning|warn|note|deprecat|info)\b/i.test(l)) || first;
    }
    first = first.slice(0, 44);
    if (isErr) return first;
    return lines > 1 ? `${first} · ${lines} lines` : first;
  }

  // Full args / code, shown in a tool chip's expandable body.
  function callBody(call) {
    const a = call.arguments || {};
    if (call.tool === "run_python" || call.tool === "run_shell") return (a.code || a.command || "").trim();
    try { return JSON.stringify(a, null, 2); } catch { return String(a); }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  AGENTIC LOOP
  // ════════════════════════════════════════════════════════════════════════
  async function agentLoop(base) {
    if (A.running) return;
    A.running = true;
    A.resumeArmed = false; // loop now owns the turn; drop the regenerate grace
    A.stop = false;
    A.stopping = false; // clean slate: never inherit a stale "Stopping…" from a
                        // Stop click that landed before this loop actually started
    A.loopKey = null; // pinned by syncSessionState once this chat has an id + content
    let truncCount = 0, formatFailures = 0, repeatedFailures = 0, lastFailedCall = "";
    const MAX_TRUNC = 6;
    // Re-send the command list after this many successful tool calls. Kept high
    // so the reminder does not bloat the context too often.
    const REMIND_TOOLS_EVERY = 20;
    ui.showStop(true);
    P.setInputLock(true); // prevent user from typing while the agent is active
    ui.inputCover(true);  // keep the "Agent is working" cover up for the WHOLE loop
    diag("loop.start", { base });
    try {
      while (!A.stop) {
        // Gate the WHOLE cycle on tab visibility. We only advance - read the
        // reply, PARSE it, EXECUTE a tool, inject the result - while the AI tab
        // is the FOREGROUND tab of its Edge window. document.visibilityState
        // (mirrored by document.hidden) is the right signal, NOT window focus:
        //  - Edge loses OS focus but the AI tab stays the active tab (user is
        //    working in local agent) -> still "visible" -> the agent keeps
        //    running, exactly as wanted.
        //  - The AI tab is backgrounded (another tab in front) or the window is
        //    minimized -> "hidden" -> pause here. Background tabs throttle
        //    rendering/timers, which made DOM reads unreliable (misparse,
        //    duplicate sends - see the send-side guard in submitAndGetBase).
        // Parking here means we never START a parse/exec cycle off-screen; the
        // send step re-checks too, so a switch-away mid-generation is covered.
        if (document.hidden && !A.stop) {
          diag("loop.waitVisible");
          ui.inputCover(true); // keep the "Agent is working" cover up while parked
          if (!(await waitVisible()) || A.stop) break; // park (no cap) until foreground; break only on user stop
          diag("loop.visibleAgain");
        }
        const res = await waitForResponse(base);
        diag("response", { kind: res.kind });
        if (A.stop || res.kind === "stopped") break;

        if (res.kind === "context_limit") {
          ui.banner("limit", `${P.displayName} reached its context limit`,
            (res.detail || "") + "  -  open a new chat to start fresh.");
          break;
        }
        if (res.kind === "too_long") {
          ui.banner("limit", "Conversation too long",
            `${P.displayName} reports the conversation is getting too long. Start a new session.`);
          break;
        }
        if (res.kind === "timeout") {
          ui.banner("warn", `No response from ${P.displayName}`,
            `${P.displayName} did not respond in time. The loop has stopped.`);
          break;
        }
        // A genuinely empty turn is effectively never produced (the warm-up guard
        // waits out slow starts). It DOES happen when the site drops a reply, and
        // ending the loop silently is what made this the single most confusing
        // failure: the pending command just settles to a grey "not run" with no
        // explanation anywhere. Say what happened.
        if (res.kind === "empty") {
          diag("empty.end");
          ui.banner("warn", `${P.displayName} returned an empty reply`,
            `The turn produced no text, so the agent loop stopped. Nothing was run. ` +
            `Ask ${P.displayName} to continue, or press Start again in a new chat.`);
          break;
        }

        // The turn stopped with the site's "Continue" affordance.
        if (res.kind === "truncated") {
          // If the turn carries the halted marker (a stop - user OR self-halt),
          // respect it and do NOT auto-resume.
          if (P.turnHalted(res.item)) { diag("truncated.halted"); break; }
          // Otherwise it truncated by length → continue the SAME turn. Prefer
          // the native Continue button; fall back to a continuation message.
          if (truncCount < MAX_TRUNC) {
            truncCount++;
            if (P.clickContinueBtn() && await waitFor(() => P.isGenerating(), 2500)) {
              diag("truncated.continued");
              continue; // same turn resumes (base unchanged)
            }
            diag("truncated.sendFallback");
            ui.toast("Reply was cut off, resuming…");
            base = await submitAndGetBase(ZS.FEEDBACK.truncated);
            continue;
          }
          if (res.text) break; // give up resuming; keep what we have as the answer
          ui.banner("warn", "Reply kept getting cut off",
            "The model repeatedly hit its length limit. Try a shorter request or start a new session.");
          break;
        }
        truncCount = 0;

        if (res.kind === "parse_error") {
          if (++formatFailures >= 3) {
            ui.banner("warn", "Repeated command format errors", "The agent stopped after three malformed commands. Ask it to use the agent markers and a smaller command.");
            break;
          }
          // The command turn ended in a parse error - it NEVER ran. Paint its chip
          // as an error (owned, so the sweep won't repaint it the green ✓ "done" it
          // stamps on any command-shaped turn once generation ends - the misleading
          // "chip says OK, result says error" state seen live on GLM's truncated
          // execute_blender_code).
          const failName = ZSParse.toolNameFromText(res.raw || "") || "command";
          if (res.item) {
            const detail = res.reason === "unclosed" ? "cut off"
              : res.reason === "luaOpener" ? "missing ###CODE:run_python###"
              : res.reason === "envelope" ? "bad format"
              // DSML is not JSON at all - it is DeepSeek's own markup - so the
              // default "bad JSON" would send the user (and anyone reading a bug
              // report) looking for a syntax slip that does not exist.
              : res.reason === "dsml" ? "wrong format"
              : "bad JSON";
            decorate.toolBox(res.item, failName, "err", detail, true, "", ZS.toolCategory(failName));
          }
          // Pass the detected command name so the feedback only offers the
          // ###CODE:run_python### block when it actually applies (execute_luau) - never for a
          // truncated/broken execute_blender_code or other JSON-only command.
          base = await submitAndGetBase(ZS.FEEDBACK.parseError(res.reason, failName));
          continue;
        }
        if (res.kind === "text") break; // final answer

        if (res.kind === "tool") {
          const calls = res.calls;
          if (calls.length > 1) {
            if (++formatFailures >= 3) { ui.banner("warn", "Agent stopped", "Send only one command per reply."); break; }
            base = await submitAndGetBase(ZS.FEEDBACK.multiTool(calls.map((c) => c.tool || "?")));
            continue;
          }
          formatFailures = 0;
          const call = calls[0];
          // A tool ALREADY seen to return an image this session gets the "screen"
          // chip optimistically at run time (parity with the known screen_capture),
          // even though its name alone wouldn't reveal it. First-ever call of an
          // unknown image tool stays generic here and upgrades at result time below.
          const learnedImg = A.imageTools.has(bareToolName(call.tool));
          const category = learnedImg ? "screen" : ZS.toolCategory(call.tool);
          diag("tool.runCat", { name: call.tool, learnedImg, category });

          // Park BEFORE painting the chip / stamping the clock / marking the turn
          // dispatched. runTool() gates on visibility too (it is the choke point
          // that also covers the bootstrap), but parking only there would leave
          // this block's side effects applied for the whole minimize:
          //   - the chip spins "running" while nothing actually runs, and
          //     elapsedOn(zsToolT0) counts the parked time, so a 20-min minimize
          //     renders a bogus "1200.0s" on the call;
          //   - rememberExecuted() would mark the turn dispatched before it ever
          //     ran, so a reload/close while parked loses the command for good -
          //     the auto-resume watchdog refuses to re-fire an "executed" turn.
          // Parking first keeps all of that truthful: we only commit once we are
          // foreground and about to really dispatch.
          if (document.hidden && !A.stop) {
            diag("tool.parkBeforeDispatch", { name: call.tool });
            if (!(await waitVisible()) || A.stop) break;
          }
          // Loading chip with the real args (loop owns this item from here).
          decorate.toolBox(res.item, call.tool, "run", argSummary(call), true, callBody(call), category);
          A.toolSettle = null; // a fresh call: no settled outcome yet
          A.toolRunning = true;
          A.toolStart = Date.now();
          A.toolName = call.tool;
          A.toolItem = res.item;
          A.toolArg = argSummary(call);
          // Record this turn as dispatched OFF the DOM so the auto-resume
          // watchdog never re-fires it after a scroll re-render wipes the node's
          // zloop/zResume markers (see the `executed` map).
          rememberExecuted(res.item);
          diag("tool.start", { name: call.tool });
          const feedback = await runTool(call);
          const fingerprint = JSON.stringify(call);
          if (feedback.startsWith("ERROR")) {
            repeatedFailures = fingerprint === lastFailedCall ? repeatedFailures + 1 : 1;
            lastFailedCall = fingerprint;
          } else { repeatedFailures = 0; lastFailedCall = ""; }
          if (feedback.includes("user denied approval") || repeatedFailures >= 3) {
            decorate.toolBox(res.item, call.tool, "err", "stopped", true, feedback, ZS.toolCategory(call.tool));
            ui.banner("warn", "Agent stopped", feedback.includes("user denied approval") ? "You denied this operation. No tool was dispatched." : "The same command failed three times. Review the error before continuing.");
            break;
          }
          A.toolRunning = false;
          diag("tool.done", { name: call.tool, ok: !feedback.startsWith("ERROR"), out: feedback.slice(0, 50) });
          if (A.stop) {
            // User halted mid-tool: settle the spinning chip so it doesn't look
            // stuck loading forever, and MARK the turn so the sweep classifier
            // never repaints it ✓ done once generation ends (the real cause of a
            // stopped call still going green a moment later).
            if (res.item) { res.item.dataset.zStopped = "1"; rememberHalted(res.item); }
            decorate.toolBox(res.item, call.tool, "err", "stopped", true, "", category);
            break;
          }
          const isErr = feedbackIsError(feedback);
          const outBody = stripOutputPrefix(feedback);
          // Trace the chip's DERIVED phase vs summary. Blender (and any MCP whose
          // output leads with a warning/diagnostic line) resolves ✓ done - the
          // payload starts "Output of…", not "ERROR" - yet outSummary shows its
          // FIRST line, which is the warning. Captures firstLine vs a later
          // success line so we can see the mismatch without guessing.
          {
            const lns = outBody.split("\n").map((l) => l.trim()).filter(Boolean);
            diag("tool.result", { name: call.tool, isErr, phase: isErr ? "err" : "done",
              summary: outSummary(feedback), lineCount: lns.length,
              firstLine: (lns[0] || "").slice(0, 90), lastLine: (lns[lns.length - 1] || "").slice(0, 90) });
          }
          // A tool (local agent OR any custom MCP server) that actually RETURNED an
          // image becomes a "screen" chip - even if its name never let us guess.
          // Reactive, not predictive: A.pendingImages is set by runTool before it
          // returns. Remember the name so its next call is optimistic (see above).
          const hasImages = !!(A.pendingImages && A.pendingImages.length);
          if (hasImages) rememberImageTool(call.tool);
          const resultCat = hasImages ? "screen" : category;
          decorate.toolBox(res.item, call.tool, isErr ? "err" : "done", outSummary(feedback),
            true, outBody, resultCat);
          // Snapshot the settled outcome. If the site swaps this turn's DOM node
          // while we wait for the model's next turn (wiping the chip AND the
          // zloop ownership dataset), the sweep re-owns the fresh node with this
          // outcome instead of letting branch-3 classification re-spin a "run"
          // chip on an already-executed call.
          A.toolSettle = {
            phase: isErr ? "err" : "done", detail: outSummary(feedback),
            body: outBody, category: resultCat, count: P.assistantCount(),
            // Node IDENTITY of the settled turn (virtualization-proof), when the
            // provider exposes it. The count guard alone misfires on Qwen: the
            // list virtualizes so assistantCount() doesn't grow for the model's
            // NEXT turn, and back-to-back calls to the SAME tool defeat the name
            // guard too - the sweep then re-owned the STREAMING next turn's chip
            // with the previous done/err outcome (seen live: 5x chip.reown with
            // gen:true, rp tiny).
            id: P.lastAssistantId ? P.lastAssistantId() : undefined,
          };

          // Re-inject the command list every REMIND_TOOLS_EVERY successful calls.
          // Appended UNDER the tool result and clearly marked as a reminder, so a
          // model that has drifted from the exact command names gets re-anchored
          // without it looking like a new result to act on. Errors don't count
          // (they already restate what's wrong) and list_commands is redundant.
          let toSend = feedback;
          if (!isErr && call.tool !== "list_commands" && A.toolList.length) {
            A.toolCallsSinceReminder++;
            if (A.toolCallsSinceReminder >= REMIND_TOOLS_EVERY) {
              A.toolCallsSinceReminder = 0;
              // Scope the reminder to the primary local agent server, exactly like
              // list_commands: re-injecting EVERY connected server's tools (Blender
              // etc.) merged flat would bloat the model's context - the opposite of
              // what the model gets when it lists commands itself. Anti-drift only
              // needs the primary local agent set; addon commands were listed on demand
              // and the bridge routes by name regardless.
              const roblox = A.toolList.filter((t) => (t.server || "local") === "local");
              toSend += ZS.toolsReminder(roblox) + "\n" + ZS.memoryNudge();
              diag("tools.reminder", { after: REMIND_TOOLS_EVERY });
            }
          }
          // This result becomes a turn, so it counts toward the re-statement
          // budget - context volume is what makes the site summarise, and the
          // volume is overwhelmingly tool results, not how often the user types.
          bumpSys("results");
          // Ride the system-prompt re-statement out on this result if one is due
          // and it fits (see withSysResend - the result itself is never trimmed).
          toSend = withSysResend(toSend);
          const images = A.pendingImages;
          A.pendingImages = null;
          diag("images.consumed", { count: images ? images.length : 0 });
          base = await submitAndGetBase(toSend, images);
        }
      }
    } catch (e) {
      diag("loop.error", { msg: String((e && e.message) || e) });
      ui.banner("warn", "Internal loop error", String((e && e.message) || e));
    } finally {
      A.running = false;
      A.stop = false;
      // Keep the "Stopping…" state while the site's stream is still draining
      // after a user stop: the loop often ends BEFORE the native stop takes
      // effect (loop.end fires with gen still true - seen live on DeepSeek),
      // and clearing the flag here let the next sweep restore a clickable
      // "■ Stop" for the last beat of the dying stream (the Stopping… → Stop →
      // gone bounce). The sweep's self-heal clears it - and retries the native
      // stop - once the site is actually quiet.
      const draining = A.stopping && A.started && P.isHardGenerating();
      if (A.stopping && draining) diag("stop.drain", { keptStopping: true });
      A.stopping = draining;
      A.toolRunning = false;
      A.toolSettle = null;
      A.loopKey = null;
      ui.showStop(false);
      ui.inputCover(false); // lift the "Agent is working" cover when the loop ends
      P.setInputLock(false); // always unlock, even on error or stop
      diag("loop.end");
    }
  }

  // Mark the current assistant turn as user-halted so the sweep classifier shows
  // its command chip as "stopped" instead of repainting it ✓ done when
  // generation ends. Cleared on a deliberate resume (native Continue).
  //
  // The dataset marker alone is NOT enough: sites re-render the whole history
  // when the next user message lands (seen live on DeepSeek), replacing the
  // halted turn's node and wiping dataset.zStopped - and since a fresh user
  // message also clears the A.userStopped latch by design, nothing said
  // "stopped" anymore and the chip went ✓ green. So halted turns are ALSO
  // remembered here, keyed independently of the DOM node (conversation +
  // position among assistant turns + a text prefix), and the sweep re-stamps
  // the marker whenever the node was swapped.
  const halted = new Map(); // "conv|turnKey" → text prefix at halt time
  const assistantIdx = (item) => P.allItems().filter(P.isAssistantItem).indexOf(item);
  // Virtualization-stable map key for the off-DOM executed/halted memories.
  // assistantIdx is POSITIONAL within the currently-rendered window, so on a
  // virtualized list (DeepSeek/Qwen/GLM/Arena) scrolling up renders a different
  // set of turns and an OLD command turn takes a low index that COLLIDES with a
  // current turn's key - the dedupe then misses and the watchdog re-fires the
  // scrolled-back tool. Prefer the provider's stable per-turn id when it exposes
  // one (P.itemKey); fall back to the index for non-virtualized providers.
  const turnKey = (item) => {
    if (P.itemKey) {
      const k = P.itemKey(item);
      if (k != null) return `k${k}`;
    }
    return String(assistantIdx(item));
  };
  function rememberHalted(item) {
    try {
      if (!item || assistantIdx(item) < 0) return;
      const pref = (P.itemText(item) || "").slice(0, 60);
      // A stop during the REASONING phase leaves the answer text EMPTY - an
      // empty/short prefix would then startsWith-match ANY later turn at this
      // index (seen live: a fresh streaming command went red "stopped" on the
      // spot). Too little text to identify → rely on the dataset marker only.
      if (pref.trim().length < 12) return;
      halted.set(`${P.conversationKey()}|${turnKey(item)}`, pref);
    } catch {}
  }
  function forgetHalted(item) {
    if (!item || !halted.size) return;
    try { halted.delete(`${P.conversationKey()}|${turnKey(item)}`); } catch {}
  }
  // The halt was recorded MID-stream, so the stored text is a PREFIX of the
  // turn's final text - match on startsWith, never equality.
  function isRememberedHalted(item, txt) {
    if (!halted.size) return false;
    try {
      const pref = halted.get(`${P.conversationKey()}|${turnKey(item)}`);
      return pref != null && (txt || "").startsWith(pref);
    } catch { return false; }
  }
  function markStoppedTurn() {
    const it = P.lastAssistant();
    if (!it) return;
    it.dataset.zStopped = "1";
    rememberHalted(it);
  }

  // Off-DOM record of assistant turns whose command has ALREADY been dispatched
  // (by the normal loop OR the auto-resume watchdog). The dataset markers that
  // dedupe re-execution (zResume / zloop) live on the DOM NODE - but sites
  // virtualize long conversations, so scrolling up DESTROYS and RECREATES a
  // turn's node, wiping those markers. The fresh node then looks un-run, and the
  // watchdog can re-fire the turn's tool with no live generation at all (the
  // "tools execute when I scroll back" bug). Mirror the `halted` map exactly
  // (keyed by conversation + assistant index + a text prefix, NOT the node) so
  // the "already ran this" memory survives node recreation. This makes
  // re-execution IDEMPOTENT regardless of any isGenerating/lastGenAt heuristic
  // misfire - the hard part (is this a live turn?) can be wrong without harm.
  const executed = new Map(); // "conv|turnKey" → text prefix at dispatch time
  function rememberExecuted(item) {
    if (!item) return;
    try {
      if (assistantIdx(item) < 0) return;
      const pref = (P.itemText(item) || "").slice(0, 60);
      // Same guard as rememberHalted: too little text to identify the turn (a
      // command still streaming) would startsWith-match any later turn at this
      // index. Fall back to the dataset marker until there is enough text.
      if (pref.trim().length < 12) return;
      executed.set(`${P.conversationKey()}|${turnKey(item)}`, pref);
    } catch {}
  }
  function isRememberedExecuted(item, txt) {
    if (!executed.size) return false;
    try {
      const pref = executed.get(`${P.conversationKey()}|${turnKey(item)}`);
      return pref != null && (txt || "").startsWith(pref);
    } catch { return false; }
  }
  function stopLoop() {
    if (A.stopping) return; // already winding down - ignore double-clicks
    diag("stopLoop");
    A.stop = true;
    bg({ type: "cancel_active" });
    A.stopping = true;
    A.stopAt = Date.now(); // grace anchor for the regenerate-as-resume gates
    // Baseline for the stop-retry growth gate (see the self-heal in the meter
    // loop): a retry is only allowed if the reply keeps growing PAST this,
    // proving the first stop click was swallowed. Without it, retries clicked a
    // wedged (already-stopped) stop button and Gemini killed the NEXT turn.
    A.stopStreamLen = P.streamLen ? P.streamLen() : 0;
    A.userStopped = true; // suppress auto-resume until the next user message
    A.resumeArmed = false; // a stop overrides any pending regenerate grace
    // Disarm any pending optimistic pre-hide (armed in submitAndGetBase for the
    // feedback turn we just sent - see the re-arm note there). The input unlocks
    // right after this function returns, but the window can still be open for a
    // couple more seconds (e.g. mid-image-upload); without this, a message the
    // user types fast right after Stop could be the "next new user turn" the
    // window masks by mistake, instead of the (now abandoned) feedback turn.
    A.injectHideUntil = 0;
    markStoppedTurn();
    // A tool's loading chip is only settled AFTER its `await runTool()` resolves
    // (the if(A.stop) branch in agentLoop). A long-running call (e.g. a big
    // multi_edit) leaves that await pending, so the chip would keep spinning for
    // seconds after the user pressed Stop. Settle it to the stopped state right
    // now; the loop's own settle on resolve is idempotent.
    if (A.toolRunning && A.toolItem) {
      A.toolItem.dataset.zStopped = "1";
      rememberHalted(A.toolItem);
      decorate.toolBox(A.toolItem, A.toolName, "err", "stopped", true, "", ZS.toolCategory(A.toolName));
    }
    ui.markStopping();    // instant feedback: button → "⏳ Stopping…", disabled
    P.stopGeneration();
    ui.toast("Stopping…");
  }

  // The full system prompt for the CURRENT provider and user settings. One
  // definition, used both by the bootstrap and by the periodic re-injection, so
  // the two can never drift apart.
  function systemPrompt() {
    return ZS.buildSystemPrompt({
      siteName: P.displayName,
      customPrompt: ui.getCustomPrompt(),
      providerNotes: P.promptExtra || "",
    });
  }

  // ── Periodic system-prompt re-injection (opt-in, per provider) ────────────
  // Some sites aggressively summarise their own context mid-conversation. When
  // that happens the model keeps the gist of the task but loses the MECHANISM:
  // it forgets that an extension reads its replies and executes them, and starts
  // answering "I can't invoke those commands in this session" while the
  // extension sits there ready and waiting. Observed repeatedly on ChatGPT.
  //
  // The periodic tools reminder does NOT fix this: it re-anchors command NAMES,
  // but it never restates that the commands actually run. So providers that need
  // it set `resendSystemEvery`, and the whole prompt goes back in.
  //
  // Delivery rides on the next injected tool result rather than costing its own
  // message - free and invisible. But that channel dries up in exactly the case
  // this exists for (a model that has forgotten it can call tools stops calling
  // them, so no results flow), so a fallback sends it as its own masked turn
  // once the window has elapsed with nothing to piggyback on.
  const RESEND_SYS_EVERY = P.resendSystemEvery || 0;
  // Injected tool results get their own, larger budget (see sysResendDue).
  const RESEND_SYS_EVERY_RESULTS = 12;

  // How much conversation has accumulated since the operating instructions were
  // last stated. PERSISTED per conversation, because both simpler designs failed
  // in opposite directions - each caught live on 2026-08-14:
  //
  //  - An in-memory counter RESETS on every page reload, while the session
  //    itself survives one (A.started is persisted). After an F5, or a silent
  //    Chrome extension auto-update, the tally restarted and the re-statement
  //    could be postponed indefinitely.
  //  - Walking the DOM back to the last SYS_MARKER turn is reload-proof but
  //    UNDER-counts badly: these sites virtualize. Measured on a real ChatGPT
  //    session that had long passed the threshold - only 12 turns were rendered,
  //    the marker was not among them (so the walk silently counted from the top
  //    of the window) and it saw 5 injected results instead of the true total.
  //
  // Counting at INJECTION time and persisting sidesteps both: it is exact, and
  // virtualization cannot erase it. The DOM walk is kept as a floor, since a
  // conversation that visibly shows the threshold is due no matter what storage
  // says (e.g. a session adopted from another device, or storage cleared).
  const sysKey = () => `zsSys:${P.conversationKey() || "new"}`;
  let sysCount = { users: 0, results: 0 };
  let sysCountKey = "";

  // Hydrate from storage. Only meaningful at startup / on a conversation switch;
  // it never overwrites counts already accumulated in this tick's memory (a
  // bump that landed while the async read was in flight must not be lost).
  async function loadSysCount() {
    const k = sysKey();
    if (k === sysCountKey) return sysCount;
    sysCountKey = k;
    const local = sysCount;
    sysCount = { users: 0, results: 0 };
    try {
      const r = await new Promise((res) => chrome.storage.local.get(k, res));
      const saved = r && r[k];
      if (saved) sysCount = {
        users: Math.max(saved.users || 0, local.users || 0),
        results: Math.max(saved.results || 0, local.results || 0),
      };
    } catch {}
    return sysCount;
  }
  function saveSysCount() {
    try { chrome.storage.local.set({ [sysCountKey]: sysCount }); } catch {}
  }
  // Increment SYNCHRONOUSLY, persist asynchronously. sysResendDue() reads
  // sysCount in the same tick as the bump that should trip it, so deferring the
  // increment into the storage promise made the tally lag a full turn behind and
  // the threshold was never seen at the moment it mattered (caught live: 12 tool
  // results, counter still reading 11, no rider). Storage is a durability
  // mechanism here, not the source of truth for the current tick.
  function bumpSys(field) {
    if (!RESEND_SYS_EVERY) return;
    if (sysCountKey !== sysKey()) { sysCountKey = sysKey(); }
    sysCount[field]++;
    saveSysCount();
  }
  function resetSysCount() {
    sysCount = { users: 0, results: 0 };
    saveSysCount();
  }

  // Lower bound read straight from what is on screen (see above).
  function sinceLastSysInDom() {
    const items = P.allItems();
    let users = 0, results = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const txt = P.classifyText(it, ".zs-chip");
      // The bootstrap turn and every rider both carry the marker - either one
      // means the rules were fully stated here, so stop counting.
      if (txt.includes(ZS.SYS_MARKER)) break;
      if (!P.isUserItem(it)) continue;
      if (ZSParse.isInjectedFeedback(txt)) results++;
      else users++;
    }
    return { users, results };
  }

  function sinceLastSys() {
    const dom = sinceLastSysInDom();
    return {
      users: Math.max(sysCount.users, dom.users),
      results: Math.max(sysCount.results, dom.results),
    };
  }

  // A re-statement is owed once EITHER budget is spent. Two triggers because
  // they measure different things: user turns track a long back-and-forth, while
  // injected results track context VOLUME - and volume is what actually makes
  // the site summarise. Measured live on 2026-08-14: in a real session 5 of the
  // 6 "user" turns were injected tool results and only ONE was typed by Seb, so
  // a user-turn-only trigger sat at 1/6 while five full tool payloads had
  // already landed. The results budget is the one that fires in practice.
  function sysResendDue() {
    if (!RESEND_SYS_EVERY) return false;
    const { users, results } = sinceLastSys();
    const due = users >= RESEND_SYS_EVERY || results >= RESEND_SYS_EVERY_RESULTS;
    // Logged sparsely on purpose: this is consulted on EVERY tool result, and an
    // entry each time would flush the 300-slot diag ring of everything else -
    // exactly the history you need when something goes wrong. The verdict turn
    // and every 4th result is enough to reconstruct the tally.
    if (due || results % 4 === 0) {
      diag("sys.tally", {
        users, results, due,
        mem: `${sysCount.users}/${sysCount.results}`,
        need: `${RESEND_SYS_EVERY}u ${RESEND_SYS_EVERY_RESULTS}r`,
      });
    }
    return due;
  }
  // Attach the prompt to an outgoing tool result IF it fits. The result is never
  // truncated to make room: the passenger is dropped and the flag stays raised,
  // so it rides the next result instead. A tool result the model is waiting on
  // is always worth more than a reminder.
  function withSysResend(text) {
    if (!sysResendDue()) return text;
    const prompt = systemPrompt();
    const rider =
      "\n\n────────────────────────────────\n" +
      ZS.RESEND_MARKER + "\n" +
      "(System note from FreeAgent - an automatic re-statement of your operating " +
      "instructions, NOT a new request and NOT something to reply to. This conversation " +
      "may have been summarised, which drops the part explaining how you actually run " +
      "commands. To be explicit: the FreeAgent extension IS running in this page right " +
      "now, it DOES read your replies, and the commands below DO execute for real - the " +
      "results you have been receiving are proof of it. Keep using them exactly as " +
      "described. Just carry on with the task; do not acknowledge this note.)\n" +
      prompt;
    const cap = P.sendCharBudget || Infinity;
    if (text.length + rider.length > cap) {
      // Stays due - the next (smaller) result carries it.
      diag("sys.resendDeferred", { result: text.length, rider: rider.length, cap });
      return text;
    }
    const spent = sinceLastSys();
    resetSysCount();
    A.sysResendAt = Date.now();
    diag("sys.resend", { via: "toolResult", chars: rider.length, ...spent });
    return text + rider;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SESSION BOOTSTRAP  ("Starting Up" animated chip, shown in the conversation)
  // ════════════════════════════════════════════════════════════════════════
  async function startSession() {
    if (A.running || A.starting) return;
    // "Start session" is allowed ONLY on a blank conversation. Opening an
    // EXISTING conversation must never trigger the bootstrap.
    if (!P.chatIsEmpty() && !A.started) {
      ui.toast("Open a new, empty conversation to start a session.");
      return;
    }
    A.userStopped = false;
    A.stop = false;               // clear any halt left by a prior aborted bootstrap
    // Snapshot any turn already on screen at session start (normally none on a
    // clean new chat; on a reload-restored generation it's the stray turn). The
    // auto-resume watchdog refuses to run a tool from this baseline turn so a
    // restored execute_luau can't leak into the freshly started conversation.
    A.bootBaselineId = P.lastAssistantId ? P.lastAssistantId() : null;
    A.starting = true;
    const myGen = ++A.startGen;   // identity of THIS bootstrap
    A.startingKey = null;          // unknown until the conversation gets an id
    const alive = () => A.startGen === myGen; // false once superseded/aborted
    A.toolCallsSinceReminder = 0; // fresh reminder cadence for the new session
    ui.setStarting(true);
    ui.updateStartGate(); // refresh the bar into its "starting" state
    P.setInputLock(true); // block user input during bootstrap
    ui.inputCover(true);  // cover the composer ("Working…") for the WHOLE Starting Up
    try {
      await ensureTools(true); // boot: always take a fresh catalogue (the TTL then
                               // covers the list_commands / list_mcp_servers calls
                               // the model makes seconds later)
      if (!alive()) return;
      if (!A.toolList.length) {
        ui.banner("warn", "Bridge or Studio offline",
          "Could not fetch local tools. Start the bridge and pair the extension popup, then retry.");
        return;
      }
      const modeState = await P.ensureComposerReady("startup");
      if (!alive()) return;
      if (!modeState.ready) {
        ui.banner("warn", `${P.displayName} mode not ready`,
          `Could not switch ${P.displayName} to the required mode. Start a new chat or reload the page, then try again.`);
        return;
      }
      const prompt = systemPrompt();
      const base = await submitAndGetBase(prompt);
      if (!alive()) return;
      // (syncSessionState pins A.startingKey to the conversation id once the chat
      // has content, and aborts this bootstrap if the user opens a new empty chat.)
      decorate.sweep(); // show the animated "Starting Up" chip immediately
      let startRes = await waitForResponse(base);
      for (let attempt = 0; attempt < 2 && startRes.kind === "parse_error" && !A.stop && alive(); attempt++) {
        const correctedBase = await submitAndGetBase(ZS.FEEDBACK.parseError(startRes.reason));
        startRes = await waitForResponse(correctedBase);
      }
      if (!alive()) return;
      // The user halted the bootstrap (our Stop or the site's native stop). Do
      // NOT declare the session ready - abort quietly so "Start" stays available.
      if (A.stop || startRes.kind === "stopped") { diag("start.aborted", { kind: startRes.kind }); return; }

      // If the model calls list_commands as instructed, run it and wait for the "ready" reply.
      const firstName = startRes.calls && startRes.calls[0] && startRes.calls[0].tool;
      if (startRes.kind === "tool" && startRes.calls && startRes.calls.length === 1 &&
          (firstName === "list_commands" || firstName === "list_tools")) {
        decorate.toolBox(startRes.item, "Loading commands", "run", "", true);
        const toolFeedback = await runTool(startRes.calls[0]);
        // local agent down short-circuits list_commands into a plain "offline" note
        // (main.js, list_commands handler) instead of the real catalogue - detect
        // that and show it as such, rather than the STALE cached tool count below
        // (the bridge keeps advertising local agent's catalogue even with no Studio
        // attached, so A.toolList still has 25+ entries that were never actually
        // usable this boot).
        if (/local agent is currently OFFLINE/.test(toolFeedback)) {
          decorate.toolBox(startRes.item, "Loading commands", "err", "local agent offline", true);
        } else {
          // Count what the model ACTUALLY received: list_commands is scoped to the
          // primary local agent server (main.js ~629), so showing A.toolList.length (every
          // connected server merged - local agent + Blender + addons) overstated the boot
          // count and made it look like all servers were loaded at once. Count the
          // local agent-scoped tools instead, matching the real result.
          const robloxCount = A.toolList.filter((t) => (t.server || "local") === "local").length;
          decorate.toolBox(startRes.item, "Loading commands", "done", `${robloxCount} commands`, true);
        }
        const base2 = await submitAndGetBase(toolFeedback);
        const readyRes = await waitForResponse(base2); // wait for "I'm ready" reply
        if (!alive()) return;
        if (readyRes.kind !== "text") { ui.banner("warn", "Startup incomplete", "The provider did not finish its readiness acknowledgement. Open a fresh chat and retry."); return; }
        if (A.stop || readyRes.kind === "stopped") { diag("start.aborted", { kind: readyRes.kind }); return; }
      }
      if (startRes.kind !== "tool" || !["list_commands", "list_tools"].includes(firstName)) {
        ui.banner("warn", "Agent startup needs a retry", "The provider did not return the initial list_commands request in the required format. Start again or use a new empty chat.");
        return;
      }
      A.started = true;
      rememberSession(P.conversationKey()); // survives virtualization AND reloads
      ui.setStarted(true);
      ui.toast(`Agent ready. Ask ${P.displayName} to work on a task.`);
    } catch (e) {
      if (alive()) ui.banner("warn", "Startup failed", String((e && e.message) || e));
    } finally {
      // Only tear down our OWN starting state. If we were superseded (the user
      // opened another chat), the newer flow / syncSessionState owns it now.
      if (alive()) {
        A.starting = false;
        A.startingKey = null;
        ui.setStarting(false);
        ui.inputCover(false); // lift the Starting Up composer cover
        P.setInputLock(false); // always unlock after bootstrap
        decorate.sweep();
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SVG ICON SET  (stroke = currentColor, inherits the chip's theme colour)
  // ════════════════════════════════════════════════════════════════════════
  const SVG = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const ICONS = {
    screen:  SVG('<rect x="3" y="4" width="18" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
    roblox:  SVG('<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>'),
    read:    SVG('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
    edit:    SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    generate: SVG('<path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/>'),
    tool:    SVG('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2z"/>'),
    result:  SVG('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    check:   SVG('<polyline points="20 6 9 17 4 12"/>'),
    // Bell - the mid-session system-prompt re-statement. Deliberately NOT the
    // gear: the gear means "the agent is starting up", and a reminder is the
    // opposite (a session already long enough to need re-anchoring).
    remind:  SVG('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
    error:   SVG('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    gear:    SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15H4.5a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 11 4.6h.09A1.65 1.65 0 0 0 12 3.09 2 2 0 0 1 16 3v.09A1.65 1.65 0 0 0 19 4.6l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 21.4 11h.1a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.5 1z"/>'),
  };
  const SPIN = '<span class="zs-spin"></span>';

  function iconFor(category, phase) {
    if (phase === "run") return SPIN;
    if (phase === "err") return ICONS.error;
    if (phase === "done") return ICONS.check;
    if (phase === "result") return ICONS.result;
    if (phase === "sys") return ICONS.gear;
    if (phase === "remind") return ICONS.remind;
    return ICONS[category] || ICONS.tool;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CAMOUFLAGE / DECORATION  (chips are real "tool cards": header + an
  //  expandable body, themed by tool category and execution state)
  // ════════════════════════════════════════════════════════════════════════

  // Strip every trace of our decoration from a node. Needed because sites
  // virtualize (recycle) turn nodes: a node that was a command/result card can
  // be reused to render unrelated text.
  function resetDecoration(item) {
    const chip = item.querySelector(".zs-chip");
    if (chip) chip.remove();
    item.classList.remove("zs-hidden");
    item.querySelectorAll(".zs-tool-hide").forEach((e) => e.classList.remove("zs-tool-hide"));
    item.querySelectorAll(".zs-cmd-mask").forEach((e) => e.classList.remove("zs-cmd-mask"));
    delete item.dataset.zs;
    delete item.dataset.zsig;
    delete item.dataset.zphase;
    delete item.dataset.zStopped;
    delete item.dataset.zRegenLen;
    delete item.dataset.zRegenAt;
    delete item.__zsChip;
  }

  const decorate = {
    // Core renderer. opts: {label, detail, body, category, phase, cls, whole}
    chip(item, opts) {
      const { label, detail = "", body = "", category = "tool", phase, cls, whole } = opts;
      let chip = item.querySelector(".zs-chip");
      const hasBody = !!body;
      // While a command streams, the site re-renders the raw block on every token
      // and we get called on nearly every sweep. If what we'd draw is identical,
      // we must NOT rebuild the chip's innerHTML: doing so re-creates the
      // <span class="zs-spin"> and restarts its CSS animation each time, so the
      // spinner looks frozen / stutters ("retry en rafale"). Rebuild the inner
      // markup ONLY when the rendered content actually changes; otherwise reuse
      // the existing element (and keep its expand/collapse state) so the spinner
      // keeps spinning smoothly. Re-anchoring + masking below still run each pass.
      const sig = `${category}|${phase}|${cls || ""}|${whole ? 1 : 0}|${label}|${detail}|${hasBody ? body.length : 0}`;
      if (!chip) chip = document.createElement("div");
      if (chip.dataset.csig !== sig) {
        chip.dataset.csig = sig;
        chip.className = `zs-chip cat-${category} ${cls || ""}`;
        chip.innerHTML =
          `<div class="zs-chip-head">` +
            `<span class="zs-chip-ic">${iconFor(category, phase)}</span>` +
            `<span class="zs-chip-tx"></span>` +
            `<span class="zs-chip-dt"></span>` +
            (hasBody ? `<span class="zs-chip-cv">${SVG('<polyline points="6 9 12 15 18 9"/>')}</span>` : "") +
          `</div>` +
          (hasBody ? `<div class="zs-chip-body"><pre></pre></div>` : "");
        chip.querySelector(".zs-chip-tx").textContent = label;
        if (detail) chip.querySelector(".zs-chip-dt").textContent = detail;
        if (hasBody) {
          chip.querySelector(".zs-chip-body pre").textContent = body;
          const head = chip.querySelector(".zs-chip-head");
          head.style.cursor = "pointer";
          head.onclick = () => chip.classList.toggle("open");
        }
      }

      if (whole) {
        // Fully injected turn (result / sys) → hide the whole item.
        if (chip.parentElement !== item) item.insertBefore(chip, item.firstChild);
        item.classList.add("zs-hidden");
      } else {
        item.classList.remove("zs-hidden");
        // findToolBlockSpot ALSO applies the .zs-tool-hide classes (its real job);
        // we call it for that even when we don't use its returned position.
        const spot = P.findToolBlockSpot(item, chip);
        if (P.chipAtItemLevel) {
          // Site re-renders the turn's content subtree (Angular/Gemini), which
          // wipes any chip placed INSIDE it. Anchor the chip at the turn-element
          // level instead, where it survives those re-renders; the hide classes
          // (re-applied by the sweep) handle masking the raw block.
          // A provider may supply chipAnchor(item) to redirect the chip into a
          // descendant (e.g. Kimi's turn is a flex ROW [avatar | content];
          // inserting at item.firstChild would make the chip the avatar's flex
          // sibling and shove the layout sideways, so it anchors in the content
          // column instead). Default: the turn root.
          const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
          // Default: pin the chip as the FIRST child - simple and immune to the
          // site re-appending fresh content later. A provider may opt into
          // `chipAppend` to place it LAST instead (reads in the model's actual
          // order: narration, then the tool call it wrote at the end of the
          // turn). `chipTrailRef(item)` lets it name a fixed trailing sibling
          // (e.g. Qwen's action-buttons row) the chip must stay BEFORE even
          // when "last" - see ensureOwnedChip's drift check for why this needs
          // upkeep that firstChild pinning never did.
          const wantLast = !!P.chipAppend;
          const trailRef = wantLast && P.chipTrailRef ? P.chipTrailRef(item) : null;
          const inPlace = chip.parentElement === anchor &&
            (wantLast ? chip.nextElementSibling === trailRef : anchor.firstElementChild === chip);
          if (!inPlace) {
            if (wantLast) anchor.insertBefore(chip, trailRef); // trailRef=null -> append
            else anchor.insertBefore(chip, anchor.firstChild);
          }
        } else if (spot) {
          spot.parent.insertBefore(chip, spot.ref);
        } else if (!chip.parentElement) {
          item.insertBefore(chip, item.firstChild);
        }
      }
      item.dataset.zs = cls || "1";
      // Remember the exact opts so a chip wiped by a site re-render can be
      // rebuilt identically (see ensureOwnedChip / the chipGone guards).
      item.__zsChip = { ...opts };
      return chip;
    },

    // Re-apply a loop-owned chip after a site re-render wiped it (chip removed
    // and/or the .zs-tool-hide classes stripped). The loop owns the label/phase,
    // so we rebuild from the stored opts rather than re-running classification.
    ensureOwnedChip(item) {
      const opts = item.__zsChip;
      if (!opts) return;
      const chipEl = item.querySelector(".zs-chip");
      const chipGone = !chipEl;
      let rawVisible = false;
      if (!opts.whole) {
        // NOTE the thinking exclusion: reasoning models QUOTE the command
        // JSON/###CODE:run_python### in their think area, which the camouflage never hides
        // (by design) - counting those as "raw block visible" made this
        // rebuild fire on EVERY sweep forever (60Hz spam, seen live).
        rawVisible = [...item.querySelectorAll("pre, p, [class*='code'], .cm-line")].some(
          (e) => !e.closest(".zs-tool-hide") && !e.closest(".zs-chip") &&
                 !(P.thinkingSel && e.closest(P.thinkingSel)) &&
                 // Some sites (Arena) wrap a code block in a bare outer <pre>
                 // that has no hide class of its own - the real content (and
                 // the .zs-tool-hide class) live on a child wrapper instead.
                 // closest() only checks ancestors, so without this the outer
                 // <pre> reads as "raw command visible" FOREVER (its own
                 // textContent includes the hidden child's text), causing an
                 // infinite rebuild loop (~60/s, seen live on Arena).
                 !e.querySelector(".zs-tool-hide") &&
                 ZSParse.hasCommandShape(e.textContent || ""));
      }
      // A provider opted into `chipAppend` (chip trails the reply text instead
      // of pinning first) has no equivalent of firstChild's immunity to churn:
      // a site re-render can re-append fresh reply content AFTER our chip,
      // silently shoving it back above the text it was meant to trail. Catch
      // that drift too, not just an outright wipe - it's cheap (one property
      // read) and only applies to opted-in providers (Qwen).
      let drifted = false;
      if (!opts.whole && !chipGone && P.chipAtItemLevel && P.chipAppend) {
        const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
        const trailRef = P.chipTrailRef ? P.chipTrailRef(item) : null;
        drifted = chipEl.parentElement === anchor && chipEl.nextElementSibling !== trailRef;
      }
      if (chipGone || rawVisible || drifted) {
        // Tracker: the site wiped a loop-owned chip (re-render/node churn).
        diag("chip.rebuild", { name: opts.label, phase: opts.phase, chipGone, rawVisible, drifted });
        this.chip(item, opts);
      }
    },

    // owned=true → the agentic loop manages this item; the observer backs off.
    toolBox(item, name, phase, detail, owned, body, category) {
      if (!item) return;
      // Tracker: every phase TRANSITION of a command chip, with who drove it.
      // "loop" = the agentic loop (authoritative), "sweep" = DOM classification.
      if (item.dataset.zphase !== phase) {
        diag("chip.phase", {
          name, from: item.dataset.zphase || "(new)", to: phase,
          by: owned ? "loop" : "sweep", detail: detail || "",
        });
      }
      const cls = phase === "run" ? "run" : phase === "err" ? "err" : phase === "idle" ? "idle" : "done";
      this.chip(item, {
        label: name, detail: detail || "", body: body || "",
        category: category || ZS.toolCategory(name), phase, cls,
      });
      item.dataset.zphase = phase;
      if (owned) item.dataset.zloop = "1";
    },

    classify(item, next) {
      if (item.dataset.zloop) { this.ensureOwnedChip(item); return; } // loop owns it
      const txt = P.classifyText(item, ".zs-chip"); // excludes thinking AND our chip

      // NOTE on the "needs re-apply" guards below: some sites (Gemini/Angular)
      // re-render a turn's CHILDREN on every update - our chip and the
      // .zs-tool-hide classes are wiped while the dataset flags on the turn
      // element itself survive. So "already decorated" must always be
      // double-checked against the chip actually being present in the DOM.
      const chipGone = !item.querySelector(".zs-chip");

      // 1a. A mid-session RE-STATEMENT of the system prompt. Checked before the
      //     bootstrap branch because it carries SYS_MARKER too (that marker is
      //     what hides it), and without this it inherited the bootstrap's
      //     "Starting Up" gear - which reads as if the agent restarted, exactly
      //     the confusion Seb reported. Never animated: nothing is starting.
      if (txt.includes(ZS.RESEND_MARKER)) {
        if (item.dataset.zs !== "resend" || chipGone) {
          // The rider travels ON a tool result, so this one turn is both things.
          // Name the tool in the detail rather than dropping it - otherwise that
          // result is the only one in the conversation with no visible outcome.
          const m = txt.match(/Output of '([^']+)'/);
          this.chip(item, {
            label: "Reminder",
            detail: m ? `with ${m[1]} result` : "",
            category: "remind", phase: "remind", cls: "sys", whole: true,
          });
          item.dataset.zs = "resend";
          item.dataset.zphase = "remind";
        }
        return;
      }

      // 1. System-prompt bootstrap turn → animated while starting, gear when done.
      if (txt.includes(ZS.SYS_MARKER)) {
        const phase = A.starting ? "run" : "sys";
        if (item.dataset.zs !== "sys" || item.dataset.zphase !== phase || chipGone) {
          this.chip(item, { label: "Starting Up", category: "tool", phase, cls: "sys", whole: true });
          item.dataset.zphase = phase;
        }
        return;
      }

      // 2. Injected result / ERROR / note turns. ALWAYS a user turn we sent,
      //    keyed off our fixed output shapes (never command keywords).
      if (P.isUserItem(item) && ZSParse.isInjectedFeedback(txt)) {
        const m = txt.match(/Output of '([^']+)'/);
        const isErr = /^\s*ERROR\b/.test(txt);
        // Reload-proof image detection: a feedback carrying an image ends with the
        // IMAGE_FEEDBACK_RE marker. Learn the tool (persisted) so its command turn
        // above AND its next call get the "screen" chip even with no loop running.
        const hasImg = !isErr && IMAGE_FEEDBACK_RE.test(txt);
        if (hasImg && m) rememberImageTool(m[1]);
        const sig = (m ? m[1] : "note") + "|" + (isErr ? "err" : hasImg ? "img" : "result");
        if (item.dataset.zsig !== sig || !item.classList.contains("zs-hidden") || chipGone) {
          this.chip(item, {
            label: m ? `${m[1]} · result` : "result",
            category: hasImg ? "screen" : m ? ZS.toolCategory(m[1]) : "tool",
            body: txt, phase: isErr ? "err" : "result",
            cls: isErr ? "err" : "result", whole: true,
          });
          item.dataset.zsig = sig;
        }
        return;
      }

      // 2b. FALLBACK for a command turn whose raw tool-call text is no longer
      // readable (e.g. Qwen disposes/never fully renders an off-screen Monaco
      // code block on a COLD page load - the dataset.zsCode cache only helps
      // WITHIN a session, since it needs to observe the block live to capture
      // it before disposal; reported live: every past tool-call chip vanished
      // after a page reload, leaving only its "· result" box). The turn's own
      // text no longer "looks like" a command, but the VERY NEXT turn being
      // our injected result (`Output of 'name'`) is definitive proof it WAS
      // one - settle it from that evidence instead of leaving the chip gone.
      if (P.isAssistantItem(item) && !ZSParse.hasCommandShape(txt) &&
          next && P.isUserItem(next)) {
        const nt = P.classifyText(next, ".zs-chip");
        const m = nt.match(/^\s*Output of '([^']+)'/);
        if (m) {
          const isErr = /^\s*ERROR\b/.test(nt);
          const phase = isErr ? "err" : "done";
          if (item.dataset.zphase !== phase || chipGone) {
            this.toolBox(item, m[1], phase, "", false);
          }
          return;
        }
      }

      // 3. Assistant command turns → live loading while streaming, ✓ when done.
      // ONLY in a real FreeAgent session (started or bootstrapping). Without
      // this gate, a plain never-started chat where the model merely EXPLAINS
      // the command format (a {"command":...} example in its answer) got the
      // example MASKED behind a tool chip - hiding genuine content the user
      // asked for. Same principle as domHasZsSignal: a command shape alone is
      // not proof of a session. (Branches 1/2 above key off OUR OWN injected
      // markers, which only exist in real sessions, so they need no gate.)
      if (P.isAssistantItem(item) && ZSParse.hasCommandShape(txt) &&
          (A.started || A.starting)) {
        // Regenerate transition (see zRegenLen capture in regenResume): the site is
        // still showing the OLD command text after a post-stop regenerate, before it
        // wipes and re-streams. Keep the coherent red "stopped" look instead of
        // re-animating the stale old call as a fresh "run" spinner. Clears the moment
        // the content is actually replaced (stream length drops below the captured
        // baseline) or a short safety window elapses, after which normal
        // classification paints the freshly regenerated command.
        if (item.dataset.zRegenLen) {
          const baseLen = Number(item.dataset.zRegenLen);
          const armedAt = Number(item.dataset.zRegenAt || 0);
          const replaced = txt.length < baseLen - 8;      // old content wiped
          const expired = Date.now() - armedAt > 6000;    // safety fallback
          if (!replaced && !expired) {
            const nm = ZSParse.toolNameFromText(txt) || "command";
            this.toolBox(item, nm, "err", "stopped", false);
            return;
          }
          delete item.dataset.zRegenLen;
          delete item.dataset.zRegenAt;
        }
        // A turn the user manually halted (Stop / native stop) stays "stopped" -
        // never let this sweep repaint it ✓ done (or worse, re-spin it) just
        // because generation is still settling. The dataset marker is set where we
        // halt, but on Arena the A/B carousel re-renders the turn node on every
        // token, wiping the marker - so the spinner came back even after Stop. Also
        // derive "stopped" from the userStopped latch (which survives node swaps)
        // for the last turn; it's cleared on the next user message / deliberate
        // resume, so a settled turn is never falsely frozen later.
        // A turn that is GENERATING again (or whose tool the loop is actively
        // running), with NO active user-stop latch, has been REGENERATED - it is no
        // longer the halted turn. Clear its stale halt so isRememberedHalted (index
        // + text-prefix based) can't keep repainting the FRESH command red: a Gemini
        // regenerate reuses the same assistant index and a similar opening prefix,
        // so the old halt otherwise matches and the running command shows "stopped"
        // (red) until it settles. Gated on !A.userStopped so a real Stop that is
        // still settling (isGenerating can lag true for a beat) is NEVER cleared.
        const regenerating = !A.userStopped && (
          (item === P.lastAssistant() && P.isGenerating()) ||
          (A.running && A.toolItem === item)
        );
        if (regenerating) { delete item.dataset.zStopped; forgetHalted(item); }
        const stopped = !regenerating && (
          item.dataset.zStopped === "1" ||
          (A.userStopped && item === P.lastAssistant()) ||
          isRememberedHalted(item, txt));
        // Self-heal: a site re-render that swapped this turn's node wiped the
        // dataset marker - re-stamp it so the stop survives the next wipe of
        // the A.userStopped latch (a fresh user message clears it by design).
        if (stopped && item.dataset.zStopped !== "1") {
          item.dataset.zStopped = "1";
          diag("chip.rehalt", { name: ZSParse.toolNameFromText(txt) });
        }
        // The loop already SETTLED this very call (tool finished, we're waiting
        // for the model's next turn) but the site swapped the turn's DOM node,
        // wiping the chip, the zloop ownership AND the __zsChip opts. Without
        // this, the fresh node re-classifies as a spinning "run" chip (A.running
        // is still true) on an already-executed call. Re-own it with the settled
        // outcome. The count guard skips this once the model's NEXT turn exists,
        // so a follow-up call to the same tool still classifies live.
        if (!stopped && A.running && !A.toolRunning && A.toolSettle &&
            // Same TURN check. Node identity when available (virtualization-proof:
            // on Qwen the count doesn't grow for a new turn, and a back-to-back
            // call to the same tool defeats the name guard - the old outcome then
            // repainted the STREAMING next turn's chip as done/err). Falls back to
            // the count guard for providers without lastAssistantId.
            (A.toolSettle.id !== undefined && P.lastAssistantId
              ? P.lastAssistantId() === A.toolSettle.id
              : A.toolSettle.count === P.assistantCount()) &&
            item === P.lastAssistant() &&
            ZSParse.toolNameFromText(txt) === A.toolName) {
          diag("chip.reown", { name: A.toolName, phase: A.toolSettle.phase });
          this.toolBox(item, A.toolName, A.toolSettle.phase, A.toolSettle.detail,
            true, A.toolSettle.body, A.toolSettle.category);
          return;
        }
        // Is this command turn the IN-FLIGHT call - the one a running loop or the
        // bootstrap is about to own? The tell: it has NO injected result turn after
        // it yet. Every ALREADY-EXECUTED command turn is followed by its injected
        // result (a user turn matching isInjectedFeedback), so keying off that,
        // rather than item === lastAssistant(), robustly separates the in-flight
        // turn from settled history. This gives us the best of both:
        //  - The Kimi/bootstrap flash fix: while a loop/bootstrap is active, the
        //    in-flight turn stays "run" in the window between generation ending and
        //    the loop painting its own chip, WITHOUT depending on the flickery
        //    lastAssistant() (Kimi's Vue swaps the node) - no premature green flash.
        //  - No re-spin on REVISIT: when a started chat is re-opened and the loop
        //    or bootstrap runs again, every PAST command turn already has its result
        //    below it, so it settles to "done" instead of every old chip re-loading
        //    to a blue spinner (the Arena "all chips restarted loading" report).
        const resultAfter = next && P.isUserItem(next) &&
          ZSParse.isInjectedFeedback(P.classifyText(next, ".zs-chip"));
        const inFlight = (A.running || A.starting) && !resultAfter;
        // Regenerate grace: keep the freshly-regenerated command turn "run" in the
        // gap between regenResume clearing the stop latch and the watchdog starting
        // the loop, so it never flashes a premature ✓ "done" (see regenResume). The
        // anchor slides with generation and expires ~2.5s after it truly stops.
        const resumeGrace = A.resumeArmed && item === P.lastAssistant() &&
          Date.now() - (A.resumeArmedAt || 0) < 2500;
        const live = !stopped && (
          inFlight || resumeGrace || (item === P.lastAssistant() && P.isGenerating())
        );
        // Orphaned command: a COMPLETE command turn that is the last assistant with
        // NO result below it, not live and not loop-owned, whose generation is now
        // stale (typically the page/extension was reloaded while this command sat
        // un-executed). The auto-resume watchdog deliberately refuses to run a
        // reload-restored generation (the "execute_luau leaked into the new chat"
        // leak guard - same lastGenAt staleness test used here), so it will NEVER
        // execute. Painting it a green ✓ "done" falsely implies the tool ran and
        // succeeded; show a neutral, greyed "not run" state instead (cosmetic only -
        // we intentionally do NOT auto-execute it).
        // A command turn we have no evidence ever executed: not loop-owned, no
        // injected result below it, and not in the off-DOM executed memory (the
        // memory keeps this virtualization-safe - a scrolled-back turn whose result
        // detached is still known-executed and never mislabelled).
        const neverRun = !item.dataset.zloop && !resultAfter &&
          !isRememberedExecuted(item, txt);
        // Superseded orphan: abandoned command - a NEWER assistant turn exists below
        // it yet it never ran (e.g. stopped then regenerated into a fresh turn on
        // Qwen). It will never execute, so it must show neither a green ✓ "done" NOR
        // a live spinner. inFlight is not turn-specific: with the loop running the
        // NEW turn, this old no-result turn would otherwise also read as "run" - the
        // "both the old and the new chip spinning at once" seen live.
        const supersededOrphan = neverRun && item !== P.lastAssistant();
        // Reload orphan: the LAST command turn, not live, whose generation is stale -
        // the page/extension was reloaded while it sat un-executed and the watchdog
        // refuses to run a reload-restored generation (leak guard). Also never a
        // false green ✓; show a neutral, greyed "not run" (we do NOT auto-execute it).
        // Tied to RESUME_FRESH_MS, never a separate literal: this must not paint
        // "not run" while the resume watchdog is still entitled to execute the
        // command. With the two numbers out of step (8s here vs the watchdog's
        // window) a command that WAS about to run got labelled dead first.
        const staleLastOrphan = neverRun && item === P.lastAssistant() && !live &&
          Date.now() - A.lastGenAt > RESUME_FRESH_MS;
        const orphanPending = !stopped && (supersededOrphan || staleLastOrphan);
        // Handoff window: a JUST-finished last-assistant command with no result yet
        // that the loop has not taken over (A.running not yet true, so `live` is
        // false). Without this it flashes a premature ✓ "done" for the frames
        // between generation ending and the loop starting, THEN re-spins when the
        // loop paints its own chip - most visible on the instant virtual commands
        // (list_mcp_servers/list_commands). Keep it spinning instead; staleLastOrphan
        // takes over after 8s if the loop genuinely never runs it.
        // Same window as the watchdog: while it can still fire, the honest state
        // is "waiting to run" (spinner), not a settled verdict either way.
        const pendingExec = !stopped && !orphanPending && !live &&
          neverRun && item === P.lastAssistant() && Date.now() - A.lastGenAt <= RESUME_FRESH_MS;
        let phase = stopped ? "err" : (orphanPending ? "idle" : ((live || pendingExec) ? "run" : "done"));
        let detail = stopped ? "stopped" : (orphanPending ? "not run" : "");
        // A DSML turn is the model calling a tool in its OWN markup, which can
        // never be executed - it always resolves to the "dsml" parse_error. So
        // once it has FINISHED streaming, "waiting to run" (spinner) and "not
        // run" (grey) are both wrong: it is not pending, it is already decided.
        // Left alone it inherited pendingExec and span for the whole
        // RESUME_FRESH_MS window before settling grey (reported live 2026-08-22).
        // Gated on !live on purpose: while the model is still WRITING the block
        // it must behave like any other command and show the spinner, or a slow
        // generation gives the user no feedback at all that anything is happening
        // - the chip paints "run" as it streams, then repaints red here the
        // moment generation ends. When our error result lands below, the
        // error-aware settle just below is skipped (phase is no longer "done") so
        // the more precise "bad format" wording survives.
        if (!stopped && !live && phase !== "err" && ZSParse.DSML_RE.test(txt)) {
          phase = "err"; detail = "wrong format";
        }
        // Error-aware settle: a command whose injected result RIGHT BELOW is an
        // ERROR must never wear a green ✓. The loop paints this correctly while
        // it owns the turn, but a revisited conversation (or a node swap that
        // dropped ownership) re-derives the phase here - from the conversation
        // itself, so it stays correct without any loop state.
        if (phase === "done" && next && P.isUserItem(next)) {
          const nt = P.classifyText(next, ".zs-chip");
          // feedbackIsError also catches an MCP tool's in-body error (the result
          // reads "Output of '…': Error executing code…", which our ERROR prefix
          // test would miss - the Blender case), so a revisited conversation
          // re-settles it red, matching what the loop painted live.
          if (ZSParse.isInjectedFeedback(nt) && feedbackIsError(nt)) {
            phase = "err"; detail = "error";
            if (item.dataset.zphase !== "err") diag("chip.errSettle", { name: ZSParse.toolNameFromText(txt) });
          }
        }
        // A command block that is VISIBLE right now (its hide classes live on
        // child nodes that sites like Gemini re-create on every update, and the
        // block may render only AFTER the chip was first placed mid-stream).
        // Excludes the reasoning area (P.thinkingSel) like ensureOwnedChip:
        // thinking-quoted commands otherwise keep this true forever, and the
        // forced repaint recomputes `live` each sweep - the chip then FLAPS
        // done→run→done with the generation flicker (seen live as a settled
        // green chip blinking back to a blue spinner).
        const rawVisible = [...item.querySelectorAll("pre, p, [class*='code'], .cm-line")].some(
          (e) => !e.classList.contains("zs-tool-hide") && !e.closest(".zs-tool-hide") &&
                 !e.closest(".zs-chip") && !(P.thinkingSel && e.closest(P.thinkingSel)) &&
                 // see ensureOwnedChip's matching guard: a bare outer <pre>
                 // wrapping a hidden child wrapper otherwise reads as visible
                 // forever (Arena code-block markup).
                 !e.querySelector(".zs-tool-hide") &&
                 ZSParse.hasCommandShape(e.textContent || ""));
        // A tool learned to return images gets the "screen" chip even though its
        // name alone wouldn't reveal it (parity with local agent screen_capture). The
        // fact can land AFTER this turn first settled (imageTools loads from
        // storage async, or the result turn below is classified later the same
        // pass), so repaint when the current chip's category is stale too - the
        // phase-only guard would otherwise freeze it on the generic wrench.
        const nm = ZSParse.toolNameFromText(txt);
        const cat = A.imageTools.has(bareToolName(nm)) ? "screen" : undefined;
        const chipNow = item.querySelector(".zs-chip");
        const catStale = cat === "screen" && chipNow && !chipNow.classList.contains("cat-screen");
        // Chip drift for chipAppend providers (Kimi): the RUN chip is painted by
        // the SWEEP (owned=false, no zloop) until the loop takes over at
        // tool.start ~2s later, so ensureOwnedChip's drift fix (zloop-only) does
        // NOT run during that window. Meanwhile Vue mounts the copy/regenerate
        // toolbar (chipTrailRef) and inserts it ABOVE our chip node, flashing the
        // action buttons over the chip until something repaints it. Detect that
        // drift here too so the sweep re-seats the chip (chip() re-anchors before
        // trailRef) without waiting for the loop. Mirrors ensureOwnedChip.
        let drifted = false;
        if (P.chipAtItemLevel && P.chipAppend && chipNow) {
          const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
          const trailRef = P.chipTrailRef ? P.chipTrailRef(item) : null;
          drifted = chipNow.parentElement === anchor && chipNow.nextElementSibling !== trailRef;
        }
        if (item.dataset.zphase !== phase || chipGone || rawVisible || catStale || drifted) {
          // Tracker: WHY the sweep chose this phase (only when it changes -
          // chipGone/rawVisible repaints of the same phase stay silent).
          if (item.dataset.zphase !== phase) {
            // Extra suspicion flag: a command that settled ✓ done while it is
            // still the LAST assistant with NO injected result below it - the
            // exact shape of the "chip shows done but the model is still writing"
            // report. genDebug() (if the provider exposes it) breaks isGenerating
            // into its sub-signals so we can see WHICH one flickered false.
            const suspectDone = phase === "done" &&
              item === P.lastAssistant() && !resultAfter;
            diag("chip.why", {
              name: nm, to: phase,
              stopped, live, inFlight, resumeGrace, pendingExec,
              isLast: item === P.lastAssistant(), resultAfter,
              gen: P.isGenerating(), run: A.running, starting: A.starting,
              zStopped: item.dataset.zStopped === "1",
              remembered: isRememberedHalted(item, txt),
              lastGenAgoMs: Date.now() - A.lastGenAt,
              suspectDone,
              ...(P.genDebug ? { g: P.genDebug() } : {}),
            });
          }
          this.toolBox(item, nm, phase, detail, false, undefined, cat);
        }
        return;
      }

      // A user-halted turn whose CONTENT the site cleared. Arena's native stop
      // (which our Stop button clicks) empties the turn's .prose and shows
      // "Generation stopped" - so the command JSON vanishes, branch 3's command
      // shape no longer matches, and the empty-text guard just below would bail
      // every sweep, freezing a spinning "run" chip forever. Settle any lingering
      // run chip to "stopped" right here, BEFORE that guard. Idempotent: skips
      // once already at the err phase.
      const haltedTurn =
        item.dataset.zStopped === "1" ||
        (A.userStopped && item === P.lastAssistant());
      if (haltedTurn && P.isAssistantItem(item) && item.dataset.zphase !== "err"
          && item.querySelector(".zs-chip")) {
        const tx = item.querySelector(".zs-chip-tx");
        const name = ZSParse.toolNameFromText(txt) || (tx && tx.textContent) || "tool";
        this.toolBox(item, name, "err", "stopped", false);
        return;
      }

      // Transient empty render (Angular swaps a turn's subtree before refilling
      // it): the text vanishes for a frame. Never strip a decorated turn on
      // that - the next sweep re-evaluates it with real content.
      if (!txt.trim() && (item.dataset.zphase || item.dataset.zs)) return;

      // 4. Plain text turn. If this node still wears decoration (a recycled
      //    virtualized node), strip it so we never hide genuine content.
      if (item.dataset.zs || item.dataset.zphase || item.querySelector(".zs-chip")) {
        // Tracker: a decorated node re-classified as PLAIN TEXT (virtualized
        // node recycled, or the turn's command text vanished) - its decoration
        // (chip + zStopped marker) is stripped here. If a chip "un-settles"
        // mysteriously, this is the smoking gun to look for.
        diag("chip.reset", { was: item.dataset.zphase || item.dataset.zs || "chip-only" });
        resetDecoration(item);
      }
    },

    sweep() {
      // Pass each turn's FOLLOWING turn too: a command chip needs it to know
      // whether its injected result was an ERROR (error-aware settle above).
      const items = P.allItems();
      for (let i = 0; i < items.length; i++) this.classify(items[i], items[i + 1] || null);
      // Safety net for stopped turns whose chip lives OUTSIDE the enumerated
      // message list. On Arena an A/B comparison renders each candidate as a
      // slide in the carousel's OWN nested <ol>, not the main flex-col-reverse
      // list - so allItems()/classify never see that node and a "run" spinner
      // left by a Stop would spin forever. zStopped is only ever set on a
      // deliberate halt, so settling any run-phase chip under such a node is
      // safe wherever it lives. Idempotent: skips once at the err phase.
      for (const chip of document.querySelectorAll(".zs-chip.run")) {
        let item = chip.parentElement;
        while (item && !(item.dataset && item.dataset.zStopped)) item = item.parentElement;
        if (item && item.dataset.zphase !== "err") {
          const tx = chip.querySelector(".zs-chip-tx");
          this.toolBox(item, (tx && tx.textContent) || "tool", "err", "stopped", false);
        }
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════════
  //  UI  (control panel, onboarding, stop button, banners, toast, input cover)
  // ════════════════════════════════════════════════════════════════════════
  // General local-agent controls. Host-site DOM remains the provider's responsibility.
  const ui = (() => {
    const root = document.createElement("div"); root.id = "zs-root";
    root.style.cssText = "position:fixed;right:16px;top:16px;z-index:2147483600;color:#e9edf5;font:13px system-ui;width:310px;pointer-events:auto";
    const box = document.createElement("div");
    box.style.cssText = "background:#151c2a;border:1px solid #3e526a;border-radius:14px;padding:12px;box-shadow:0 8px 32px #0005";
    box.innerHTML = '<div style="display:flex;align-items:center;gap:8px"><strong style="flex:1">FreeAgent</strong><button data-action="settings">Settings</button><button data-action="collapse">−</button></div><div data-slot="body"><p data-slot="status" style="margin:10px 0">Pair the extension to your local bridge.</p><div style="display:flex;gap:8px"><button data-action="start">Start agent</button><button data-action="stop" hidden>Stop</button></div><div data-slot="settings" hidden><p>Session preferences</p><textarea rows="4" style="width:100%;box-sizing:border-box;background:#0c1220;color:#fff" placeholder="Optional instructions"></textarea><p style="font-size:11px">Pairing token and bridge port: extension popup. Workspace and extra MCP servers: config.json.</p></div><div data-slot="notices"></div></div>';
    for (const b of box.querySelectorAll("button")) b.style.cssText = "border:1px solid #486078;background:#24354b;color:#fff;border-radius:7px;padding:6px 9px;cursor:pointer";
    root.appendChild(box); document.body.appendChild(root);
    const status = box.querySelector('[data-slot="status"]');
    const start = box.querySelector('[data-action="start"]'), stop = box.querySelector('[data-action="stop"]');
    const settings = box.querySelector('[data-slot="settings"]'), custom = box.querySelector("textarea");
    const body = box.querySelector('[data-slot="body"]'), notices = box.querySelector('[data-slot="notices"]');
    chrome.storage.local.get("zaCustomPrompt", r => { custom.value = r.zaCustomPrompt || ""; });
    custom.addEventListener("change", () => chrome.storage.local.set({zaCustomPrompt: custom.value}));
    const resetPermissions = document.createElement("button"); resetPermissions.textContent = "Reset saved tool approvals";
    resetPermissions.style.cssText = "border:1px solid #486078;background:#24354b;color:#fff;border-radius:7px;padding:6px 9px;cursor:pointer";
    const permissionNote = document.createElement("p"); permissionNote.style.cssText = "font-size:11px";
    permissionNote.textContent = "Always allow choices persist across chats and restarts. Reset clears all saved tool approvals.";
    settings.append(permissionNote,resetPermissions);
    resetPermissions.addEventListener("click", async () => {
      resetPermissions.disabled = true;
      const result = await bg({type:"reset_tool_permissions"});
      resetPermissions.disabled = false;
      toast(result?.ok ? "Saved approvals cleared. Tools will ask again on their next call." : "Could not reset approvals: " + (result?.error || "Reload this page."));
    });
    function render() {
      const available = A.bridge.connected && A.bridge.tools > 0;
      status.textContent = A.parked ? "Paused: bring this chat tab to the front."
        : A.starting ? "Starting agent…"
        : A.running ? "Agent working…"
        : A.started ? (available ? "Agent ready · " + A.bridge.tools + " tools" : "Bridge disconnected. Open the extension popup.")
        : available ? "Ready · " + A.bridge.tools + " tools · start in an empty chat"
        : "Start the bridge, then pair in the extension popup.";
      start.hidden = A.started || A.running || A.starting;
      start.disabled = !available || !P.chatIsEmpty();
      stop.hidden = !(A.running || A.starting || (A.started && P.isGenerating()));
      stop.disabled = A.stopping;
      stop.textContent = A.stopping ? "Stopping…" : "Stop";
    }
    start.addEventListener("click", startSession); stop.addEventListener("click", stopLoop);
    box.querySelector('[data-action="settings"]').addEventListener("click", () => { settings.hidden = !settings.hidden; });
    box.querySelector('[data-action="collapse"]').addEventListener("click", e => { body.hidden = !body.hidden; e.target.textContent = body.hidden ? "+" : "−"; });
    function banner(tone, title, message) {
      notices.replaceChildren();
      const panel = document.createElement("div"); panel.style.cssText = "margin-top:10px;padding:8px;border:1px solid #bc8952;border-radius:8px;white-space:pre-wrap;max-height:200px;overflow:auto";
      const heading = document.createElement("strong"); heading.textContent = title;
      const detail = document.createElement("div"); detail.textContent = message;
      panel.append(heading, detail); notices.append(panel);
    }
    function toast(message) { banner("info", "FreeAgent", message); }
    function showImages(images, name) {
      const panel = document.createElement("div"); panel.style.cssText = "position:fixed;left:16px;bottom:16px;max-width:45vw;max-height:60vh;overflow:auto;padding:8px;background:#151c2a;border-radius:10px";
      const close = document.createElement("button"); close.textContent = "Close " + name; close.onclick = () => panel.remove(); panel.append(close);
      for (const img of images) {
        const image = document.createElement("img"); image.style.cssText = "display:block;max-width:100%";
        image.src = "data:" + (img.mimeType || "image/png") + ";base64," + img.data; panel.append(image);
      }
      root.append(panel);
    }
    render(); setInterval(render, 1000);
    return {
      setStatus: s => { A.bridge = {...A.bridge, ...s}; render(); },
      setStarted: render, setStarting: render, showStop: render, markStopping: render,
      inputCover: () => {}, toast, banner, showImages, nudgeStart: render,
      updateStartGate: render, refreshSetup: render, getCustomPrompt: () => custom.value,
      getCustomMcpServers: () => [], openMenu: () => { settings.hidden = false; body.hidden = false; },
      staleExtensionAlert: () => { A.staleExtension = true; banner("warn", "Reload this page", "The extension was reloaded. Press F5 to restore it."); }
    };
  })();

  // ── Live token + timer, shown ONLY on a tool call's chip detail. The
  //    elapsed-time ANCHOR is stored on the chip's DOM node (dataset) so the
  //    timer survives re-renders / conversation switches. ────────────────────
  const TOKEN_CHARS = 4;

  // 0-999 as-is; 1000+ compacted to 1k/1.1k/99k/1M... (one decimal below 10 of
  // the unit, none at/above it, trailing ".0" dropped) so a live token count
  // doesn't grow into a wide, jumpy number as the reply streams in.
  function formatCount(n) {
    if (n < 1000) return String(n);
    const units = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
    for (const [div, suf] of units) {
      if (n >= div) {
        const v = n / div;
        const rounded = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
        return rounded + suf;
      }
    }
    return String(n);
  }

  function setChipDetail(item, text) {
    const dt = item && item.querySelector(".zs-chip .zs-chip-dt");
    if (dt) dt.textContent = text;
  }

  // Update ONLY the chip's label text (no innerHTML rebuild), so live-correcting
  // the name mid-stream doesn't restart the spinner or wipe the token meter.
  function setChipLabel(item, text) {
    const tx = item && item.querySelector(".zs-chip .zs-chip-tx");
    if (tx && tx.textContent !== text) tx.textContent = text;
  }

  // Elapsed seconds since a per-item anchor (persisted on the node).
  function elapsedOn(item, key, fallbackStart) {
    if (!item) return 0;
    let t0 = Number(item.dataset[key] || 0);
    if (!t0) { t0 = fallbackStart || Date.now(); item.dataset[key] = String(t0); }
    return (Date.now() - t0) / 1000;
  }

  // Timestamp of the user's last REAL click on the site (trusted event, outside
  // FreeAgent's own UI). A genuine "regenerate ↻" is always such a click;
  // DeepSeek's post-stop phantom generations and stop-button re-mount flickers
  // never are - this is what tells them apart (seen live: two false regenResume
  // fired 8s/2s after a Stop with no user action, un-stopping the halted turn).
  let _userClickAt = 0;
  document.addEventListener("click", (e) => {
    if (e.isTrusted && !(e.target && e.target.closest && e.target.closest("#zs-root"))) {
      _userClickAt = Date.now();
    }
  }, true);

  let _prevHardGen = null, _prevSoftGen = null;
  setInterval(() => {
    const gen = P.isGenerating(); // growth-tolerant: used for the live token meter
    // Watchdog freshness clock. Growth-tolerant (not just the hard stop-button
    // signal): a SHORT command after a long reasoning phase shows its stop
    // square for only a frame or two - too briefly for this 200ms sampler.
    if (gen) A.lastGenAt = Date.now();
    // High-water mark of the newest turn id seen this session (virtualization-
    // safe). The auto-resume watchdog uses it to IGNORE a scrolled-back OLD turn:
    // on a virtualized list lastAssistant() is the last RENDERED turn, which when
    // scrolled up is old, and its injected-result row is off-screen/unrendered so
    // the "result below" guard can't see it. A numeric provider id (DeepSeek's
    // data-virtual-list-item-key) is monotonic per turn, so the max only grows at
    // the live bottom and a scrolled-back turn reads strictly below it.
    if (P.itemKey && P.lastAssistantId) {
      const nk = Number(P.lastAssistantId());
      if (Number.isFinite(nk) && (A.maxTurnId == null || nk > A.maxTurnId)) A.maxTurnId = nk;
    }
    // Slide the regenerate grace anchor while generation is still (intermittently)
    // active, so the chip stays "run" across gen-false blips right up to the moment
    // the watchdog re-owns the tool (see regenResume).
    if (A.resumeArmed && gen) A.resumeArmedAt = Date.now();
    const hardGen = A.started && P.isHardGenerating();

    // Regenerate-as-resume: after a manual stop (A.userStopped) the agent stays
    // dormant until fresh user intent. Typing a message or the native Continue
    // clears the latch, but clicking the site's "regenerate ↻" does not - and on
    // Qwen that control is unlabeled and indistinguishable from copy/like, so we
    // can't hook the button reliably. Detect the EFFECT instead: a brand-new
    // generation (gen false→true) while we are stopped and otherwise idle can only
    // come from a user action (there is no spontaneous generation). Treat it as
    // resume - clear the stop latch and drop the turn's stopped/no-resume markers
    // so the auto-resume watchdog can pick the regenerated reply's tool back up.
    // Providers with NO native "regenerate" control (e.g. ReidChat) can opt out
    // via hasRegenerate:false - for them a gen false→true blip while stopped is
    // only abort/caret churn, never a real regenerate, so honouring it would
    // spuriously clear the manual-stop latch and auto-resume against the user.
    // HARD edge only: the growth-tolerant `gen` blips false→true when the site
    // re-renders the HALTED turn after a stop (adding its "Stopped" marker grows
    // streamText, which counts as growth for 800ms) - that blip falsely cleared
    // the latch, repainted the stopped chip ✓ green and re-armed auto-resume. A
    // real regenerate always raises the site's stop control, so require it; on
    // DeepSeek (no stop control during reasoning) this merely delays the resume
    // to the answer phase, after which the watchdog acts anyway.
    // Tracker: a soft (growth-only) blip in the stopped-idle state - exactly the
    // false trigger the hard-edge gate above filters out. Log it so live tests
    // can SEE the old bug firing and being ignored.
    if (A.started && A.userStopped && !A.running && !A.injecting && !A.stopping &&
        gen && _prevSoftGen === false && !hardGen) {
      diag("regenBlip.ignored");
    }
    if (P.hasRegenerate !== false &&
        A.started && A.userStopped && !A.running && !A.injecting && !A.stopping &&
        hardGen && _prevHardGen === false) {
      // Gate on ACTUAL user intent: a real regenerate is always a trusted click
      // moments before the new generation, and never the Stop click itself.
      // Distinguish the two by ORDER, not a fixed delay: require the latest
      // trusted click to fall clearly AFTER the Stop (clickAfterStop). A native
      // stop click lands ~at A.stopAt, so it fails this and can't self-resume;
      // the extension's own "■ Stop" is inside #zs-root and never updates
      // _userClickAt at all, so only the later regenerate qualifies. This
      // replaces the old absolute `stopAge > 3000` grace, which also blocked a
      // user who regenerated quickly (~1.5s) after Stop - the real bug seen live.
      // DeepSeek's post-stop phantom generations carry no fresh trusted click,
      // so they still fail the gate.
      const clickAge = Date.now() - _userClickAt;
      const stopAge = Date.now() - (A.stopAt || 0);
      const clickAfterStop = _userClickAt - (A.stopAt || 0);
      if (clickAge < 2500 && clickAfterStop > 400) {
        A.userStopped = false;
        const it = P.lastAssistant();
        if (it) {
          delete it.dataset.zStopped; delete it.dataset.zResume;
          delete it.dataset.zResumeLen; delete it.dataset.zloop;
          forgetHalted(it);
          // Strip the OLD command's chip immediately. The regenerate reuses this
          // turn node, and without this the previous execute_luau chip (with its
          // spinner/settled state) lingers for ~200ms until the sweep repaints the
          // node - the visible "it keeps running the old call for a beat before
          // restarting" flash reported on Kimi. resetDecoration clears the chip and
          // every marker so the regenerated reply classifies fresh.
          resetDecoration(it);
          // Kimi (and other node-reusing sites) leave the OLD command text in the
          // reply DOM for ~2s after regenerate starts, before wiping it and
          // streaming the new reply. resetDecoration only removes OUR chip - the
          // sweep then re-derives a fresh "run" chip from that stale old command
          // (old token count and all) until the content is replaced: the "red
          // stopped chip turns into a grey spinner on the OLD call" flash reported
          // live. Capture the old text length so the sweep can tell the DOM still
          // holds the stale command and keep the coherent red "stopped" look until
          // Kimi actually replaces it (see the zRegenLen guard in classify).
          try {
            it.dataset.zRegenLen = String(P.classifyText(it, ".zs-chip").length);
            it.dataset.zRegenAt = String(Date.now());
          } catch {}
        }
        // Bridge the gap until the auto-resume watchdog (1s interval) re-owns the
        // tool: regenResume only CLEARS the stop latch, it does not start the loop
        // (the regenerated command hasn't finished streaming yet, so there's
        // nothing to dispatch). In that ~1s window A.running is still false and
        // Gemini's generation signal blips false between reasoning and command
        // settle, so the sweep painted the chip a premature ✓ "done" before the
        // real execution began. Arm a grace anchor the sweep honours as "live"; it
        // slides while generation blips (refreshed in the meter loop) and expires
        // shortly after generation truly stops, by which point the watchdog has
        // taken over (A.running) or the reply was plain text with no tool.
        A.resumeArmed = true;
        A.resumeArmedAt = Date.now();
        diag("regenResume", { clickAge, stopAge, clickAfterStop });
      } else {
        diag("regenEdge.ignored", { clickAge, stopAge, clickAfterStop });
      }
    }
    _prevHardGen = hardGen;
    _prevSoftGen = gen;
    // Our "■ Stop" button stays visible for the WHOLE active turn (generation,
    // reasoning, or a tool/wait running on the bridge). It is complete on its own
    // - stopLoop both halts our loop AND clicks the site's native stop - and the
    // site's native stop likewise halts our loop via onNativeStop, so either one
    // fully stops everything. Two stop buttons at once is fine.
    // The bare isHardGenerating() term is gated on a live FreeAgent session: on
    // a plain chat with no session, a user's own message makes the site generate,
    // and we must NOT briefly flash our Stop button over that.
    // Self-heal a stuck "Stopping…": if we flagged stopping but nothing is
    // actually busy anymore (the loop's finally never ran because the Stop landed
    // before a loop started, or a pending start was cancelled), release it so the
    // button doesn't freeze on "Stopping…". While the site is STILL streaming,
    // re-click its native stop (throttled) instead of releasing: the first click
    // sometimes gets swallowed by a re-render, and handing back a clickable
    // "■ Stop" the user has to press again is exactly the bounce we're killing.
    if (A.stopping && !A.running && !A.toolRunning) {
      if (A.started && P.isHardGenerating()) {
        // CRITICAL: only re-click the native stop if the reply has ACTUALLY kept
        // growing since the last stop click. On Gemini (and GLM) the stop button
        // WEDGES visible for up to ~10s after a successful stop, so the old
        // unconditional retry clicked a stop with NO live stream behind it -
        // and Gemini queues that stray abort against the conversation, then
        // KILLS THE NEXT reply the instant it starts ("Vous avez interrompu
        // cette réponse" on a message the user never stopped - validated live,
        // 2026-07: two stray stop.retry clicks after a ZS Stop made the next
        // two user turns die instantly; with no stray clicks the same flow
        // worked). A swallowed first click - the case this retry exists for -
        // always shows up as the stream STILL writing, i.e. growth past the
        // baseline captured at stop time (A.stopStreamLen, set in stopLoop /
        // onNativeStop and re-based after each retry so every retry needs
        // fresh growth of its own).
        const grown = (P.streamLen ? P.streamLen() : 0) > (A.stopStreamLen || 0) + 24;
        if (grown && Date.now() - (A.stopRetryAt || 0) > 800) {
          A.stopRetryAt = Date.now();
          A.stopStreamLen = P.streamLen ? P.streamLen() : 0;
          try { P.stopGeneration(); } catch {}
          diag("stop.retry");
        } else if (!grown && Date.now() - (A.stopAt || 0) > 2500) {
          // Wedged stop button on a dead stream (text frozen since the stop):
          // the site is effectively quiet - release "Stopping…" instead of
          // holding it for the whole wedge window.
          A.stopping = false;
          diag("stop.quiet", { wedged: true });
        }
      } else {
        A.stopping = false;
        diag("stop.quiet"); // drain over: site quiet, Stopping… released
      }
    }
    ui.showStop(A.running || A.toolRunning || A.stopping || (A.started && P.isHardGenerating()));

    // Tool is executing on the MCP → timer on its chip.
    if (A.toolRunning && A.toolItem) {
      const s = elapsedOn(A.toolItem, "zsToolT0", A.toolStart).toFixed(1);
      setChipDetail(A.toolItem, (A.toolArg ? A.toolArg + " · " : "") + `${s}s`);
      return;
    }
    // The site is streaming a tool call → token count + timer on its chip.
    if (gen) {
      const item = P.lastAssistant();
      const reply = item ? P.itemText(item) : ""; // non-thinking only
      const zphase = item && item.dataset.zphase;
      // Skip items already settled (done/err) - don't overwrite the finished chip.
      if (item && zphase !== "done" && zphase !== "err" && ZSParse.hasToolSignature(reply)) {
        // Live-correct the label as soon as the real name streams in.
        const name = ZSParse.toolNameFromText(reply);
        if (name && name !== "command") setChipLabel(item, name);
        const tokens = Math.floor(reply.length / TOKEN_CHARS);
        const s = Math.round(elapsedOn(item, "zsGenT0"));
        setChipDetail(item, `~${formatCount(tokens)} tokens · ${s}s`);
        return;
      }
    }
  }, 200);

  // ════════════════════════════════════════════════════════════════════════
  //  WIRING
  // ════════════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "zs-status") {
      ui.setStatus({ connected: msg.connected, mcpAlive: msg.mcpAlive, studio: msg.studio, studioApp: msg.studioApp, studioProc: msg.studioProc, tools: msg.tools, servers: msg.servers });
    }
    if (msg && msg.type === "zs-open-menu") {
      ui.openMenu(false); // from the popup's Settings button — opens at the top (Switch AI / custom prompt)
    }
  });

  // Status poll. An orphaned content script (see bg / isContextInvalidated) gets
  // a failure object back whose `connected` is undefined, which setStatus would
  // read as "the bridge just dropped" and answer with the red "run start.bat"
  // banner - sending the user to fix a bridge that is perfectly healthy, with
  // the one thing that WOULD fix it (reload the page) never mentioned. Catch it
  // before setStatus, say the right thing, and stop polling: the context can
  // never come back, so every later tick would just repeat the same failure.
  let statusTimer = 0;
  function onStatus(s) {
    if (!s) return;
    if (s.kind === "stale-extension") {
      clearInterval(statusTimer);
      ui.staleExtensionAlert();
      diag("bridge.staleExtension", { via: "status", error: s.error });
      return;
    }
    ui.setStatus(s);
  }
  // Hydrate the persisted re-statement budget for this conversation up front, so
  // the first tool result after a reload already knows the real tally.
  loadSysCount();
  bg({ type: "status" }).then(onStatus);
  statusTimer = setInterval(() => bg({ type: "status" }).then(onStatus), 5000);

  // Session state is derived from the ACTUAL chat, but sites VIRTUALIZE their
  // message lists: the system-prompt turn is dropped from the DOM once it
  // scrolls out of the window. So we key "started" by conversation
  // (P.conversationKey()): once we have seen the marker for a key, we remember
  // it (persisted so it survives reloads). We never flip while busy.
  const startedSessions = new Set();
  let lastSyncPath = null;
  function rememberSession(path) {
    // A falsy key = a TRANSIENT conversation URL (e.g. Gemini's /app before an
    // id is assigned). Remembering it would mark every future fresh chat as
    // "already started" and kill the Start gate. The real key is remembered by
    // the next sync once the site assigns the conversation its id.
    if (!path) return;
    if (startedSessions.has(path)) return;
    startedSessions.add(path);
    try { chrome.storage.local.set({ zsStartedSessions: [...startedSessions].slice(-300) }); } catch {}
  }
  // Load the persisted set once, then re-sync.
  try {
    chrome.storage.local.get("zsStartedSessions", (r) => {
      if (r && Array.isArray(r.zsStartedSessions)) {
        for (const p of r.zsStartedSessions) startedSessions.add(p);
        syncSessionState();
      }
    });
  } catch {}
  // A conversation IS a FreeAgent session if any rendered turn carries a
  // telltale artefact: the system-prompt marker, an injected tool-result /
  // system-note turn, or a FreeAgent command an assistant wrote. Works even
  // after a full cold start and regardless of scroll position.
  function domHasZsSignal() {
    for (const it of P.allItems()) {
      const txt = it.textContent || "";
      if (txt.includes(ZS.SYS_MARKER)) return true;
      if (/(^|\n)\s*Output of '[^']+':/.test(txt) || txt.includes("(System note:")) return true;
      // Deliberately NO bare command-shape test here. An assistant turn that
      // merely CONTAINS {"command":...} / ###CODE:run_python### is NOT proof of a session:
      // in a plain, never-started chat the model can simply EXPLAIN the format
      // (docs, examples, the user pasting our README) - that false positive
      // flipped A.started on, which armed the auto-resume watchdog, EXECUTED
      // the quoted JSON as a real command and injected its result into a chat
      // that had no agent at all (user-reported). A command only counts as a
      // session signal once it was actually RUN - and an executed command is
      // always followed by our injected "Output of '...'" feedback turn, which
      // the test above already catches. Virtualization (the marker turns
      // scrolling out of the DOM) is covered by the persisted per-conversation
      // key set (startedSessions / zsStartedSessions in rememberSession), not
      // by this heuristic.
    }
    return false;
  }
  function syncSessionState() {
    // While a bootstrap runs, track its conversation. The bootstrap chat gets a
    // real id only AFTER the prompt lands (fresh "/app" → "/app/<id>"), so we pin
    // the id the first time the chat has content. A change to a DIFFERENT, EMPTY
    // chat means the user opened a new conversation → abort: bump the generation
    // (the in-flight startSession bails at its next checkpoint) and clear state so
    // the new chat shows its own status instead of a stale "Starting…".
    if (A.starting) {
      const key = P.conversationKey();
      if (A.startingKey == null) {
        if (key && !P.chatIsEmpty()) A.startingKey = key; // pin the stable id
      } else if (key !== A.startingKey && P.chatIsEmpty()) {
        A.startGen++;
        A.starting = false;
        A.startingKey = null;
        P.setInputLock(false);
        ui.setStarting(false);
        // CRITICAL: startSession's own finally is gated on `alive()` (this abandon
        // just invalidated it via startGen++), so it will NEVER run and never
        // lift the "Agent is working…" cover. Without this line the cover was
        // stuck forever on the fresh chat whenever the user opened a new,
        // empty conversation WHILE the bootstrap's tool call (list_commands) was
        // still in flight - validated live 2026-07 on Cloudflare AI Playground.
        ui.inputCover(false);
      }
    }
    // Same idea for a RUNNING loop: if the user opens a NEW, empty conversation
    // via the SITE's own new-chat (not FreeAgent's button), the loop is bound to
    // a chat the user left, so abandon it. Otherwise A.running keeps this function
    // early-returning below and the stale "Agent active" / Stop button lingers on
    // the fresh chat instead of "Start local agent agent". The "/app" → "/app/<id>" id
    // assignment of the SAME chat is not a move (loopKey is pinned only once the
    // chat has both an id and content), so a normal session is never disturbed.
    if (A.running) {
      const key = P.conversationKey();
      if (A.loopKey == null) {
        if (key && !P.chatIsEmpty()) A.loopKey = key; // pin the loop's conversation
      } else if (key !== A.loopKey && P.chatIsEmpty()) {
        diag("loop.abandonedNewChat", { from: A.loopKey, to: key });
        A.stop = true;       // the loop breaks at its next checkpoint; its finally
        A.loopKey = null;    // resets A.running / cover / lock, then state recomputes
      }
    }
    if (A.starting || A.injecting || A.running) return;
    const path = P.conversationKey();
    const markerInDom = domHasZsSignal();
    if (markerInDom) rememberSession(path);
    let has;
    if (path && path === lastSyncPath) {
      // SAME, REAL conversation: never downgrade a known-started session just
      // because virtualization scrolled the marker out of the DOM. "started" is
      // sticky until the key actually changes (a different conversation).
      // NOTE: a falsy key ("" = a transient/fresh chat with no id yet) is NEVER
      // sticky - every fresh chat shares "", so a brief transient sweep during
      // navigation would otherwise PIN lastSyncPath="" with has=true and then keep
      // "Agent active" forever on the next empty chat (it would never recompute).
      has = A.started || markerInDom || (!!path && startedSessions.has(path));
    } else {
      // Different conversation → recompute from scratch.
      has = markerInDom || (!!path && startedSessions.has(path));
      lastSyncPath = path;
    }
    if (has !== A.started) {
      A.started = has;
      ui.setStarted(has);
    }
  }

  // Schedule a debounced sweep. requestAnimationFrame is PAUSED in a background
  // tab, so when hidden we fall back to a timer (throttled, but it runs).
  let sweepScheduled = false;
  function scheduleSweep() {
    if (sweepScheduled) return;
    sweepScheduled = true;
    const run = () => {
      sweepScheduled = false;
      syncSessionState();
      P.enforceComposer();  // keep the composer in the provider's required modes
      ui.updateStartGate(); // block the input until a session is started
      decorate.sweep();
    };
    if (document.hidden) setTimeout(run, 100);
    else requestAnimationFrame(run);
  }
  // Synchronous pre-hide: MutationObserver callbacks run as a microtask BEFORE
  // the browser paints, but the debounced sweep above waits one extra rAF -
  // long enough for a freshly-sent system-prompt/injected-feedback turn's raw
  // text to paint for a single frame before decorate.sweep() builds its chip
  // and hides it (seen live on DeepSeek: "Starting Up" flashed the raw prompt
  // for an instant). Do the cheap whole-item hide test right here, synchronously,
  // so the class lands before that first paint; the full sweep still runs after
  // to build the actual chip.
  function preHideWholeItems() {
    const items = P.allItems();
    // Optimistic pre-hide of a freshly injected result turn (armed in
    // submitAndGetBase). The text-based match below can only fire once the
    // "Output of '…'" caption has rendered, but the turn's NODE appears first
    // (with its attached image) and the caption fills a tick later - so the raw
    // output would flash until a post-send sweep nudge. We know the newest user
    // turn in this window is ours: hide it on sight (blank, no raw text), and let
    // the normal sweep swap in the real "· result" chip when the caption lands.
    if (A.injectHideUntil && Date.now() < A.injectHideUntil) {
      const users = items.filter((it) => P.isUserItem(it));
      const last = users[users.length - 1];
      if (last && !last.classList.contains("zs-hidden") &&
          users.length > (A.injectPreUser || 0)) {
        last.classList.add("zs-hidden");
        A.injectHideUntil = 0; // one-shot: this turn is now masked
        diag("result.prehide", { users: users.length });
      }
    }
    for (const item of items) {
      if (item.classList.contains("zs-hidden")) continue;
      const txt = P.classifyText(item, ".zs-chip");
      if (txt.includes(ZS.SYS_MARKER) ||
          (P.isUserItem(item) && ZSParse.isInjectedFeedback(txt))) {
        item.classList.add("zs-hidden");
      }
    }
  }
  const mo = new MutationObserver(() => {
    preHideWholeItems();
    scheduleSweep();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  // Belt-and-braces: a low-frequency sweep regardless of tab visibility or
  // mutation timing, so camouflage always converges.
  setInterval(scheduleSweep, 1500);
  // When the user returns to the tab, immediately refresh camouflage/state.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleSweep(); });

  syncSessionState();

  // User-send interception: the provider wires the site's composer events to
  // these callbacks.
  P.installSendHooks({
    isBlocked: () => A.injecting || A.running || A.starting,
    isStarted: () => A.started,
    onBlockedAttempt: () => ui.nudgeStart(),
    onUserMessage: (base) => {
      // A fresh user message = fresh intent: clear any previous manual stop so
      // the loop is allowed to run again.
      A.userStopped = false;
      bumpSys("users");
      captureSendToken(); // identity of the assistant turn before this reply
      // A Stop clicked during this 300ms window sets A.userStopped → honor it and
      // do NOT start the loop (otherwise the stop is silently ignored and the
      // freshly-started loop strands the "Stopping…" flag).
      setTimeout(() => { if (!A.running && !A.userStopped) agentLoop(base); }, 300);
    },
    onNativeStop: () => {
      // A click on the site's own stop = a deliberate manual stop → suppress
      // auto-resume.
      A.userStopped = true;
      A.stop = true;
      A.resumeArmed = false; // a stop overrides any pending regenerate grace
      A.stopAt = Date.now(); // grace anchor for the regenerate-as-resume gates
      // Same growth baseline as stopLoop: the stop-retry self-heal must only
      // re-click if the stream keeps writing past this point (see stop.retry).
      A.stopStreamLen = P.streamLen ? P.streamLen() : 0;
      // If our loop is live, mirror the same "Stopping…" feedback as our own
      // Stop button so the bar reflects the wind-down instead of flickering.
      if (A.running && !A.stopping) { A.stopping = true; ui.markStopping(); }
      markStoppedTurn();
      diag("nativeStop");
    },
    onNativeContinue: () => {
      // The site's "Continue" button = a clear intent to RESUME after a stop/
      // truncation. Clear the manual-stop latch so auto-resume can pick the
      // (resumed) turn's tool call back up cleanly.
      A.userStopped = false;
      A.stop = false;
      const it = P.lastAssistant();   // a real resume → drop the stopped marker
      if (it) { delete it.dataset.zStopped; forgetHalted(it); }
      diag("nativeContinue");
    },
  });

  // Auto-resume watchdog - the safety net that keeps the agentic loop alive when
  // a tool call finished AFTER the loop finalized early (huge multi_edit, tab
  // returning from background). It must NEVER fire on a tool call merely
  // PRESENT in the DOM without a fresh live generation. Guards:
  //   • A.userStopped - the user halted; never relaunch against their intent.
  //   • lastGenAt recency - only resume a turn from a generation in the last
  //     few seconds; a turn rendered by load/scroll has no recent generation.
  //   • turnHalted - the turn itself carries the site's "stopped" marker.
  // Each turn is still resumed at most once (zResume marker).
  // Freshness window for the resume watchdog. Widened from 8s to 3 minutes
  // (2026-08) because 8s was the ONLY thing standing between an orphaned command
  // and its execution, and it was firing on legitimate work: a long generation
  // (a Qwen reply seen live writing for 400s+) makes the loop finalize early, the
  // generation then genuinely ends, lastGenAt goes stale within 8s and the
  // completed command is stranded forever with a grey "not run" - the user's
  // whole point being that they wanted it to RUN. This is safe because every
  // guard below is independent of lastGenAt and covers the cases this window was
  // nominally protecting: bootBaselineId (a reload-restored generation),
  // maxTurnId (a scrolled-back old turn), the result-below settled-history test
  // (survives a reload, unlike the executed map), the `executed` map, the
  // zResume dedupe and A.userStopped. As the `executed` map's own comment puts
  // it, re-execution is idempotent regardless of any lastGenAt misfire - "the
  // hard part (is this a live turn?) can be wrong without harm". The window is
  // kept, rather than removed, so a tab left open for hours still never
  // spontaneously fires a command on some later unrelated DOM churn.
  const RESUME_FRESH_MS = 180000;
  setInterval(() => {
    if (!A.started || A.running || A.starting || A.injecting) return;
    if (document.hidden) return;                         // AI tab not foreground → don't parse/exec off-screen (agentLoop gates too)
    if (A.userStopped) return;                          // user halted → never relaunch
    if (P.isGenerating()) return;
    if (Date.now() - A.lastGenAt > RESUME_FRESH_MS) return; // not a fresh live turn
    const item = P.lastAssistant();
    if (!item || item.dataset.zloop) return;
    // Never resume the turn that already existed when this session started - it is
    // a reload-restored generation, not a reply to one of our sends (see
    // A.bootBaselineId). Guards the "execute_luau leaked into the new chat" bug.
    if (A.bootBaselineId && P.lastAssistantId && P.lastAssistantId() === A.bootBaselineId) return;
    if (P.turnHalted(item)) return;                     // this turn was stopped → leave it
    // Scrolled-back OLD turn guard (virtualization). lastAssistant() is the last
    // RENDERED turn; scrolling up makes it an old command whose id is below the
    // session's high-water mark. Its result row may be off-screen (unrendered), so
    // the result-below guard alone can miss it - this catches it directly. Only
    // applies when the provider exposes a numeric monotonic id (DeepSeek).
    const curId = P.itemKey ? Number(P.itemKey(item)) : NaN;
    if (Number.isFinite(curId) && A.maxTurnId != null && curId < A.maxTurnId) {
      // Log once per distinct turn, not every 1s tick while the user stays up.
      if (A._skipOldId !== curId) { A._skipOldId = curId; diag("resume.skipOld", { curId, maxTurnId: A.maxTurnId }); }
      return;
    }
    // Settled-history guard (survives a page reload, unlike the executed map).
    // A genuine resume target is a command whose tool NEVER produced a result;
    // it has NO injected-feedback turn after it. Every ALREADY-EXECUTED command
    // is followed by its injected result. On a virtualized list, scrolling up
    // makes lastAssistant() an OLD command turn AND flickers isGenerating() true
    // (sampleStream resets on the node change), refreshing lastGenAt - so the
    // freshness guard alone doesn't stop it, and after a reload the executed map
    // is empty. Keying off the result-below turn robustly separates the in-flight
    // command from settled history: a scrolled-back tool with its result already
    // present is never re-fired. (Confirmed live: same-conv reload + scroll up
    // re-executed a historical command.)
    const all = P.allItems();
    const after = all[all.indexOf(item) + 1];
    if (after && P.isUserItem(after) &&
        ZSParse.isInjectedFeedback(P.classifyText(after, ".zs-chip"))) return;
    const txt = P.itemText(item);
    if (!ZSParse.hasToolSignature(txt)) return;
    // Node-independent dedupe: this turn's command was already dispatched (by the
    // loop or a prior resume). The dataset guards below are wiped when the site
    // recreates the node on scroll, so without this off-DOM check the watchdog
    // re-runs a historical tool with no live generation. See the `executed` map.
    if (isRememberedExecuted(item, txt)) return;
    // Resume only when a COMPLETE, parseable command is present - and re-attempt
    // if the turn has GROWN since our last try.
    if (!ZSParse.parseToolCalls(txt).length) return;
    const len = txt.length;
    if (item.dataset.zResume && Number(item.dataset.zResumeLen || 0) >= len) return;
    item.dataset.zResume = "1";
    item.dataset.zResumeLen = String(len);
    rememberExecuted(item);
    diag("autoResume", { len });
    // The reply turn is ALREADY present - act on it immediately. Null token makes
    // the identity-based newReply test unconditionally true (any current id != null).
    A.sendToken = null;
    agentLoop(P.assistantCount() - 1);
  }, 1000);

  // ── System-prompt re-injection fallback ───────────────────────────────────
  // The piggyback path (withSysResend) is free but needs a tool result to ride
  // on, and the failure this feature exists for - the model forgetting it can
  // run commands at all - is precisely the state where no tool results are being
  // produced. So when a re-statement has been owed for a while and nothing has
  // carried it, send it as its own turn: masked exactly like the bootstrap (the
  // SYS_MARKER makes the camouflage sweep hide the whole item), so the user sees
  // nothing but ChatGPT's short acknowledgement.
  //
  // This costs one message from the site's quota, which is why it is a fallback
  // and not the primary path. Deliberately conservative about WHEN it may fire:
  // never mid-generation, never while the loop or bootstrap owns the composer,
  // and never while the user has text sitting in the composer (we would wipe
  // what they were typing).
  const SYS_FALLBACK_IDLE_MS = 20000;
  setInterval(async () => {
    if (!sysResendDue()) return;
    if (!A.started || A.running || A.starting || A.injecting) return;
    if (document.hidden || A.userStopped) return;
    if (P.isGenerating()) return;
    // The user is composing - their draft owns the editor, leave it alone.
    try { if ((P.editorText() || "").trim() !== "") return; } catch { return; }
    // Give the cheap path a fair chance first: only step in once the turn has
    // been settled and quiet for a while with no tool result to ride on.
    if (Date.now() - A.lastGenAt < SYS_FALLBACK_IDLE_MS) return;
    const spent = sinceLastSys();
    resetSysCount();
    A.sysResendAt = Date.now();
    diag("sys.resend", { via: "ownTurn", ...spent });
    try {
      const base = await submitAndGetBase(systemPrompt());
      await waitForResponse(base);
    } catch (e) {
      diag("sys.resendFailed", { err: String(e && e.message || e) });
    }
  }, 5000);

  log(`FreeAgent content script ready (provider: ${P.id})`);
})();
