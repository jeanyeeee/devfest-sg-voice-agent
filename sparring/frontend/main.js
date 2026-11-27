// DevFest 2026 · Voice Agent booth: 01 pick a voice → 02 pick a friend → 03 pick up the phone.
// Voice plumbing: 16k mic PCM up, 24k voice down, client-side barge-in.
// Every ADK tool call shows in the right column; the Friend Card is the souvenir at the end.
// Blitzen (free play) swaps the right column for the concession gate (answer / because / so what).
// Live events are mirrored on a BroadcastChannel so architecture.html can show them.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
                set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
let bus = null; try { bus = new BroadcastChannel("devfest-voice"); } catch {}
const share = (m) => { try { bus && bus.postMessage(m); store.set("devfest-voice:last", JSON.stringify(m)); } catch {} };

const ICON = {
  go: '<svg class="go" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z"/></svg>',
  stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1"/></svg>',
  check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 5"/></svg>',
};

// ---------- copy per persona (the cards themselves come from /cards) ----------
const PERSONA_COPY = {
  elevator_cto: { lede: "Doors are closing. You have 90 seconds<br>to pitch yourself for your next role.",
                  quote: "Ninety seconds.<br>One lift. Make it count." },
  curious_tech_friend: { lede: "You just met at a meetup.<br>Tell them what you’re building.",
                         quote: "Fewer buzzwords.<br>More of what you’re building." },
  voice_agent_know_it_all: { lede: "Bring a problem from work or home.<br>Should it be a voice agent?",
                             quote: "Hands busy? Eyes busy?<br>Maybe it’s a voice agent." },
  blitzen: { lede: "Bring an update, a recommendation, an ask.<br>You have 90 seconds. Lead with the answer.",
             quote: "A little less background.<br>A little more to the point." },
};
const TOOL_UI = {
  know_it_all: { name: "Know-it-all", sub: "Looks up fresh facts.", doing: "Looking it up…" },
  math_whiz: { name: "Math Whiz", sub: "Runs real code.", doing: "Running the numbers…" },
  make_friend_card: { name: "Friend Card", sub: "Makes your souvenir.", doing: "Making your card…" },
};
const GATE = [
  { id: "answer", name: "Answer", sub: "Take a position. Say it first." },
  { id: "because", name: "Because", sub: "Give a reason to believe it." },
  { id: "so_what", name: "So what", sub: "Make the ask. Name the next step." },
];
const short = (p) => (p?.name || "Friend").replace(/ · Free play$/, "");

// ---------- state ----------
let CARDS = null;
const pick = { voice: null, persona: null };
let ws, audioCtx, workletNode, micStream;
let nextStart = 0, activeSources = [], speaking = false, thinking = 0;
let clock = null, roundStart = 0, live = false, ended = false, overtime = false, hangTimer = null;
let friendCard = null, turns = 0, actCount = 0;
const toolsUsed = new Set();
const BARGE_RMS = 0.02;
const IDLE_RESET_MS = 60000;
const pad = (n) => String(n).padStart(2, "0");

// ---------- screens + status ----------
function show(id) {
  ["s-voice", "s-persona", "s-phone"].forEach((s) => ($(s).hidden = s !== id));
  const step = { "s-voice": 0, "s-persona": 1, "s-phone": 2 }[id];
  document.querySelectorAll("#steps span").forEach((el, i) => {
    el.classList.toggle("is-on", i === step); el.classList.toggle("is-done", i < step);
  });
  if (id === "s-phone") { setStatus("ring"); startRing(); } else { setStatus("idle"); stopRing(); }
}
function setStatus(kind) {
  const cls = { ring: "is-ring", live: "is-live", talk: "is-talk", think: "is-think" }[kind];
  $("status-dot").className = "dot" + (cls ? " " + cls : "");
  $("line-dot").className = $("status-dot").className;
  $("status-text").textContent = { idle: "Ready when you are", ring: "Ringing", live: "On the call",
    talk: "Speaking", think: "Using a superpower", end: "Call ended" }[kind];
}
function refreshLive() {
  if (!live || ended) return;
  const kind = thinking > 0 ? "think" : speaking ? "talk" : "live";
  setStatus(kind);
  $("line-text").textContent = { think: "Using a superpower", talk: "Your friend is talking", live: "Listening" }[kind];
  $("bars").classList.toggle("is-on", speaking);
}

