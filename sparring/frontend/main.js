// Build A Friend · booth flow: 1 pick a voice → 2 pick a persona → 3 pick up the phone.
// Voice plumbing: 16k mic PCM up, 24k voice down, client-side barge-in.
// Every ADK tool call shows as a card; the Friend Card is the souvenir at the end.
// Blitzen (free play) also gets the pyramid (answer / because / so what) and its gate verdicts.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
                set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

// ---------- state ----------
let CARDS = { seconds: 90, voices: [], personas: [] };
const pick = { voice: null, persona: null };
let ws, audioCtx, workletNode, micStream;
let nextStart = 0, activeSources = [], speaking = false, thinking = 0;
let clock = null, roundStart = 0, ended = false, overtime = false, hangTimer = null;
let friendCard = null;
const toolsUsed = new Set();
const BARGE_RMS = 0.02;
const IDLE_RESET_MS = 60000;

const TOOL_UI = {
  know_it_all: { icon: "🔍", name: "Know-it-all", doing: "looking it up…" },
  math_whiz: { icon: "🧮", name: "Math Whiz", doing: "running the numbers…" },
  make_friend_card: { icon: "🪪", name: "Friend Card", doing: "making your card…" },
};

// ---------- screens ----------
const SCREENS = ["s-voice", "s-persona", "s-ring", "s-call"];
const STEP_OF = { "s-voice": "voice", "s-persona": "persona", "s-ring": "call", "s-call": "call" };
function show(id) {
  SCREENS.forEach((s) => ($(s).hidden = s !== id));
  const order = ["voice", "persona", "call"], cur = order.indexOf(STEP_OF[id]);
  document.querySelectorAll("#steps .s").forEach((el) => {
    const i = order.indexOf(el.dataset.step);
    el.classList.toggle("on", i === cur); el.classList.toggle("done", i < cur);
  });
  if (id === "s-ring") startRing(); else stopRing();
}

async function loadCards() {
  try { CARDS = await (await fetch("/cards")).json(); } catch { /* demo / offline: fall back below */ }
  if (!CARDS.voices?.length) CARDS = FALLBACK_CARDS;
  $("voice-cards").innerHTML = "";
  CARDS.voices.forEach((v) => {
    const b = document.createElement("button");
    b.className = "pick";
    b.innerHTML = `<div class="t">${esc(v.label)}</div><div class="d">${esc(v.vibe)}</div><div class="tag">voice_name="${esc(v.voice)}"</div>`;
    const play = document.createElement("span");
    play.className = "play button"; play.setAttribute("role", "button"); play.setAttribute("aria-label", `Hear ${v.label}`);
    play.textContent = "▶";
    play.addEventListener("click", (e) => { e.stopPropagation(); preview(v.id, play); });
    b.appendChild(play);
    b.addEventListener("click", () => { stopPreview(); pick.voice = v; show("s-persona"); });
    $("voice-cards").appendChild(b);
  });
  $("persona-cards").innerHTML = "";
  CARDS.personas.forEach((p) => {
    const b = document.createElement("button");
    b.className = "pick" + (p.pyramid ? " free" : "");
    b.innerHTML = `<div class="emoji">${p.emoji}</div><div class="t">${esc(p.name)}</div><div class="d">${esc(p.tagline)}</div>`;
    b.addEventListener("click", () => {
      pick.persona = p;
      $("caller-name").textContent = `${p.emoji} ${p.name}`;
      $("caller-sub").textContent = `is calling, in the ${pick.voice.label} voice`;
      show("s-ring");
    });
    $("persona-cards").appendChild(b);
  });
}
$("back-voice").addEventListener("click", () => show("s-voice"));
$("back-persona").addEventListener("click", () => show("s-persona"));

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

// ---------- transcript ----------
let lastRole = null, lastBody = null;
function addLine(role, text) {
  if ($("transcript").querySelector(".empty")) $("transcript").innerHTML = "";
  if (role !== lastRole || !lastBody) {
    const line = document.createElement("div");
    line.className = "line " + role;
    line.innerHTML = `<b>${role === "persona" ? esc(pick.persona?.name || "Friend") : "You"}</b>`;
    lastBody = document.createElement("span");
    line.appendChild(lastBody);
    $("transcript").appendChild(line); lastRole = role;
  }
  lastBody.textContent += text;
  $("transcript").scrollTop = $("transcript").scrollHeight;
}

