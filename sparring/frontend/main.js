// Build A Friend · booth flow: 1 pick a voice → 2 pick a persona → 3 the call screen.
// The call screen has three columns: live transcript · the phone (ring, pick up, timer) · tool calls.
// Voice plumbing: 16k mic PCM up, 24k voice down, client-side barge-in.
// The Problem Solving Coach (free play) swaps the tool rows for the pyramid gate (answer / because / so what).

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pad2 = (n) => String(n).padStart(2, "0");
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
                set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

// ---------- state ----------
let CARDS = { seconds: 120, voices: [], personas: [], links: {} };
const pick = { voice: null, persona: null };
let ws, audioCtx, workletNode, micStream;
let nextStart = 0, activeSources = [], speaking = false, thinking = 0;
// phase: pick → ringing → connecting → live → (wrap) → ended
let phase = "pick";
let clock = null, roundStart = 0, ended = false, overtime = false, hangTimer = null, idleTimer = null;
let friendCard = null;
const toolsUsed = new Set();
// Every function call of the call, in order, for the end-screen card: { tool, at, q, result, ms, status }.
const activity = [];
const pendingActs = {};   // tool name -> [activity entries waiting for their result]
const BARGE_RMS = 0.02;
const IDLE_RESET_S = 60;

const TOOL_UI = {
  know_it_all: { name: "Know-it-all", fn: "google_search", desc: "Looks up fresh facts on Google Search.", doing: "Looking it up…" },
  math_whiz: { name: "Math Whiz", fn: "python", desc: "Runs real Python, instantly.", doing: "Calculating…" },
  pitch_polisher: { name: "Pitch Polisher", fn: "flash-lite · structured", desc: "Gemini Flash-Lite sharpens your pitch into one line.", doing: "Polishing your pitch…" },
  agent_blueprint: { name: "Agent Blueprint", fn: "flash-lite · structured", desc: "Gemini Flash-Lite sketches your voice agent as a spec card.", doing: "Sketching your agent…" },
  make_friend_card: { name: "Friend Card", fn: "make_friend_card", desc: "Makes your souvenir card as the call wraps.", doing: "Making your card…" },
};
// Each persona brings its own superpowers (/cards and the round message carry the list).
const DEFAULT_TOOLS = ["know_it_all", "math_whiz", "make_friend_card"];
const toolOrder = () => (pick.persona?.superpowers?.length ? pick.persona.superpowers : DEFAULT_TOOLS).filter((t) => TOOL_UI[t]);

// ---------- screens ----------
const SCREENS = ["s-voice", "s-persona", "s-call"];
const STEP_OF = { "s-voice": "voice", "s-persona": "persona", "s-call": "call" };
function show(id) {
  SCREENS.forEach((s) => ($(s).hidden = s !== id));
  $("steps").hidden = id === "s-call";
  const order = ["voice", "persona", "call"], cur = order.indexOf(STEP_OF[id]);
  document.querySelectorAll("#steps .s").forEach((el) => {
    const i = order.indexOf(el.dataset.step);
    el.classList.toggle("on", i === cur); el.classList.toggle("done", i < cur);
  });
  if (id === "s-call" && phase === "ringing") startRing(); else stopRing();
  window.scrollTo(0, 0);
}

async function loadCards() {
  try { CARDS = await (await fetch("/cards")).json(); } catch { /* demo / offline: fall back below */ }
  if (!CARDS.voices?.length) CARDS = FALLBACK_CARDS;
  const links = CARDS.links || {};
  [["nav-arch", links.architecture], ["nav-slides", links.slides]].forEach(([id, url]) => {
    if (url) { $(id).href = url; $(id).hidden = false; }
  });

  $("voice-cards").innerHTML = "";
  CARDS.voices.forEach((v, i) => {
    const b = document.createElement("button");
    b.className = "pick"; b.type = "button";
    b.innerHTML = `<div class="num">${pad2(i + 1)}</div><div class="t">${esc(v.label)}</div><div class="d">${esc(v.vibe)}</div>`
      + `<div class="tag">voice_name="${esc(v.voice)}"</div><span class="go" aria-hidden="true">↗</span>`;
    const play = document.createElement("span");
    play.className = "play"; play.setAttribute("role", "button"); play.setAttribute("aria-label", `Hear ${v.label}`);
    play.textContent = "▶";
    play.addEventListener("click", (e) => { e.stopPropagation(); preview(v.id, play); });
    b.appendChild(play);
    b.addEventListener("click", () => { stopPreview(); pick.voice = v; show("s-persona"); });
    $("voice-cards").appendChild(b);
  });
  $("persona-cards").innerHTML = "";
  CARDS.personas.forEach((p, i) => {
    const b = document.createElement("button");
    b.className = "pick"; b.type = "button";
    b.innerHTML = `<div class="num">${pad2(i + 1)}${p.pyramid ? " · free play" : ""}</div><div class="emoji">${p.emoji}</div>`
      + `<div class="t">${esc(p.name)}</div><div class="d">${esc(p.tagline)}</div><span class="go" aria-hidden="true">↗</span>`;
    b.addEventListener("click", () => { pick.persona = p; openCall(); });
    $("persona-cards").appendChild(b);
  });
}
$("back-voice").addEventListener("click", () => show("s-voice"));
$("back-persona").addEventListener("click", () => { phase = "pick"; setStatus(); show("s-persona"); });
$("nav-voice").addEventListener("click", () => {
  if (phase === "connecting" || phase === "live" || phase === "wrap") return;   // never drop a live call
  if (phase === "ended") return reset();
  phase = "pick"; setStatus(); show("s-voice");
});