// ---------- the cards ----------
async function loadCards() {
  try { CARDS = await (await fetch("/cards")).json(); } catch {}
  if (!CARDS?.voices?.length) CARDS = FALLBACK_CARDS;
  $("clock").textContent = fmt(CARDS.seconds);

  $("voice-cards").innerHTML = "";
  CARDS.voices.forEach((v, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<button class="row" type="button"><span class="row__n">${pad(i + 1)}</span>
      <span class="row__t">${esc(v.label)}</span><span class="row__d">${esc(v.vibe)}</span>
      <span class="row__tag">voice_name="${esc(v.voice)}"</span>
      <span class="row__end"><span class="play" role="button" tabindex="0" aria-label="Hear ${esc(v.label)}">${ICON.play}</span>${ICON.go}</span></button>`;
    const play = li.querySelector(".play");
    const hear = (e) => { e.stopPropagation(); e.preventDefault(); preview(v.id, play); };
    play.addEventListener("click", hear);
    play.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") hear(e); });
    li.querySelector(".row").addEventListener("click", () => { stopPreview(); pick.voice = v; show("s-persona"); });
    $("voice-cards").appendChild(li);
  });

  $("persona-cards").innerHTML = "";
  CARDS.personas.forEach((p, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<button class="row" type="button"><span class="row__n">${pad(i + 1)}</span>
      <span class="row__t">${esc(short(p))}${p.pyramid ? '<span class="free-tag">free play</span>' : ""}</span>
      <span class="row__d">${esc(p.tagline)}</span><span class="row__end">${ICON.go}</span></button>`;
    li.querySelector(".row").addEventListener("click", () => choosePersona(p));
    $("persona-cards").appendChild(li);
  });
}
$("back-voice").addEventListener("click", () => show("s-voice"));
$("back-persona").addEventListener("click", () => show("s-persona"));

function choosePersona(p) {
  pick.persona = p;
  const copy = PERSONA_COPY[p.id] || { lede: esc(p.tagline), quote: "Pick up the phone.<br>Say hello." };
  $("phone-eyebrow").textContent = `${short(p)} · ${pick.voice.label} voice`;
  $("phone-title").textContent = "Ready to talk?";
  $("phone-lede").innerHTML = copy.lede;
  $("empty-line").innerHTML = copy.quote;
  $("phone").classList.add("is-ringing");
  setRightColumn(p);
  show("s-phone");
}

// ---------- right column: superpowers, or Blitzen's gate ----------
function setRightColumn(p) {
  const gate = !!p?.pyramid;
  $("right-title").textContent = gate ? "The concession gate" : "Superpowers";
  $("right-tagline").innerHTML = gate ? "Warm in tone.<br>Firm on what counts." : "Same three tools.<br>Your friend decides when.";
  $("activity-title").textContent = gate ? "Gate activity" : "Tool activity";
  $("activity-empty-1").textContent = gate ? "No verdicts yet." : "No tool calls yet.";
  $("activity-empty-2").textContent = gate ? "When the agent accepts a point, the gate checks your actual words first."
                                           : "When your friend uses a superpower, the ADK tool call shows up here.";
  $("right-foot-text").textContent = gate ? "Evidence before agreement" : "Tools it decides to use";
  const items = gate ? GATE : Object.entries(TOOL_UI).map(([id, t]) => ({ id, name: t.name, sub: t.sub }));
  $("right-rows").innerHTML = items.map((it, i) => `<li id="check-${it.id}"${gate && i === 0 ? ' class="is-current"' : ""}>
    <div class="row"><span class="row__n">${pad(i + 1)}</span><span class="row__t">${esc(it.name)}</span>
    <span class="row__d">${esc(it.sub)}</span><span class="row__end"><span class="check">${ICON.check}</span></span></div></li>`).join("");
  updateRightCount();
}
function updateRightCount() {
  const n = pick.persona?.pyramid ? GATE.filter((g) => landed[g.id]).length : toolsUsed.size;
  $("right-count").textContent = `${n} / 3`;
}

