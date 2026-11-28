"""Build A Friend booth backend: pick a voice, pick a persona, pick up the phone.

One WebSocket = one phone call. The browser opens /ws?voice=<card>&persona=<card>;
the server builds that friend (agent.build_friend), runs it on Gemini Live through
ADK's run_live, and streams back audio, transcripts and every tool call.

  - LiveRequestQueue up (16 kHz mic PCM), run_live down (24 kHz voice);
  - the user's transcribed words are recorded so the coach's gate (K2) can check
    that evidence is grounded in what they actually said;
  - every tool call and result goes to the browser via a per-call queue;
  - ~20 s before time, the friend is told to wrap up and make the Friend Card;
    the call is hard-capped at ROUND_SECONDS + GRACE_SECONDS.
"""
import asyncio
import hashlib
import io
import json
import logging
import os
import wave
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from google.adk.runners import Runner
from google.adk.agents import LiveRequestQueue
from google.adk.sessions import InMemorySessionService

from sparring.agent import build_friend
from sparring.config import APP_NAME
from sparring.personas import (BRIDGE_LINES, DEFAULT_PERSONA, DEFAULT_VOICE, PERSONA_CARDS, VOICE_CARDS,
                               WRAP_UP, opener)
from sparring.policy import forget_session, listen, record_user_words
from sparring.stance import STANCE, initial_state
from sparring.superpowers import write_friend_card

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(APP_NAME)

ROUND_SECONDS = int(os.getenv("ROUND_SECONDS", "120"))
WRAP_LEAD_SECONDS = int(os.getenv("WRAP_LEAD_SECONDS", "25"))
GRACE_SECONDS = int(os.getenv("GRACE_SECONDS", "20"))
TTS_MODEL = os.getenv("TTS_MODEL", "gemini-2.5-flash-preview-tts")
SAMPLE_CACHE = Path(__file__).resolve().parent / ".cache" / "voice_samples"
BRIDGE_CACHE = Path(__file__).resolve().parent / ".cache" / "bridges"
BRIDGE_WARM = os.getenv("BRIDGE_WARM", "1") == "1"   # make every backup line at startup

session_service = InMemorySessionService()

async def _warm_bridges():
    """Make every backup heads-up line once, in the background, so the first visitor never waits."""
    failures = 0
    for voice_id in VOICE_CARDS:
        for tool, lines in BRIDGE_LINES.items():
            for n in range(len(lines)):
                try:
                    await _bridge_wav(voice_id, tool, n)
                except Exception as e:
                    failures += 1
                    log.warning("bridge line %s/%s/%d failed: %r", voice_id, tool, n, e)
                    if failures >= 3:
                        log.warning("giving up on warming bridge lines; they'll be made on first use")
                        return
    log.info("bridge lines ready")


@asynccontextmanager
async def lifespan(_app):
    task = asyncio.create_task(_warm_bridges()) if BRIDGE_WARM else None
    yield
    if task:
        task.cancel()


app = FastAPI(title=APP_NAME, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
FRONTEND = Path(__file__).resolve().parent / "frontend"


# ---------- the cards, for the picker screens ----------

@app.get("/cards")
async def cards():
    return {
        "seconds": ROUND_SECONDS,
        "voices": [{"id": v.id, "label": v.label, "voice": v.voice_name, "vibe": v.vibe}
                   for v in VOICE_CARDS.values()],
        "personas": [{"id": p.id, "name": p.name, "tagline": p.tagline, "emoji": p.emoji,
                      "pyramid": p.pyramid, "superpowers": list(p.superpowers)}
                     for p in PERSONA_CARDS.values()],
        # header links; each is hidden in the UI while empty
        "links": {"architecture": os.getenv("ARCH_URL", ""), "slides": os.getenv("SLIDES_URL", "")},
        "bridges": {tool: list(lines) for tool, lines in BRIDGE_LINES.items()},
    }


async def _tts_wav(voice_id: str, text: str, path: Path) -> bytes:
    """Say `text` in a voice card's prebuilt voice with Gemini TTS, as a 24 kHz WAV, cached at `path`."""
    if path.exists():
        return path.read_bytes()
    v = VOICE_CARDS[voice_id]
    resp = await genai.Client().aio.models.generate_content(
        model=TTS_MODEL,
        contents=f"Say it in a {v.vibe} way, with a light Singaporean accent: {text}",
        config=types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=v.voice_name))),
        ),
    )
    pcm = resp.candidates[0].content.parts[0].inline_data.data
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(pcm)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buf.getvalue())
    return buf.getvalue()