// ---------- voice previews ----------
let previewAudio = null;
function stopPreview() {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  document.querySelectorAll(".play.on").forEach((p) => { p.classList.remove("on"); p.textContent = "▶"; });
}
async function preview(id, btn) {
  const wasOn = btn.classList.contains("on");
  stopPreview(); if (wasOn) return;
  btn.classList.add("on"); btn.textContent = "■";
  const a = new Audio(`/voice-sample/${id}`);
  const sink = store.get("speaker");
  if (sink && a.setSinkId) { try { await a.setSinkId(sink); } catch {} }
  previewAudio = a;
  a.onended = a.onerror = () => { if (previewAudio === a) stopPreview(); };
  a.play().catch(() => stopPreview());
}

// ---------- the ring (through the handset speaker) ----------
let ringCtx = null, ringTimer = null;
async function startRing() {
  stopRing();
  try {
    ringCtx = new AudioContext();
    const sink = store.get("speaker");
    if (sink && ringCtx.setSinkId) { try { await ringCtx.setSinkId(sink); } catch {} }
  } catch { return; }
  const burst = () => {
    if (!ringCtx) return;
    const t = ringCtx.currentTime, g = ringCtx.createGain();
    g.gain.value = 0; g.connect(ringCtx.destination);
    [440, 480].forEach((f) => { const o = ringCtx.createOscillator(); o.frequency.value = f; o.connect(g); o.start(t); o.stop(t + 1.6); });
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.08, t + 0.05);
    g.gain.setValueAtTime(0.08, t + 1.5); g.gain.linearRampToValueAtTime(0, t + 1.6);
  };
  burst(); ringTimer = setInterval(burst, 3600);
}
function stopRing() {
  clearInterval(ringTimer); ringTimer = null;
  if (ringCtx) { ringCtx.close().catch(() => {}); ringCtx = null; }
}

// ---------- setup (?setup=1): choose the USB handset as mic + speaker ----------
async function setupDevices() {
  $("setup").hidden = false;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });   // unlocks device labels
    s.getTracks().forEach((t) => t.stop());
  } catch { $("setup-note").textContent = "Allow the microphone to list devices."; }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, key) => {
    sel.innerHTML = `<option value="">System default</option>`;
    devices.filter((d) => d.kind === kind).forEach((d) => {
      const o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || d.deviceId.slice(0, 10);
      if (store.get(key) === d.deviceId) o.selected = true; sel.appendChild(o);
    });
    sel.onchange = () => store.set(key, sel.value);
  };
  fill($("mic"), "audioinput", "mic");
  fill($("speaker"), "audiooutput", "speaker");
  if (!("setSinkId" in AudioContext.prototype)) $("setup-note").textContent = "This browser can't pick a speaker: set the handset as the system output instead.";
  $("test-ring").onclick = () => { startRing(); setTimeout(stopRing, 2000); };
}

// ---------- status: header, handset, line status, meter ----------
function setStatus() {
  const live = phase === "live" || phase === "wrap";
  const mode = ended ? "ended" : !live ? phase : thinking > 0 ? "thinking" : speaking ? "speaking" : ws ? "listening" : "dropped";
  const TEXT = {
    pick: ["", "Ready when you are", "The line is open"],
    ringing: ["ring", "Incoming call", "Ringing"],
    connecting: ["ring", "Connecting…", "Connecting…"],
    listening: ["live", overtime ? "Wrapping up" : "Live", "Listening"],
    speaking: ["live", overtime ? "Wrapping up" : "Live", `${pick.persona?.name || "Your friend"} is speaking`],
    thinking: ["live", "Live · using a superpower", "Using a superpower"],
    dropped: ["end", "Line dropped", "The line dropped"],
    ended: ["end", "Call ended", "Call ended"],
  }[mode];
  $("top-dot").className = "dot " + TEXT[0]; $("top-status").textContent = TEXT[1];
  $("line-dot").className = "dot " + TEXT[0]; $("line-text").textContent = TEXT[2];
  const h = $("handset");
  h.classList.toggle("ringing", phase === "ringing");
  h.classList.toggle("live", live && !ended);
  h.classList.toggle("speaking", live && !ended && speaking && thinking === 0);
  h.classList.toggle("thinking", live && !ended && thinking > 0);
  h.classList.toggle("ended", ended);
  $("meter").classList.toggle("speaking", live && !ended && speaking);
}
// The mic level drives the meter bars (throttled to one paint per frame).
let meterLevel = 0, meterQueued = false;
const METER_MULT = [0.6, 1, 1.4, 0.9, 0.5];
function setMeter(rms) {
  meterLevel = rms;
  if (meterQueued || speaking) return;
  meterQueued = true;
  requestAnimationFrame(() => {
    meterQueued = false;
    const bars = $("meter").children;
    for (let i = 0; i < bars.length; i++) bars[i].style.height = `${3 + Math.min(10, meterLevel * 160 * METER_MULT[i])}px`;
  });
}

