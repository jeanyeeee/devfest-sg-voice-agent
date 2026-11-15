// Built A Friend? · Blitzen — a 90-second pyramid-principle round.
// Voice plumbing from live-dj EP3 (16k mic up, 24k voice down, client barge-in);
// plus the pyramid (answer / because / so what), the gate log and an end-of-round card.

const $ = (id) => document.getElementById(id);
const dot = $("dot"), clockEl = $("clock"), promptEl = $("prompt");
const txEl = $("transcript"), actEl = $("actionlog"), quotesEl = $("quotes");

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

const BARGE_RMS = 0.02;
let ws, audioCtx, workletNode, micStream;
let nextStart = 0, activeSources = [], speaking = false;
let clock = null, roundStart = 0, ended = false;
let open = [...ORDER];
const landed = {};      // concern -> { quote, at }
const blocks = [];      // blocked reasons, in order

function setDot(s) { dot.className = "dot " + (s || ""); }

// ---------- transcript (fragments append to the current speaker's line) ----------
let lastRole = null, lastBody = null;
function addLine(role, text) {
  if (txEl.querySelector(".empty")) txEl.innerHTML = "";
  if (role !== lastRole || !lastBody) {
    const line = document.createElement("div");
    line.className = "line " + role;
    line.innerHTML = `<b>${role === "persona" ? "Blitzen" : "You"}</b>`;
    lastBody = document.createElement("span");
    line.appendChild(lastBody);
    txEl.appendChild(line); lastRole = role;
  }
  lastBody.textContent += text;
  txEl.scrollTop = txEl.scrollHeight;
}

// ---------- the pyramid ----------
function renderPyramid() {
  const current = ORDER.find((c) => open.includes(c));
  ORDER.forEach((c) => {
    const t = $("tier-" + c);
    t.classList.toggle("landed", !open.includes(c));
    t.classList.toggle("current", c === current);
  });
  promptEl.innerHTML = NEXT_PROMPT[current || "done"];
  quotesEl.innerHTML = "";
  ORDER.filter((c) => landed[c]).forEach((c) => {
    const q = document.createElement("div");
    q.className = "quote";
    q.innerHTML = `<span>${LABEL[c]}</span>`;
    q.appendChild(document.createTextNode(`“${landed[c].quote}”`));
    quotesEl.appendChild(q);
  });
  if (!current && !ended) setTimeout(endRound, 4000);   // let Blitzen say well done
}
function shake(c) {
  const t = $("tier-" + c); if (!t) return;
  t.classList.remove("shake"); void t.offsetWidth; t.classList.add("shake");
}

// ---------- the gate log ----------
function addAction(m) {
  if (actEl.querySelector(".empty")) actEl.innerHTML = "";
  const a = m.args || {};
  const div = document.createElement("div");
  div.className = "act" + (m.status === "blocked" ? " blocked" : "");
  div.textContent = `concede(${a.concern_id || ""}, “${a.quote || ""}”)`;
  const v = document.createElement("span");
  v.className = "v";
  v.textContent = m.status === "blocked" ? `⛔ blocked · ${m.reason || ""}` : `✓ landed · ${m.reason || ""}`;
  div.appendChild(v);
  actEl.appendChild(div); actEl.scrollTop = actEl.scrollHeight;

  if (m.status === "ok") {
    landed[a.concern_id] = { quote: a.quote, at: (Date.now() - roundStart) / 1000 };
  } else {
    blocks.push(m.reason || "");
    shake(a.concern_id);
  }
  if (m.open) open = m.open;
  renderPyramid();
}