def _bridge_path(voice_id: str, tool: str, n: int) -> Path:
    text = BRIDGE_LINES[tool][n]
    digest = hashlib.sha1(f"{VOICE_CARDS[voice_id].voice_name}|{text}".encode()).hexdigest()[:8]
    return BRIDGE_CACHE / f"{voice_id}-{tool}-{n}-{digest}.wav"   # new wording = new file


async def _bridge_wav(voice_id: str, tool: str, n: int) -> bytes:
    return await _tts_wav(voice_id, BRIDGE_LINES[tool][n], _bridge_path(voice_id, tool, n))


@app.get("/voice-sample/{voice_id}")
async def voice_sample(voice_id: str):
    """A short preview of each voice, made once with Gemini TTS (same prebuilt voices) and cached."""
    v = VOICE_CARDS.get(voice_id)
    if not v:
        raise HTTPException(404, "unknown voice")
    try:
        digest = hashlib.sha1(f"{v.voice_name}|{v.sample}".encode()).hexdigest()[:8]
        wav = await _tts_wav(voice_id, v.sample, SAMPLE_CACHE / f"{voice_id}-{digest}.wav")   # new wording = new file
    except Exception as e:
        log.warning("voice sample failed for %s: %r", voice_id, e)
        raise HTTPException(503, "voice sample unavailable")
    return Response(wav, media_type="audio/wav")


@app.get("/bridge/{voice_id}/{tool}/{n}")
async def bridge(voice_id: str, tool: str, n: int):
    """A backup heads-up line ("Wait ah, let me Google that.") in the friend's voice."""
    if voice_id not in VOICE_CARDS or tool not in BRIDGE_LINES or not 0 <= n < len(BRIDGE_LINES[tool]):
        raise HTTPException(404, "unknown bridge line")
    try:
        wav = await _bridge_wav(voice_id, tool, n)
    except Exception as e:
        log.warning("bridge line failed for %s/%s/%d: %r", voice_id, tool, n, e)
        raise HTTPException(503, "bridge line unavailable")
    return Response(wav, media_type="audio/wav", headers={"Cache-Control": "public, max-age=86400"})


# ---------- the guaranteed Friend Card ----------

class TranscriptLine(BaseModel):
    role: str = Field(max_length=16)
    text: str = Field(max_length=2000)


class CardRequest(BaseModel):
    persona: str
    transcript: list[TranscriptLine] = Field(default_factory=list, max_length=200)


@app.post("/friend-card")
async def friend_card(req: CardRequest):
    """The friend hung up without calling make_friend_card: Flash-Lite writes one from the transcript."""
    p = PERSONA_CARDS.get(req.persona)
    if not p:
        raise HTTPException(404, "unknown persona")
    card, source = await write_friend_card(p.name, [t.model_dump() for t in req.transcript])
    log.info("friend card written by %s for persona=%s", source, req.persona)
    return {"card": card, "source": source}


# ---------- live transcripts ----------

class TranscriptTracker:
    """Turns Gemini Live transcription events into browser messages, per role.

    With input/output transcription on in RunConfig, each turn streams as fragments
    (finished=False) while someone is talking, then closes with one finished=True
    event carrying the full text of the turn. The browser shows fragments live and
    swaps in the finished text when the turn ends.

    update() returns (message for the browser, text to record for the gate). The gate
    records fragments as they arrive; the finished text is recorded only when no
    fragments came, so nothing is counted twice.
    """

    def __init__(self):
        self.saw_fragment = {"user": False, "persona": False}

    def update(self, role: str, tr) -> tuple[dict | None, str | None]:
        if not tr:
            return None, None
        text = getattr(tr, "text", None) or ""
        finished = bool(getattr(tr, "finished", False))
        if not text and not (finished and self.saw_fragment[role]):
            return None, None    # nothing to show (an empty close with no live line is a no-op)
        msg = {"type": "transcript", "role": role, "text": text, "finished": finished}
        if finished:
            had = self.saw_fragment[role]
            self.saw_fragment[role] = False
            return msg, (None if had else text)
        self.saw_fragment[role] = True
        return msg, text


# ---------- one phone call ----------