// ---------- voice previews ----------
let previewAudio = null;
function stopPreview() {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  document.querySelectorAll(".play.is-on").forEach((p) => { p.classList.remove("is-on"); p.innerHTML = ICON.play; });
}
async function preview(id, btn) {
  const wasOn = btn.classList.contains("is-on");
  stopPreview(); if (wasOn) return;
  btn.classList.add("is-on"); btn.innerHTML = ICON.stop;
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
  if (params.get("demo") === "1") return;
  try {
    ringCtx = new AudioContext();
    const sink = store.get("speaker");
    if (sink && ringCtx.setSinkId) { try { await ringCtx.setSinkId(sink); } catch {} }
  } catch { return; }
  const burst = () => {
    if (!ringCtx || ringCtx.state === "closed") return;
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
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); }
  catch { $("setup-note").textContent = "Allow the microphone to list devices."; }
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
  if (!("setSinkId" in AudioContext.prototype)) $("setup-note").textContent = "This browser can't pick a speaker: make the handset the system output.";
  $("test-ring").onclick = () => { startRing(); setTimeout(stopRing, 2000); };
}

// ---------- transcript ----------
let lastRole = null, lastBody = null;
function addLine(role, text) {
  const empty = $("convo-empty"); if (empty) empty.remove();
  if (role !== lastRole || !lastBody) {
    const line = document.createElement("div");
    line.className = "msg msg--" + role;
    line.innerHTML = `<span class="msg__who">${esc(role === "persona" ? short(pick.persona) : "You")}</span>`;
    lastBody = document.createElement("span");
    line.appendChild(lastBody);
    $("transcript").appendChild(line); lastRole = role;
    turns++; $("turns").textContent = `${pad(turns)} turns`;
  }
  lastBody.textContent += text;
  $("transcript").scrollTop = $("transcript").scrollHeight;
  share({ type: "transcript", role, text });
}

// ---------- activity log ----------
const pending = {};   // tool name -> result elements waiting
function logAct(html, cls = "") {
  ["activity-empty-1", "activity-empty-2"].forEach((id) => ($(id).hidden = true));
  const div = document.createElement("div");
  div.className = "act " + cls; div.innerHTML = html;
  $("actionlog").appendChild(div);
  actCount++; $("activity-count").textContent = pad(actCount);
  $("actionlog").scrollTop = $("actionlog").scrollHeight;
  return div;
}
function summarise(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (result.card) return `“${result.card.catchphrase}” · ${result.card.verdict}`;
  if (result.result) return String(result.result);
  return JSON.stringify(result);
}
function addAction(m) {
  share({ type: "action", ...m });
  if (m.tool === "concede") return addConcede(m);
  const ui = TOOL_UI[m.tool] || { name: m.tool, doing: "Working…" };
  const a = m.args || {};
  if (m.phase === "call") {
    thinking++; refreshLive();
    const q = a.request || (m.tool === "make_friend_card" ? `For ${a.friend_name || "you"}` : Object.values(a).join(" · "));
    const div = logAct(`<div class="act__h">${esc(ui.name)}<span class="act__fn">${esc(m.tool)}()</span></div>`
      + (q ? `<div class="act__q">“${esc(q)}”</div>` : "") + `<div class="act__r is-pending">${esc(ui.doing)}</div>`);
    (pending[m.tool] ||= []).push(div.querySelector(".act__r"));
  } else if (m.phase === "result") {
    thinking = Math.max(0, thinking - 1); refreshLive();
    toolsUsed.add(m.tool);
    const row = $("check-" + m.tool); if (row) row.classList.add("is-done");
    updateRightCount();
    const r = (pending[m.tool] || []).shift();
    let text = summarise(m.result);
    if (text.length > 220) text = text.slice(0, 217) + "…";
    if (r) { r.classList.remove("is-pending"); r.textContent = text; }
    if (m.tool === "make_friend_card" && m.result?.card) gotFriendCard(m.result.card);
  }
}
function gotFriendCard(card) {
  friendCard = card;
  if (overtime) scheduleHangup();
  else toast(`Friend Card made for ${card.friend_name}. You’ll get it when the call ends.`);
}
function toast(text) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = text;
  document.body.appendChild(t); setTimeout(() => t.remove(), 4000);
}