// ---------- clock + end of round ----------
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.round(s)) % 60).padStart(2, "0")}`;
function startClock(seconds) {
  roundStart = Date.now();
  let left = seconds; clockEl.textContent = fmt(left);
  clock = setInterval(() => {
    left -= 1; clockEl.textContent = fmt(Math.max(0, left));
    clockEl.classList.toggle("low", left <= 15);
    if (left <= 0) endRound();
  }, 1000);
}
function fixFor(reason) {
  const key = Object.keys(FIX).find((k) => reason.includes(k));
  return key ? FIX[key] : null;
}
function endRound() {
  if (ended) return; ended = true;
  clearInterval(clock);
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  setTimeout(() => { if (ws) ws.close(); }, 1500);
  setDot(""); $("talk").textContent = "Round over"; $("talk").disabled = true;

  const n = ORDER.filter((c) => landed[c]).length;
  $("stat-tiers").textContent = `${n}/3`;
  $("stat-answer").textContent = landed.answer ? fmt(landed.answer.at) : "—";
  $("card-title").textContent = n === 3 ? "The whole pyramid landed" : n ? "Part of it landed" : "The point didn't land yet";
  $("card-sub").textContent = n === 3
    ? "Answer, reasons, ask. That's a meeting you'd want to be in."
    : "One habit to work on for round two:";

  const best = ORDER.filter((c) => landed[c]).pop();
  $("card-good").innerHTML = landed.answer
    ? `<span>Your strongest line</span>“${escapeHtml(landed.answer.quote)}”`
    : best ? `<span>Your strongest line</span>“${escapeHtml(landed[best].quote)}”` : "";

  // the habit = the most common blocked reason, or the first tier that never landed
  const counts = {};
  blocks.map(fixFor).filter(Boolean).forEach((f) => (counts[f] = (counts[f] || 0) + 1));
  let habit = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!habit && n < 3) {
    const miss = ORDER.find((c) => !landed[c]);
    habit = { answer: FIX["no position"], because: FIX["no reason"], so_what: FIX["no ask"] }[miss];
  }
  $("card-fix").innerHTML = habit ? `<span>${n === 3 ? "One thing to sharpen" : "Try this next round"}</span>${escapeHtml(habit)}` : "";
  $("card").classList.add("show");
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
$("again").addEventListener("click", () => location.reload());
$("close").addEventListener("click", () => $("card").classList.remove("show"));

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
  src.onended = () => { activeSources = activeSources.filter((s) => s !== src); if (!activeSources.length) { speaking = false; if (!ended) setDot("listening"); } };
  speaking = true; setDot("speaking");
}
function stopVoice() {
  activeSources.forEach((s) => { try { s.stop(); } catch {} });
  activeSources = []; nextStart = 0; speaking = false; if (!ended) setDot("listening");
}

// ---------- the live socket ----------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => setDot("listening");
  ws.onclose = () => { if (!ended) { clearInterval(clock); promptEl.innerHTML = "The line dropped. <b>Reload to try again.</b>"; setDot(""); } };
  ws.onmessage = (evt) => {
    if (typeof evt.data !== "string") { playVoice(evt.data); return; }
    const m = JSON.parse(evt.data);
    if (m.type === "round") { startClock(m.seconds); renderPyramid(); }
    else if (m.type === "transcript") addLine(m.role, m.text);
    else if (m.type === "action") addAction(m);
    else if (m.type === "interrupted") stopVoice();
    else if (m.type === "error") { promptEl.textContent = "error: " + m.message; console.error(m.message); }
  };
}

async function startMic() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.audioWorklet.addModule("/pcm-processor.js");
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const source = audioCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(audioCtx, "pcm-processor");
  workletNode.port.onmessage = (e) => {
    if (ws && ws.readyState === WebSocket.OPEN && !ended) ws.send(e.data.pcm);
    if (e.data.rms >= BARGE_RMS && speaking) stopVoice();
  };
  source.connect(workletNode);
  workletNode.connect(audioCtx.destination);
}

async function go() {
  $("talk").disabled = true; $("talk").textContent = "Connecting…";
  try { await startMic(); } catch (e) { promptEl.innerHTML = "Microphone blocked. <b>Allow it and reload.</b>"; return; }
  connect();
  $("talk").textContent = "● Live";
}
$("talk").addEventListener("click", go);

// ---------- ?demo=1 : replay a scripted round without a mic or a model (UI preview / booth fallback) ----------
if (new URLSearchParams(location.search).get("demo") === "1") {
  const steps = [
    [300, () => { setDot("listening"); startClock(90); renderPyramid(); }],
    [600, () => addLine("persona", "Hey, great to see you! What's on your mind today?")],
    [1800, () => addLine("user", "So, a bit of background first. Last quarter we looked at seller onboarding and there were a lot of different views across teams…")],
    [1500, () => addAction({ status: "blocked", reason: "no position taken (that's background, not an answer)", args: { concern_id: "answer", quote: "Last quarter we looked at seller onboarding" }, open: [...ORDER] })],
    [700, () => addLine("persona", "Love the context, but what's the answer, in one sentence?")],
    [1800, () => addLine("user", "We should cut onboarding from five steps to two by March.")],
    [1200, () => addAction({ status: "ok", reason: "answer first (at word 31)", args: { concern_id: "answer", quote: "We should cut onboarding from five steps to two by March." }, open: ["because", "so_what"] })],
    [600, () => addLine("persona", "That's clear! Why should I believe it?")],
    [1800, () => addLine("user", "42 percent of sellers drop off at step three, and the pilots that skipped it saw activation up 18 percent.")],
    [1200, () => addAction({ status: "ok", reason: "reason given", args: { concern_id: "because", quote: "42 percent of sellers drop off at step three" }, open: ["so_what"] })],
    [600, () => addLine("persona", "Nice, numbers. So what do you need from me?")],
    [1800, () => addLine("user", "I need you to approve two engineers for six weeks, starting next sprint.")],
    [1200, () => addAction({ status: "ok", reason: "clear ask", args: { concern_id: "so_what", quote: "approve two engineers for six weeks, starting next sprint" }, open: [] })],
    [600, () => addLine("persona", "That's a meeting I'd want to be in. Well done!")],
  ];
  $("talk").textContent = "Demo replay"; $("talk").disabled = true;
  let t = 0; steps.forEach(([d, f]) => { t += d; setTimeout(f, t); });
}