@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    voice = websocket.query_params.get("voice", DEFAULT_VOICE)
    persona_id = websocket.query_params.get("persona", DEFAULT_PERSONA)
    if voice not in VOICE_CARDS or persona_id not in PERSONA_CARDS:
        await websocket.send_text(json.dumps({"type": "error", "message": "unknown voice or persona card"}))
        await websocket.close()
        return
    persona = PERSONA_CARDS[persona_id]

    agent, run_config = build_friend(voice, persona_id)
    runner = Runner(app_name=APP_NAME, agent=agent, session_service=session_service)
    state = initial_state(STANCE) if persona.pyramid else {"persona": persona_id}
    session = await session_service.create_session(app_name=APP_NAME, user_id="visitor", state=state)
    events = listen(session.id)
    log.info("call start: session=%s voice=%s persona=%s", session.id, voice, persona_id)
    live_request_queue = LiveRequestQueue()

    await websocket.send_text(json.dumps({
        "type": "round", "seconds": ROUND_SECONDS,
        "persona": {"id": persona.id, "name": persona.name, "emoji": persona.emoji, "pyramid": persona.pyramid,
                    "superpowers": list(persona.superpowers)},
        "voice": {"id": voice, "label": VOICE_CARDS[voice].label},
        "concerns": ([{"id": c.id, "label": c.label, "question": c.question} for c in STANCE.concerns]
                     if persona.pyramid else []),
    }))
    # The friend speaks first so the visitor isn't facing silence.
    live_request_queue.send_content(types.Content(role="user", parts=[types.Part.from_text(text=opener(persona_id))]))

    async def upstream():
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                return
            raw = msg.get("bytes")
            if raw:
                live_request_queue.send_realtime(types.Blob(data=raw, mime_type="audio/pcm;rate=16000"))

    tracker = TranscriptTracker()

    async def handle(event):
        msg, heard = tracker.update("user", getattr(event, "input_transcription", None))
        if heard:
            record_user_words(session.id, heard)            # K2 grounding: what the user really said
        if msg:
            await websocket.send_text(json.dumps(msg))
        msg, _ = tracker.update("persona", getattr(event, "output_transcription", None))
        if msg:
            await websocket.send_text(json.dumps(msg))
        content = getattr(event, "content", None)
        for part in (getattr(content, "parts", None) or []):
            idata = getattr(part, "inline_data", None)
            if idata and getattr(idata, "data", None):
                await websocket.send_bytes(idata.data)
        if getattr(event, "interrupted", None):
            await websocket.send_text(json.dumps({"type": "interrupted"}))

    async def downstream():
        async for event in runner.run_live(   # opens the Gemini Live connection
            user_id=session.user_id, session_id=session.id,
            live_request_queue=live_request_queue, run_config=run_config,
        ):
            await handle(event)

    async def tool_feed():
        # Tool calls + results -> the browser. For the coach, also track which tiers are still
        # open: on an allowed concede the tool updates state right after the callback.
        open_now = list(state.get("open_concerns", []))
        while True:
            v = await events.get()
            if v.get("tool") == "concede" and v.get("status") == "ok":
                open_now = [c for c in open_now if c != v["args"].get("concern_id")]
            await websocket.send_text(json.dumps({"type": "action", **v, "open": open_now}, default=str))

    async def clock():
        await asyncio.sleep(max(0, ROUND_SECONDS - WRAP_LEAD_SECONDS))
        live_request_queue.send_content(types.Content(role="user", parts=[types.Part.from_text(text=WRAP_UP)]))
        await websocket.send_text(json.dumps({"type": "wrap_up"}))
        await asyncio.sleep(WRAP_LEAD_SECONDS + GRACE_SECONDS)   # hard cap: hang up

    up = asyncio.create_task(upstream(), name="upstream")
    down = asyncio.create_task(downstream(), name="downstream")
    timer = asyncio.create_task(clock(), name="clock")
    feed = asyncio.create_task(tool_feed(), name="tool_feed")
    try:
        done, pending = await asyncio.wait({up, down, timer}, return_when=asyncio.FIRST_COMPLETED)
        live_request_queue.close()
        for t in done:
            exc = t.exception()
            if exc:
                log.exception("%s task FAILED: %r", t.get_name(), exc, exc_info=exc)
                try:
                    await websocket.send_text(json.dumps({"type": "error", "message": f"{type(exc).__name__}: {exc}"}))
                except Exception:
                    pass
        for t in pending:
            t.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    except WebSocketDisconnect:
        pass
    finally:
        feed.cancel()
        await asyncio.gather(feed, return_exceptions=True)
        live_request_queue.close()
        forget_session(session.id)
        try:
            await websocket.close()
        except Exception:
            pass
        log.info("call closed: session=%s", session.id)


if FRONTEND.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")