// ---------- the call screen ----------
function openCall() {
  const p = pick.persona;
  phase = "ringing";
  $("eyebrow").textContent = `${p.name} is calling`;
  $("headline").textContent = "Ready to talk?"; $("headline").classList.remove("long");
  $("lede").innerHTML = `${esc(p.tagline)}<br>You have ${CARDS.seconds} seconds.${p.pyramid ? " Lead with the answer." : ""}`;
  $("prompt").innerHTML = "";
  $("clock").textContent = fmt(CARDS.seconds); $("clock").classList.remove("low");
  $("pickup").hidden = false; $("pickup").disabled = false;
  $("pickup").innerHTML = `<span aria-hidden="true">↗</span> Start call`;
  $("hangup").hidden = true; $("callout").hidden = false; $("back-persona").hidden = false;
  $("demo-link").hidden = params.get("demo") === "1";
  $("call-hint").textContent = `${pick.voice.label} voice. Headphones on. Interrupt any time.`;
  $("empty-big").innerHTML = p.pyramid ? "A little less background.<br>A little more to the point." : esc(p.tagline);
  renderRight();
  setStatus();
  show("s-call");
}

function enterCall() {
  phase = "live";
  const p = pick.persona;
  $("eyebrow").textContent = `On the line · ${pick.voice.label} voice`;
  $("headline").textContent = p.name;
  $("headline").classList.toggle("long", p.name.length > 18);
  $("lede").textContent = p.pyramid ? "Answer first. Then why. Then so what." : "Talk naturally. Your friend decides when to use a superpower.";
  $("pickup").hidden = true; $("callout").hidden = true; $("back-persona").hidden = true; $("demo-link").hidden = true;
  $("hangup").hidden = false; $("hangup").textContent = "Hang up"; $("hangup").onclick = () => endCall();
  $("call-hint").textContent = "Interrupt any time. Hang up when you're done.";
  if (p.pyramid) renderPyramid();
  setStatus();
}

// ---------- right column: superpower rows, or the coach's gate ----------
function renderRight() {
  const coach = pick.persona?.pyramid;
  $("right-title").textContent = coach ? "The concession gate" : "Superpowers";
  $("right-sub").innerHTML = coach ? "Warm in tone.<br>Firm on what counts." : "Your friend decides<br>when to use them.";
  $("activity-title").textContent = coach ? "Gate activity" : "Tool activity";
  $("right-foot").textContent = coach ? "Evidence before agreement" : "Real ADK tool calls";
  const items = coach
    ? ORDER.map((c) => ({ id: c, t: LABEL[c], d: TIER_DESC[c] }))
    : toolOrder().map((k) => ({ id: k, t: TOOL_UI[k].name, d: TOOL_UI[k].desc, fn: TOOL_UI[k].fn }));
  $("rows").innerHTML = items.map((it, i) => `<li class="row" id="row-${it.id}"><span class="n">${pad2(i + 1)}</span>`
    + `<div><div class="t">${esc(it.t)}</div><div class="d">${esc(it.d)}</div></div><span class="ring" aria-hidden="true"></span></li>`).join("");
  $("actionlog").innerHTML = coach
    ? `<div class="empty"><p>No verdicts yet.</p>When the agent accepts a point, the gate checks your actual words first.</div>`
    : `<div class="empty"><p>No tool calls yet.</p>When your friend decides to use a superpower, the ADK tool call shows up here, live.</div>`;
  updateCounts();
}
function updateCounts() {
  const coach = pick.persona?.pyramid;
  const total = coach ? ORDER.length : toolOrder().length;
  const n = coach ? ORDER.filter((c) => landed[c]).length : toolOrder().filter((t) => toolsUsed.has(t)).length;
  $("right-count").textContent = `${n} / ${total}`;
  $("activity-count").textContent = pad2($("actionlog").querySelectorAll(".act").length);
  $("turns").textContent = `${pad2($("transcript").querySelectorAll(".line").length)} turns`;
}

// ---------- transcript ----------
// The server streams each turn as fragments (finished=false) while someone is talking,
// then one finished=true message with the full text. Fragments go into a "live" segment;
// the finished text replaces it and settles it. Demo calls omit `finished` (= settled).
let lastRole = null, lastBody = null;
const liveSeg = { user: null, persona: null };
const elapsed = () => (roundStart ? fmt((Date.now() - roundStart) / 1000) : "0:00");
function addLine(role, text, finished = true) {
  if ($("convo-empty")) $("convo-empty").remove();
  let seg = liveSeg[role];
  if (!seg) {
    if (!text) return;   // an empty close with no live segment: nothing to settle
    if (role !== lastRole || !lastBody) {
      const line = document.createElement("div");
      line.className = "line " + role;
      line.innerHTML = `<b>${role === "persona" ? esc(pick.persona?.name || "Friend") : "You"}<i>${elapsed()}</i></b>`;
      lastBody = document.createElement("span");
      line.appendChild(lastBody);
      $("transcript").appendChild(line); lastRole = role;
      updateCounts();
    }
    seg = document.createElement("span");
    seg.className = "seg";
    if (lastBody.childNodes.length) lastBody.appendChild(document.createTextNode(" "));
    lastBody.appendChild(seg);
  }
  if (finished) {
    if (text) seg.textContent = text.trim();   // the finished transcript is authoritative
    seg.classList.remove("live"); liveSeg[role] = null;
  } else {
    seg.textContent += text;
    seg.classList.add("live"); liveSeg[role] = seg;
  }
  $("transcript").scrollTop = $("transcript").scrollHeight;
}
function settleLine(role) {   // e.g. the friend was interrupted: keep what was said so far
  if (liveSeg[role]) { liveSeg[role].classList.remove("live"); liveSeg[role] = null; }
}