// ---------- Blitzen: the gate ----------
const FIX = {
  "not first": "Your answer came after the build-up. Say the conclusion in your first sentence, then the background.",
  "no position": "You described the situation but didn't take a position. Start with 'We should…' or 'My recommendation is…'.",
  "too long": "Your answer ran past one sentence. Cut it to the decision alone.",
  "no reason": "You asserted it without a reason. Give one or two, ideally with a number.",
  "no ask": "You never said what you need. End with the ask and a date.",
  "grounded": "Blitzen tried to give you credit for something you didn't actually say.",
};
const NEXT_PROMPT = {
  answer: "What’s the answer, in one sentence?",
  because: "Good. Now, why should I believe it?",
  so_what: "Great. So what do you need, and by when?",
  done: "The whole pyramid landed. That’s how you open a meeting.",
};
let open = GATE.map((g) => g.id);
const landed = {}, blocks = [];
function renderGate() {
  if (!pick.persona?.pyramid) return;
  const current = GATE.find((g) => open.includes(g.id))?.id;
  GATE.forEach((g) => {
    const li = $("check-" + g.id); if (!li) return;
    li.classList.toggle("is-done", !open.includes(g.id));
    li.classList.toggle("is-current", g.id === current);
  });
  if (live) $("phone-lede").textContent = NEXT_PROMPT[current || "done"];
  updateRightCount();
}
function addConcede(m) {
  const a = m.args || {};
  const label = GATE.find((g) => g.id === a.concern_id)?.name || a.concern_id;
  logAct(`<div class="act__h">${esc(label)}<span class="act__fn">concede()</span></div><div class="act__q">“${esc(a.quote)}”</div>`
    + `<div class="act__r">${m.status === "blocked" ? "Blocked · " : "Landed · "}${esc(m.reason)}</div>`,
    m.status === "blocked" ? "act--blocked" : "act--ok");
  if (m.status === "ok") landed[a.concern_id] = { quote: a.quote, at: (Date.now() - roundStart) / 1000 };
  else {
    blocks.push(m.reason || "");
    const li = $("check-" + a.concern_id);
    if (li) { li.classList.remove("is-shake"); void li.offsetWidth; li.classList.add("is-shake"); }
  }
  if (m.open) open = m.open;
  renderGate();
}