// ---------- avatar status ----------
function setStatus() {
  const a = $("avatar");
  a.className = "avatar " + (ended ? "" : thinking > 0 ? "thinking" : speaking ? "speaking" : ws ? "listening" : "");
}

// ---------- superpower (tool) log ----------
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
  if (result.result) return String(result.result);
  return JSON.stringify(result);
}
function addAction(m) {
  if (m.tool === "concede") return addConcede(m);
  const ui = TOOL_UI[m.tool] || { icon: "🛠️", name: m.tool, doing: "working…" };
  const a = m.args || {};
  if (m.phase === "call") {
    toolsUsed.add(m.tool);
    thinking++; setStatus();
    const div = document.createElement("div");
    div.className = "act" + (m.tool === "make_friend_card" ? " card-act" : "");
    const q = a.request || (m.tool === "make_friend_card" ? `for ${a.friend_name || "you"}` : Object.values(a).join(" · "));
    div.innerHTML = `<div class="h">${ui.icon} ${esc(ui.name)}<span class="fn">${esc(m.tool)}()</span></div>`
      + (q ? `<div class="q">“${esc(q)}”</div>` : "") + `<div class="r pending">${esc(ui.doing)}</div>`;
    logEl().appendChild(div);
    (pendingCards[m.tool] ||= []).push(div.querySelector(".r"));
  } else if (m.phase === "result") {
    thinking = Math.max(0, thinking - 1); setStatus();
    const r = (pendingCards[m.tool] || []).shift();
    let text = summarise(m.result);
    if (text.length > 220) text = text.slice(0, 217) + "…";
    if (r) { r.classList.remove("pending"); r.textContent = text; }
    if (m.tool === "make_friend_card" && m.result?.card) gotFriendCard(m.result.card);
  }
  $("actionlog").scrollTop = $("actionlog").scrollHeight;
}

function gotFriendCard(card) {
  friendCard = card;
  if (overtime) scheduleHangup();
  else toast(`🪪 Friend Card made for ${card.friend_name}. You'll get it at the end of the call.`);
}
function toast(text) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = text;
  document.body.appendChild(t); setTimeout(() => t.remove(), 4000);
}

// ---------- Blitzen: the pyramid ----------
const ORDER = ["answer", "because", "so_what"];
const LABEL = { answer: "Answer", because: "Because", so_what: "So what" };
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
  "grounded": "Blitzen tried to give you credit for something you didn't actually say.",
};
let open = [...ORDER];
const landed = {}, blocks = [];

function renderPyramid() {
  if (!pick.persona?.pyramid) return;
  const current = ORDER.find((c) => open.includes(c));
  ORDER.forEach((c) => {
    const t = $("tier-" + c);
    t.classList.toggle("landed", !open.includes(c));
    t.classList.toggle("current", c === current);
  });
  $("prompt").innerHTML = NEXT_PROMPT[current || "done"];
  $("quotes").innerHTML = "";
  ORDER.filter((c) => landed[c]).forEach((c) => {
    const q = document.createElement("div");
    q.className = "quote"; q.innerHTML = `<span>${LABEL[c]}</span>`;
    q.appendChild(document.createTextNode(`“${landed[c].quote}”`));
    $("quotes").appendChild(q);
  });
}
function addConcede(m) {
  const a = m.args || {};
  const div = document.createElement("div");
  div.className = "act " + (m.status === "blocked" ? "blocked" : "ok");
  div.innerHTML = `<div class="h">🔺 The gate<span class="fn">concede()</span></div>`
    + `<div class="q">${esc(LABEL[a.concern_id] || a.concern_id)}: “${esc(a.quote)}”</div>`
    + `<div class="r v">${m.status === "blocked" ? "⛔ blocked · " : "✓ landed · "}${esc(m.reason)}</div>`;
  logEl().appendChild(div);
  $("actionlog").scrollTop = $("actionlog").scrollHeight;
  if (m.status === "ok") landed[a.concern_id] = { quote: a.quote, at: (Date.now() - roundStart) / 1000 };
  else {
    blocks.push(m.reason || "");
    const t = $("tier-" + a.concern_id);
    if (t) { t.classList.remove("shake"); void t.offsetWidth; t.classList.add("shake"); }
  }
  if (m.open) open = m.open;
  renderPyramid();
}