// ---------- tool activity ----------
const pendingCards = {};   // tool name -> [result elements waiting]
function logEl() {
  const el = $("actionlog");
  if (el.querySelector(".empty")) el.innerHTML = "";
  return el;
}
function summarise(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (result.card) return `“${result.card.catchphrase}” · ${result.card.verdict}`;
  if (result.error) return `Couldn't calculate: ${result.error}`;
  if (result.expression && result.result != null) return `${result.expression} = ${result.result}`;
  if (result.result) return String(result.result);
  return JSON.stringify(result);
}
// The Flash-Lite sub-agents answer with structured output (a dict, or its JSON as a string).
function asObject(result) {
  if (result && typeof result === "object") return result;
  try { const o = JSON.parse(result); return o && typeof o === "object" ? o : null; } catch { return null; }
}
function structuredCard(tool, result) {
  const o = asObject(result);
  if (tool === "pitch_polisher" && o?.one_liner) {
    const tiers = [["Answer", o.answer], ["Because", o.because], ["So what", o.so_what]].filter(([, v]) => v);
    return `<div class="mini"><div class="mini-big">“${esc(o.one_liner)}”</div>`
      + tiers.map(([k, v]) => `<div class="mini-row"><span>${k}</span>${esc(v)}</div>`).join("") + `</div>`;
  }
  if (tool === "agent_blueprint" && o?.agent_name) {
    return `<div class="mini"><div class="mini-big">${esc(o.agent_name)}</div>`
      + [["Hears", o.hears], ["Does", o.does], ["Calls", o.tool], ["Verdict", o.verdict]]
          .filter(([, v]) => v).map(([k, v]) => `<div class="mini-row"><span>${k}</span>${esc(v)}</div>`).join("")
      + `</div>`;
  }
  return null;
}
// One short line per result for the end-screen card.
function activitySummary(tool, result, text) {
  const o = asObject(result);
  if (tool === "pitch_polisher" && o?.one_liner) return `“${o.one_liner}”`;
  if (tool === "agent_blueprint" && o?.agent_name) return `${o.agent_name} · ${o.verdict || ""}`;
  return text.length > 120 ? text.slice(0, 117) + "…" : text;
}
const took = (ms) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
function setToolRow(tool, state) {
  const row = $("row-" + tool);
  if (!row || pick.persona?.pyramid) return;
  row.classList.toggle("pending", state === "pending");
  if (state === "done") row.classList.add("done");
}
function addAction(m) {
  if (m.tool === "concede") return addConcede(m);
  const ui = TOOL_UI[m.tool] || { name: m.tool, fn: m.tool, doing: "Working…" };
  const a = m.args || {};
  if (m.phase === "call") {
    maybeBridge(m.tool);   // backup heads-up, only if the friend called it without saying anything
    thinking++; setStatus(); setToolRow(m.tool, "pending");
    const div = document.createElement("div");
    div.className = "act";
    const q = a.request || a.expression || (m.tool === "make_friend_card" ? `for ${a.friend_name || "you"}` : Object.values(a).join(" · "));
    div.innerHTML = `<div class="h"><strong>${esc(ui.name)}</strong><span class="fn">${esc(m.tool)}()</span><span class="at">+${elapsed()}</span></div>`
      + (q ? `<div class="q">“${esc(q)}”</div>` : "") + `<div class="r pending">${esc(ui.doing)}</div>`;
    logEl().appendChild(div);
    (pendingCards[m.tool] ||= []).push(div);
    const entry = { tool: m.tool, at: elapsed(), q, result: null, ms: null, status: "pending" };
    activity.push(entry); (pendingActs[m.tool] ||= []).push(entry);
  } else if (m.phase === "result") {
    thinking = Math.max(0, thinking - 1); setStatus();
    toolsUsed.add(m.tool); setToolRow(m.tool, "done");
    const div = (pendingCards[m.tool] || []).shift();
    let text = summarise(m.result);
    if (text.length > 220) text = text.slice(0, 217) + "…";
    const card = structuredCard(m.tool, m.result);
    const entry = (pendingActs[m.tool] || []).shift();
    if (entry) { entry.result = activitySummary(m.tool, m.result, text); entry.ms = m.ms; entry.status = "ok"; }
    if (div) {
      const r = div.querySelector(".r");
      r.classList.remove("pending");
      if (card) r.innerHTML = card; else r.textContent = text;
      if (m.ms != null) div.querySelector(".at").textContent += ` · ${took(m.ms)}`;
    }
    if (m.tool === "make_friend_card" && m.result?.card) gotFriendCard(m.result.card);
  }
  updateCounts();
  $("actionlog").scrollTop = $("actionlog").scrollHeight;
}

function gotFriendCard(card) {
  friendCard = card;
  if (overtime) scheduleHangup();
  else toast(`Friend Card made for ${card.friend_name}. You'll get it when the call ends.`);
}
function toast(text) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = text;
  document.body.appendChild(t); setTimeout(() => t.remove(), 4000);
}