// ---------- clock + end of call ----------
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.round(s)) % 60).padStart(2, "0")}`;
function startClock(seconds) {
  roundStart = Date.now();
  let left = seconds; $("clock").textContent = fmt(left);
  clock = setInterval(() => {
    left -= 1; $("clock").textContent = fmt(Math.max(0, left));
    $("clock").classList.toggle("is-low", left <= 15);
    if (left <= 0 && !overtime) {
      overtime = true;
      $("phone-lede").textContent = "Time’s up. Your friend is saying goodbye…";
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
function fixFor(reason) { const k = Object.keys(FIX).find((x) => reason.includes(x)); return k ? FIX[k] : null; }

function endCall() {
  if (ended) return; ended = true; live = false;
  clearInterval(clock); clearInterval(hangTimer);
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  setTimeout(() => { try { ws && ws.close(); } catch {} }, 300);
  setStatus("end"); $("line-text").textContent = "Call ended"; $("bars").classList.remove("is-on");
  $("phone").classList.remove("is-live");
  $("pickup-text").textContent = "Next visitor"; $("pickup").classList.remove("btn--hang");
  share({ type: "end", card: friendCard });

  if (friendCard) {
    $("friend-card").hidden = false;
    $("fc-name").textContent = friendCard.friend_name;
    $("fc-catch").textContent = `“${friendCard.catchphrase}”`;
    $("fc-verdict").textContent = friendCard.verdict;
    $("fc-by").textContent = `${short(pick.persona)} · ${pick.voice.label} voice`;
    $("card-title").textContent = "Here’s your Friend Card.";
    $("card-sub").textContent = "Your friend called make_friend_card() by itself. That’s an ADK tool doing something real.";
  } else {
    $("friend-card").hidden = true;
    $("card-title").textContent = "Thanks for calling.";
    $("card-sub").textContent = "No Friend Card this time: the call ended before your friend called make_friend_card().";
  }
  const used = [...toolsUsed].map((t) => TOOL_UI[t]?.name || t);
  $("card-tools").innerHTML = `<span>Superpowers used</span>${used.length ? esc(used.join(" · ")) : "None this call"}`;

  if (pick.persona.pyramid) {
    $("pyramid-result").hidden = false;
    const n = GATE.filter((g) => landed[g.id]).length;
    $("stat-tiers").textContent = `${n}/3`;
    $("stat-answer").textContent = landed.answer ? fmt(landed.answer.at) : "—";
    const best = landed.answer || GATE.map((g) => landed[g.id]).filter(Boolean).pop();
    $("card-good").innerHTML = best ? `<span>Your strongest line</span>“${esc(best.quote)}”` : "";
    const counts = {};
    blocks.map(fixFor).filter(Boolean).forEach((f) => (counts[f] = (counts[f] || 0) + 1));
    let habit = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!habit && n < 3) habit = { answer: FIX["no position"], because: FIX["no reason"], so_what: FIX["no ask"] }[GATE.find((g) => !landed[g.id]).id];
    $("card-fix").innerHTML = habit ? `<span>${n === 3 ? "One thing to sharpen" : "One habit to work on"}</span>${esc(habit)}` : "";
  }
  $("card").classList.add("is-on");
  setTimeout(reset, IDLE_RESET_MS);   // booth: back to the start if nobody taps
}
function reset() { location.href = location.pathname + (params.get("setup") ? "?setup=1" : ""); }
$("again").addEventListener("click", reset);
$("close").addEventListener("click", () => $("card").classList.remove("is-on"));

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
  src.onended = () => { activeSources = activeSources.filter((s) => s !== src); if (!activeSources.length) { speaking = false; refreshLive(); } };
  speaking = true; refreshLive();
}
function stopVoice() {
  activeSources.forEach((s) => { try { s.stop(); } catch {} });
  activeSources = []; nextStart = 0; speaking = false; refreshLive();
}

// ---------- the live socket ----------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ voice: pick.voice.id, persona: pick.persona.id });
  ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
  ws.binaryType = "arraybuffer";
  ws.onopen = refreshLive;
  ws.onclose = () => {
    if (ended) return;
    if (overtime || friendCard) return endCall();
    clearInterval(clock); live = false;
    $("phone-lede").textContent = "The line dropped. Hang up and try again.";
    setStatus("end"); $("line-text").textContent = "Line dropped";
    $("pickup-text").textContent = "Start over"; $("pickup").classList.remove("btn--hang"); ended = true;
  };
  ws.onmessage = (evt) => {
    if (typeof evt.data !== "string") { playVoice(evt.data); return; }
    const m = JSON.parse(evt.data);
    if (m.type === "round") { startClock(m.seconds); renderGate(); share({ type: "start", persona: pick.persona, voice: pick.voice }); }
    else if (m.type === "transcript") addLine(m.role, m.text);
    else if (m.type === "action") addAction(m);
    else if (m.type === "interrupted") stopVoice();
    else if (m.type === "error") { $("phone-lede").textContent = "Something went wrong: " + m.message; console.error(m.message); }
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
  const mute = audioCtx.createGain(); mute.gain.value = 0;   // keep the worklet pulled, never play the mic back
  workletNode.connect(mute); mute.connect(audioCtx.destination);
}

function enterCall() {
  live = true; stopRing();
  $("phone").classList.remove("is-ringing"); $("phone").classList.add("is-live");
  $("phone-title").textContent = "On the line.";
  $("phone-lede").textContent = pick.persona.pyramid ? NEXT_PROMPT.answer : "Talk naturally. Your friend decides when to use a superpower.";
  $("pickup-text").textContent = "Hang up"; $("pickup").classList.add("btn--hang"); $("pickup").disabled = false;
  $("hint").textContent = "Interrupt any time, just like a real call.";
  $("back-persona").hidden = true; $("demo-link").hidden = true;
  refreshLive();
}

async function pickUp() {
  if (ended) return reset();
  if (live) return endCall();
  if (!pick.persona || $("s-phone").hidden) return;
  stopRing();
  $("pickup").disabled = true; $("pickup-text").textContent = "Connecting…";
  try { await startMic(); } catch {
    $("pickup").disabled = false; $("pickup-text").textContent = "Pick up";
    $("phone-lede").textContent = "The microphone is blocked. Allow it, then pick up again."; return;
  }
  enterCall();
  connect();
}
$("pickup").addEventListener("click", pickUp);
$("phone-tag").addEventListener("click", pickUp);
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !$("s-phone").hidden && !live && !ended && e.target === document.body) { e.preventDefault(); pickUp(); }
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
    { id: "elevator_cto", name: "Elevator CTO", tagline: "90 seconds in a lift. Pitch yourself for your next role.", pyramid: false },
    { id: "curious_tech_friend", name: "Curious Tech Friend", tagline: "Just met at a meetup. What are you building?", pyramid: false },
    { id: "voice_agent_know_it_all", name: "Voice Agent Know-it-all", tagline: "Tell it a problem. Should it be a voice agent?", pyramid: false },
    { id: "blitzen", name: "Blitzen · Free play", tagline: "Answer first, then why, then so what. Can you land the pyramid?", pyramid: true },
  ],
};

loadCards().then(() => {
  setRightColumn(null);
  show("s-voice");
  if (params.get("setup") === "1") setupDevices();
  if (params.get("demo") === "1") runDemo();
});

// ---------- ?demo=1 : replay a scripted call without a mic or a model (UI preview / booth fallback) ----------
function runDemo() {
  $("demo-link").hidden = true;
  pick.voice = CARDS.voices.find((v) => v.id === "hype_friend") || CARDS.voices[0];
  const persona = CARDS.personas.find((p) => p.id === "elevator_cto") || CARDS.personas[0];
  const say = (role, text) => () => addLine(role, text);
  const steps = [
    [900, () => choosePersona(persona)],
    [1600, () => { enterCall(); startClock(CARDS.seconds); share({ type: "start", persona: pick.persona, voice: pick.voice }); }],
    [700, say("persona", "Eh, morning! Doors closing, you got till the lobby. So what’s your next role?")],
    [2200, say("user", "I want to lead developer relations for AI tools in Southeast Asia.")],
    [1500, say("persona", "Okay lah, but did you actually ship anything?")],
    [2200, say("user", "I ran a voice agent workshop that 400 developers took, and 60 percent shipped a demo.")],
    [1200, say("persona", "Wah, 60 percent ah? Let me check what that is in people.")],
    [400, () => addAction({ tool: "math_whiz", phase: "call", args: { request: "What is 60% of 400?" } })],
    [2200, () => addAction({ tool: "math_whiz", phase: "result", result: "60% of 400 is 240 developers." })],
    [500, say("persona", " 240 people shipped something. Shiok. Last one: what do you bring that nobody else does?")],
    [2400, say("user", "I’ve been a teacher, a PM and a builder, so I can explain it, scope it, and ship it.")],
    [1200, say("persona", "Okay, I like that. Verdict: coffee chat with my Chief of Staff. Let me make your card.")],
    [400, () => addAction({ tool: "make_friend_card", phase: "call", args: { friend_name: "Alex" } })],
    [1500, () => { overtime = true; addAction({ tool: "make_friend_card", phase: "result",
      result: { status: "card_created", card: { friend_name: "Alex", catchphrase: "Explain it, scope it, ship it.", verdict: "Coffee chat with my Chief of Staff." } } }); }],
  ];
  let t = 0; steps.forEach(([d, f]) => { t += d; setTimeout(f, t); });
}