// ---------- clock + end of call ----------
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.round(s)) % 60).padStart(2, "0")}`;
function startClock(seconds) {
  roundStart = Date.now();
  let left = seconds; $("clock").textContent = fmt(left);
  clock = setInterval(() => {
    left -= 1; $("clock").textContent = fmt(Math.max(0, left));
    $("clock").classList.toggle("low", left <= 15);
    if (left <= 0 && !overtime) {
      overtime = true;
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
  if (ended) return; ended = true;
  clearInterval(clock); clearInterval(hangTimer);
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  setTimeout(() => { try { ws && ws.close(); } catch {} }, 300);
  setStatus(); $("hangup").hidden = true;

  const fc = $("friend-card");
  if (friendCard) {
    fc.hidden = false;
    $("fc-name").textContent = friendCard.friend_name;
    $("fc-catch").textContent = `“${friendCard.catchphrase}”`;
    $("fc-verdict").textContent = friendCard.verdict;
    $("fc-by").textContent = `${pick.persona.emoji} ${pick.persona.name} · ${pick.voice.label} voice`;
    $("card-title").textContent = "Here's your Friend Card";
    $("card-sub").textContent = "Your friend called make_friend_card() by itself. That's an ADK tool doing something real.";
  } else {
    fc.hidden = true;
    $("card-title").textContent = "Call ended";
    $("card-sub").textContent = "No Friend Card this time. Your friend never got to call make_friend_card().";
  }
  const used = [...toolsUsed].map((t) => `${TOOL_UI[t]?.icon || "🛠️"} ${TOOL_UI[t]?.name || t}`);
  $("card-tools").innerHTML = `<span>Superpowers used</span>${used.length ? esc(used.join(" · ")) : "none this call"}`;

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
  setTimeout(reset, IDLE_RESET_MS);   // booth: back to the start if nobody taps
}
function reset() { location.href = location.pathname + (params.get("setup") ? "?setup=1" : ""); }
$("again").addEventListener("click", reset);
$("close").addEventListener("click", () => { $("card").classList.remove("show"); $("hangup").hidden = false; $("hangup").textContent = "Next visitor"; $("hangup").onclick = reset; });
$("hangup").addEventListener("click", () => endCall());

// ---------- voice playback (24k PCM) ----------
function playVoice(buf) {
  const int16 = new Int16Array(buf);
  const f32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 0x8000;
  const ab = audioCtx.createBuffer(1, f32.length, 24000);
  ab.getChannelData(0).set(f32);
  const src = audioCtx.createBufferSource();
  src.buffer = ab; src.connect(audioCtx.destination);
  const now = audioCtx.currentTime;
  if (nextStart < now) nextStart = now;
  src.start(nextStart); nextStart += ab.duration;
  activeSources.push(src);
  src.onended = () => { activeSources = activeSources.filter((s) => s !== src); if (!activeSources.length) { speaking = false; setStatus(); } };
  speaking = true; setStatus();
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
    clearInterval(clock); $("prompt").innerHTML = "The line dropped. <b>Tap Hang up and try again.</b>"; ws = null; setStatus();
  };
  ws.onmessage = (evt) => {
    if (typeof evt.data !== "string") { playVoice(evt.data); return; }
    const m = JSON.parse(evt.data);
    if (m.type === "round") { startClock(m.seconds); renderPyramid(); }
    else if (m.type === "transcript") addLine(m.role, m.text);
    else if (m.type === "action") addAction(m);
    else if (m.type === "interrupted") stopVoice();
    else if (m.type === "wrap_up") { /* the server told the friend to wrap up */ }
    else if (m.type === "error") { $("prompt").textContent = "error: " + m.message; console.error(m.message); }
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
  };
  source.connect(workletNode);
  // keep the worklet pulled without sending the mic to the speaker
  const mute = audioCtx.createGain(); mute.gain.value = 0;
  workletNode.connect(mute); mute.connect(audioCtx.destination);
}

function enterCall() {
  show("s-call");
  const p = pick.persona;
  $("avatar").textContent = p.emoji;
  $("who-name").textContent = p.name;
  $("who-role").textContent = `${pick.voice.label} voice`;
  $("pyramid").hidden = $("quotes").hidden = !p.pyramid;
  $("prompt").innerHTML = p.pyramid ? "" : "Talk naturally. <b>Your friend decides when to use a superpower.</b>";
  $("hangup").hidden = false; $("foot-hint").textContent = "interrupt any time · hang up when you're done";
}

async function pickUp() {
  if (!pick.persona || $("s-ring").hidden) return;
  stopRing();
  $("pickup").disabled = true; $("pickup").textContent = "Connecting…";
  try { await startMic(); } catch (e) {
    $("pickup").disabled = false; $("pickup").textContent = "Pick up";
    $("caller-sub").textContent = "Microphone blocked. Allow it, then pick up again."; return;
  }
  enterCall();
  connect();
}
$("pickup").addEventListener("click", pickUp);
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !$("s-ring").hidden) { e.preventDefault(); pickUp(); }
});

// ---------- boot ----------
const FALLBACK_CARDS = {
  seconds: 90,
  voices: [
    { id: "chill_mentor", label: "Chill Mentor", voice: "Charon", vibe: "calm, deep, unhurried" },
    { id: "hype_friend", label: "Hype Friend", voice: "Puck", vibe: "upbeat, energetic" },
    { id: "sharp_exec", label: "Sharp Exec", voice: "Kore", vibe: "crisp, confident" },
  ],
  personas: [
    { id: "elevator_cto", name: "Elevator CTO", tagline: "90 seconds in a lift. Pitch yourself for your next role.", emoji: "🛗", pyramid: false },
    { id: "curious_tech_friend", name: "Curious Tech Friend", tagline: "Just met at a meetup. What are you building?", emoji: "🧋", pyramid: false },
    { id: "voice_agent_know_it_all", name: "Voice Agent Know-it-all", tagline: "Tell it a problem. Should it be a voice agent?", emoji: "🎙️", pyramid: false },
    { id: "blitzen", name: "Blitzen · Free play", tagline: "Answer first, then why, then so what. Can you land the pyramid?", emoji: "🔺", pyramid: true },
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
  const steps = [
    [300, () => { enterCall(); $("hangup").hidden = true; startClock(CARDS.seconds); }],
    [600, say("persona", "Eh, morning! Doors closing, you got till the lobby. So what's your next role?")],
    [2200, say("user", "I want to lead developer relations for AI tools in Southeast Asia.")],
    [1500, say("persona", "Okay lah, but did you actually ship anything?")],
    [2200, say("user", "I launched a voice agent workshop that 400 developers took, and 60 percent shipped a demo.")],
    [1200, say("persona", "Wah, 60 percent ah? Let me check what that is in people.")],
    [400, () => addAction({ tool: "math_whiz", phase: "call", args: { request: "What is 60% of 400?" } })],
    [2200, () => addAction({ tool: "math_whiz", phase: "result", result: "60% of 400 is 240 developers." })],
    [500, say("persona", " 240 people shipped something. Shiok. Last one: what do you bring that nobody else does?")],
    [2400, say("user", "I've been a teacher, a PM and a builder, so I can explain it, scope it, and ship it.")],
    [1200, say("persona", "Okay, I like that. Verdict: coffee chat with my Chief of Staff. Let me make your card.")],
    [400, () => addAction({ tool: "make_friend_card", phase: "call", args: { friend_name: "Alex" } })],
    [1500, () => { overtime = true; addAction({ tool: "make_friend_card", phase: "result",
      result: { status: "card_created", card: { friend_name: "Alex", catchphrase: "Explain it, scope it, ship it.", verdict: "Coffee chat with my Chief of Staff." } } }); }],
  ];
  let t = 0; steps.forEach(([d, f]) => { t += d; setTimeout(f, t); });
}