// ---------- Problem Solving Coach: the pyramid gate ----------
const ORDER = ["answer", "because", "so_what"];
const LABEL = { answer: "Answer", because: "Because", so_what: "So what" };
const TIER_DESC = { answer: "Take a position. Say it first.", because: "Give a reason to believe it.", so_what: "Make the ask. Name the next step." };
const NEXT_PROMPT = {
  answer: "What's the answer, <b>in one sentence?</b>",
  because: "Good. Now <b>why should I believe it?</b>",
  so_what: "Great. <b>So what do you need, and by when?</b>",
  done: "<b>The whole pyramid landed.</b> That's how you open a meeting.",
};
const FIX = {
  "not first": "Your answer came after the build-up. Say the conclusion in your first sentence, then the background.",
  "no position": "You described the situation but didn't take a position. Start with 'We should…' or 'My recommendation is…'.",
  "too long": "Your answer ran past one sentence. Cut it to the decision alone.",
  "no reason": "You asserted it without a reason. Give one or two, ideally with a number.",
  "no ask": "You never said what you need. End with the ask and a date.",
  "grounded": "The coach tried to give you credit for something you didn't actually say.",
};
let open = [...ORDER];
const landed = {}, blocks = [];

function renderPyramid() {
  if (!pick.persona?.pyramid) return;
  const current = ORDER.find((c) => open.includes(c));
  ORDER.forEach((c) => {
    const row = $("row-" + c);
    if (!row) return;
    row.classList.toggle("done", !open.includes(c));
    row.classList.toggle("current", c === current);
    row.querySelector(".q")?.remove();
    if (landed[c]) {
      const q = document.createElement("div"); q.className = "q"; q.textContent = `“${landed[c].quote}”`;
      row.appendChild(q);
    }
  });
  if (!overtime) $("prompt").innerHTML = NEXT_PROMPT[current || "done"];
  updateCounts();
}
function addConcede(m) {
  const a = m.args || {};
  const div = document.createElement("div");
  div.className = "act " + (m.status === "blocked" ? "blocked" : "ok");
  div.innerHTML = `<div class="h"><strong>${esc(LABEL[a.concern_id] || a.concern_id)}</strong><span class="fn">concede()</span><span class="at">+${elapsed()}</span></div>`
    + `<div class="q">“${esc(a.quote)}”</div>`
    + `<div class="r v">${m.status === "blocked" ? "Blocked · " : "Landed · "}${esc(m.reason)}</div>`;
  logEl().appendChild(div);
  $("actionlog").scrollTop = $("actionlog").scrollHeight;
  activity.push({ tool: "concede", at: elapsed(), q: `${LABEL[a.concern_id] || a.concern_id}: “${a.quote || ""}”`,
                  result: `${m.status === "blocked" ? "Blocked" : "Landed"} · ${m.reason || ""}`, ms: null, status: m.status });
  if (m.status === "ok") landed[a.concern_id] = { quote: a.quote, at: (Date.now() - roundStart) / 1000 };
  else {
    blocks.push(m.reason || "");
    const row = $("row-" + a.concern_id);
    if (row) { row.classList.remove("shake"); void row.offsetWidth; row.classList.add("shake"); }
  }
  if (m.open) open = m.open;
  renderPyramid();
}

// ---------- clock + end of call ----------
const fmt = (s) => { const t = Math.max(0, Math.round(s)); return `${Math.floor(t / 60)}:${pad2(t % 60)}`; };
function startClock(seconds) {
  roundStart = Date.now();
  let left = seconds; $("clock").textContent = fmt(left);
  clock = setInterval(() => {
    left -= 1; $("clock").textContent = fmt(left);
    $("clock").classList.toggle("low", left <= 15);
    if (left <= 0 && !overtime) {
      overtime = true; phase = "wrap"; setStatus();
      $("headline").textContent = "That's time.";
      $("prompt").innerHTML = "<b>Time's up.</b> Your friend is saying goodbye…";
      if (friendCard) scheduleHangup();
    }
  }, 1000);
}
// Hang up once the friend has finished speaking (the server also hard-caps the call).
function scheduleHangup() {
  if (hangTimer) return;
  const started = Date.now();
  hangTimer = setInterval(() => {
    if ((!speaking && thinking === 0 && Date.now() - started > 1500) || Date.now() - started > 12000) endCall();
  }, 300);
}

function fixFor(reason) {
  const key = Object.keys(FIX).find((k) => reason.includes(k));
  return key ? FIX[key] : null;
}
function endCall() {
  if (ended) return; ended = true; phase = "ended";
  clearInterval(clock); clearInterval(hangTimer);
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  setTimeout(() => { try { ws && ws.close(); } catch {} }, 300);
  $("hangup").hidden = true;
  $("headline").textContent = "That's time.";
  $("prompt").innerHTML = "";
  setStatus();

  const onLine = fmt((Date.now() - roundStart) / 1000);
  $("fc-by").textContent = `${pick.persona.name} · ${pick.voice.label} voice · ${onLine} on the line`;
  if (friendCard) showFriendCard(friendCard, "tool");
  else {
    // Every call gets a card: the friend didn't make one, so Gemini Flash-Lite writes it from the transcript.
    showFriendCard({ friend_name: "Writing your card…", catchphrase: "", verdict: "" }, "pending");
    writeMissingCard().then((r) => showFriendCard(r.card, r.source));
  }
  $("card-tools").innerHTML = toolOrder().map((t, i) => `<span class="chip${toolsUsed.has(t) ? "" : " off"}">`
    + `<span class="mono">${pad2(i + 1)}</span>${esc(TOOL_UI[t].name)}</span>`).join("");
  renderActivity();

  if (pick.persona.pyramid) {
    $("pyramid-result").hidden = false;
    const n = ORDER.filter((c) => landed[c]).length;
    $("stat-tiers").textContent = `${n}/3`;
    $("stat-answer").textContent = landed.answer ? fmt(landed.answer.at) : "—";
    const best = landed.answer || ORDER.filter((c) => landed[c]).map((c) => landed[c]).pop();
    $("card-good").innerHTML = best ? `<span>Your strongest line</span>“${esc(best.quote)}”` : "";
    const counts = {};
    blocks.map(fixFor).filter(Boolean).forEach((f) => (counts[f] = (counts[f] || 0) + 1));
    let habit = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!habit && n < 3) habit = { answer: FIX["no position"], because: FIX["no reason"], so_what: FIX["no ask"] }[ORDER.find((c) => !landed[c])];
    $("card-fix").innerHTML = habit ? `<span>${n === 3 ? "One thing to sharpen" : "Try this next time"}</span>${esc(habit)}` : "";
  }
  $("card").classList.add("show");
  $("again").focus();
  // booth: back to the start if nobody taps
  let left = IDLE_RESET_S;
  $("idle").textContent = `resets in ${left}s`;
  idleTimer = setInterval(() => { left -= 1; $("idle").textContent = `resets in ${left}s`; if (left <= 0) reset(); }, 1000);
}
function showFriendCard(card, source) {
  $("fc-name").textContent = card.friend_name;
  $("fc-catch").textContent = card.catchphrase ? `“${card.catchphrase}”` : "";
  $("fc-verdict").textContent = card.verdict || "";
  $("friend-card").classList.toggle("pending", source === "pending");
  $("card-title").textContent = "Here's your Friend Card";
  $("card-sub").innerHTML = {
    tool: "Your friend called <code>make_friend_card()</code> by itself. That's an ADK tool doing something real.",
    "flash-lite": "Your friend ran out of time, so <code>gemini-2.5-flash-lite</code> wrote this card from your conversation, with structured output.",
    template: "Your friend ran out of time, so here's a card to remember the call.",
    pending: "Your friend ran out of time, so <code>gemini-2.5-flash-lite</code> is writing your card from the conversation…",
  }[source] || "";
}
function transcriptLines() {
  return [...document.querySelectorAll("#transcript .line")].map((l) => ({
    role: l.classList.contains("user") ? "user" : "persona",
    text: (l.querySelector("span")?.textContent || "").slice(0, 2000),
  })).filter((t) => t.text.trim()).slice(-200);
}
async function writeMissingCard() {
  const transcript = transcriptLines();
  const said = transcript.filter((t) => t.role === "user").pop()?.text || "Hello?";
  const template = { card: { friend_name: "Mystery Friend", catchphrase: said.split(/\s+/).slice(0, 12).join(" "),
                             verdict: "Thanks for calling. Come back anytime!" }, source: "template" };
  if (params.get("demo") === "1") return template;
  try {
    const res = await fetch("/friend-card", { method: "POST", headers: { "Content-Type": "application/json" },
                                              body: JSON.stringify({ persona: pick.persona.id, transcript }) });
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch { return template; }
}
function renderActivity() {
  $("card-activity-count").textContent = activity.length ? `${activity.length} call${activity.length > 1 ? "s" : ""}` : "";
  $("card-activity").innerHTML = activity.length
    ? activity.map((e) => `<li class="${e.status === "blocked" ? "blocked" : ""}"><span class="t">+${esc(e.at)}</span>`
        + `<div><code>${esc(e.tool)}()</code>${e.q ? ` <span class="q">${esc(e.q)}</span>` : ""}`
        + `<div class="r">${e.result == null ? "No result before the call ended." : esc(e.result)}`
        + `${e.ms != null ? ` <span class="ms">· ${esc(took(e.ms))}</span>` : ""}</div></div></li>`).join("")
    : `<li class="none">No function calls this time.</li>`;
}
function reset() { location.href = location.pathname + (params.get("setup") ? "?setup=1" : ""); }
$("again").addEventListener("click", reset);
$("close").addEventListener("click", () => {
  clearInterval(idleTimer);
  $("card").classList.remove("show");
  $("hangup").hidden = false; $("hangup").textContent = "Next visitor"; $("hangup").onclick = reset;
});

// ---------- voice playback (24k PCM) ----------
function playVoice(buf) {
  const int16 = new Int16Array(buf);
  const f32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 0x8000;
  const ab = audioCtx.createBuffer(1, f32.length, 24000);
  ab.getChannelData(0).set(f32);
  const src = audioCtx.createBufferSource();
  src.buffer = ab; src.connect(audioCtx.destination);
  lastFriendAudioAt = performance.now();
  queueSource(src, ab.duration);
}
// Every sound the friend makes goes through one queue, so barge-in (stopVoice) cuts all of it.
function queueSource(src, duration) {
  const now = audioCtx.currentTime;
  if (nextStart < now) nextStart = now;
  src.start(nextStart); nextStart += duration;
  activeSources.push(src);
  src.onended = () => { activeSources = activeSources.filter((s) => s !== src); if (!activeSources.length) { speaking = false; setStatus(); } };
  if (!speaking) { speaking = true; setStatus(); }
}

// ---------- backup heads-up lines ("Wait ah, let me Google that.") ----------
// The friend is told to narrate a search or sum before calling the tool. If it calls one silently,
// play a cached line in the same voice so the visitor isn't left in silence. They can talk over it.
const BRIDGE_TOOLS = new Set(["know_it_all", "math_whiz", "pitch_polisher", "agent_blueprint"]);
const NARRATED_WITHIN_MS = 1500;
let lastFriendAudioAt = 0;
const bridgeBufs = {};   // tool -> [{ buf, text }]
async function preloadBridges() {
  const lines = CARDS.bridges || {};
  for (const [tool, texts] of Object.entries(lines)) {
    texts.forEach(async (text, n) => {
      try {
        const res = await fetch(`/bridge/${pick.voice.id}/${tool}/${n}`);
        if (!res.ok) return;
        const buf = await audioCtx.decodeAudioData(await res.arrayBuffer());
        (bridgeBufs[tool] ||= []).push({ buf, text });
      } catch { /* no line this time: the friend's own narration still covers it */ }
    });
  }
}
function maybeBridge(tool) {
  if (!BRIDGE_TOOLS.has(tool) || !audioCtx || ended) return;
  const narrated = speaking || liveSeg.persona || performance.now() - lastFriendAudioAt < NARRATED_WITHIN_MS;
  const options = bridgeBufs[tool];
  if (narrated || !options?.length) return;
  const { buf, text } = options[Math.floor(Math.random() * options.length)];
  const src = audioCtx.createBufferSource();
  src.buffer = buf; src.connect(audioCtx.destination);
  queueSource(src, buf.duration);
  addLine("persona", text);
}
function stopVoice() {
  activeSources.forEach((s) => { try { s.stop(); } catch {} });
  activeSources = []; nextStart = 0; speaking = false; setStatus();
}

// ---------- the live socket ----------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ voice: pick.voice.id, persona: pick.persona.id });
  ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
  ws.binaryType = "arraybuffer";
  ws.onopen = setStatus;
  ws.onclose = () => {
    if (ended) return;
    if (overtime || friendCard) return endCall();
    clearInterval(clock); ws = null; setStatus();
    $("prompt").innerHTML = "The line dropped. <b>Hang up and try again.</b>";
  };
  ws.onmessage = (evt) => {
    if (typeof evt.data !== "string") { playVoice(evt.data); return; }
    const m = JSON.parse(evt.data);
    if (m.type === "round") {
      if (m.persona?.superpowers) { pick.persona = { ...pick.persona, superpowers: m.persona.superpowers }; renderRight(); }
      startClock(m.seconds); renderPyramid();
    }
    else if (m.type === "transcript") addLine(m.role, m.text, m.finished !== false);
    else if (m.type === "action") addAction(m);
    else if (m.type === "interrupted") { stopVoice(); settleLine("persona"); }
    else if (m.type === "wrap_up") { /* the server told the friend to wrap up */ }
    else if (m.type === "error") { $("prompt").textContent = "Error: " + m.message; console.error(m.message); }
  };
}

async function startMic() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const sink = store.get("speaker");
  if (sink && audioCtx.setSinkId) { try { await audioCtx.setSinkId(sink); } catch {} }
  await audioCtx.audioWorklet.addModule("/pcm-processor.js");
  const mic = store.get("mic");
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
             ...(mic ? { deviceId: { exact: mic } } : {}) },
  });
  const source = audioCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(audioCtx, "pcm-processor");
  workletNode.port.onmessage = (e) => {
    if (ws && ws.readyState === WebSocket.OPEN && !ended) ws.send(e.data.pcm);
    if (e.data.rms >= BARGE_RMS && speaking) stopVoice();
    if (!ended) setMeter(e.data.rms);
  };
  source.connect(workletNode);
  // keep the worklet pulled without sending the mic to the speaker
  const mute = audioCtx.createGain(); mute.gain.value = 0;
  workletNode.connect(mute); mute.connect(audioCtx.destination);
}

async function pickUp() {
  if (phase !== "ringing" || $("s-call").hidden) return;
  stopRing();
  phase = "connecting"; setStatus();
  $("pickup").disabled = true; $("pickup").textContent = "Connecting…";
  try { await startMic(); } catch (e) {
    phase = "ringing"; setStatus();
    $("pickup").disabled = false; $("pickup").innerHTML = `<span aria-hidden="true">↗</span> Start call`;
    $("prompt").innerHTML = "<b>Microphone blocked.</b> Allow it, then start the call again."; return;
  }
  enterCall();
  connect();
  preloadBridges();
}
$("pickup").addEventListener("click", pickUp);
$("callout").addEventListener("click", pickUp);
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && phase === "ringing" && !$("s-call").hidden) { e.preventDefault(); pickUp(); }
});

// ---------- boot ----------
const FALLBACK_CARDS = {
  seconds: 120,
  links: { architecture: "", slides: "" },
  bridges: {},
  voices: [
    { id: "chill_mentor", label: "Chill Mentor", voice: "Charon", vibe: "calm, deep, unhurried" },
    { id: "hype_friend", label: "Hype Friend", voice: "Puck", vibe: "upbeat, energetic" },
    { id: "sharp_exec", label: "Sharp Exec", voice: "Kore", vibe: "crisp, confident" },
  ],
  personas: [
    { id: "elevator_cto", name: "Elevator CTO", tagline: "Two minutes in a lift. Pitch yourself for your next role.", emoji: "🛗", pyramid: false,
      superpowers: ["know_it_all", "math_whiz", "pitch_polisher", "make_friend_card"] },
    { id: "curious_tech_friend", name: "Curious Tech Friend", tagline: "Just met at a meetup. What are you building?", emoji: "🧋", pyramid: false,
      superpowers: ["know_it_all", "pitch_polisher", "make_friend_card"] },
    { id: "voice_agent_know_it_all", name: "Voice Agent Know-it-all", tagline: "Tell it a problem. Should it be a voice agent?", emoji: "🎙️", pyramid: false,
      superpowers: ["know_it_all", "agent_blueprint", "make_friend_card"] },
    { id: "problem_solving_coach", name: "Problem Solving Coach", tagline: "Answer first, then why, then so what. Can you land the pyramid?", emoji: "🔺", pyramid: true,
      superpowers: ["know_it_all", "math_whiz", "pitch_polisher", "make_friend_card"] },
  ],
};

loadCards().then(() => {
  show("s-voice");
  if (params.get("setup") === "1") setupDevices();
  if (params.get("demo") === "1") runDemo();
});

// ---------- ?demo=1 : replay a scripted call without a mic or a model (UI preview / booth fallback) ----------
function runDemo() {
  pick.voice = CARDS.voices.find((v) => v.id === "hype_friend") || CARDS.voices[0];
  pick.persona = CARDS.personas.find((p) => p.id === "elevator_cto") || CARDS.personas[0];
  const say = (role, text) => () => addLine(role, text);
  const talk = (ms) => () => { speaking = true; setStatus(); setTimeout(() => { speaking = false; setStatus(); }, ms); };
  const steps = [
    [200, () => openCall()],
    [2600, () => { stopRing(); enterCall(); $("hangup").hidden = true; ws = true; setStatus(); startClock(CARDS.seconds); }],
    [500, talk(1800)], [100, say("persona", "Eh, morning! Doors closing, you got till the lobby. So what's your next role?")],
    [2200, say("user", "I want to lead developer relations for AI tools in Southeast Asia.")],
    [900, say("persona", "Okay lah. Wait ah, let me Google the hottest AI dev tool launches this month.")],
    [300, () => addAction({ tool: "know_it_all", phase: "call", args: { request: "Biggest AI developer tool launches this month" } })],
    [1400, () => addAction({ tool: "know_it_all", phase: "result", ms: 1380, result: "Voice agents built on Gemini Live and ADK are the big story this month." })],
    [400, talk(1500)], [100, say("persona", " Voice agents, can. So did you actually ship anything?")],
    [2200, say("user", "I launched a voice agent workshop that 400 developers took, and 60 percent shipped a demo.")],
    [1200, say("persona", "Wah, 60 percent ah? Let me calculate 60 percent of 400.")],
    [400, () => addAction({ tool: "math_whiz", phase: "call", args: { expression: "0.6 * 400" } })],
    [300, () => addAction({ tool: "math_whiz", phase: "result", ms: 3, result: { status: "ok", expression: "0.6 * 400", result: "240" } })],
    [500, talk(2000)], [100, say("persona", " 240 people shipped something. Shiok. Last one: what do you bring that nobody else does?")],
    [2400, say("user", "I've been a teacher, a PM and a builder, so I can explain it, scope it, and ship it.")],
    [1000, say("persona", "Okay, let me sharpen your pitch while you think about your ask.")],
    [300, () => addAction({ tool: "pitch_polisher", phase: "call", args: { request: "DevRel lead for AI tools in SEA; ran a voice agent workshop for 400 devs, 60% shipped; teacher, PM and builder." } })],
    [1200, () => addAction({ tool: "pitch_polisher", phase: "result", ms: 1150, result: {
      one_liner: "I turn developers into shippers: 240 of my 400 workshop devs shipped a voice agent.",
      answer: "I want to lead AI developer relations in Southeast Asia.",
      because: "60 percent of my 400 workshop developers shipped a demo.",
      so_what: "A coffee chat with your DevRel lead this week." } })],
    [400, talk(1800)], [100, say("persona", " Here's your pitch, sharper: you turn developers into shippers.")],
    [1600, say("persona", "Okay, I like that. Verdict: coffee chat with my Chief of Staff. Let me make your card.")],
    [400, () => addAction({ tool: "make_friend_card", phase: "call", args: { friend_name: "Alex" } })],
    [1500, () => { overtime = true; addAction({ tool: "make_friend_card", phase: "result", ms: 1,
      result: { status: "card_created", card: { friend_name: "Alex", catchphrase: "Explain it, scope it, ship it.", verdict: "Coffee chat with my Chief of Staff." } } }); }],
  ];
  let t = 0; steps.forEach(([d, f]) => { t += d; setTimeout(f, t); });
}
