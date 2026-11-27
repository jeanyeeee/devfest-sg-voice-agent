"""Build A Friend booth backend: pick a voice, pick a persona, pick up the phone.

One WebSocket = one phone call. The browser opens /ws?voice=<card>&persona=<card>;
the server builds that friend (agent.build_friend), runs it on Gemini Live through
ADK's run_live, and streams back audio, transcripts and every tool call.

  - LiveRequestQueue up (16 kHz mic PCM), run_live down (24 kHz voice);
  - the user's transcribed words are recorded so Blitzen's gate (K2) can check
    that evidence is grounded in what they actually said;
  - every tool call and result goes to the browser via a per-call queue;
  - ~20 s before time, the friend is told to wrap up and make the Friend Card;
    the call is hard-capped at ROUND_SECONDS + GRACE_SECONDS.
"""
import asyncio
import io
import json
import logging
import os
import wave
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
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
from sparring.personas import (DEFAULT_PERSONA, DEFAULT_VOICE, PERSONA_CARDS, VOICE_CARDS, WRAP_UP,
                               opener)
from sparring.policy import forget_session, listen, record_user_words
from sparring.stance import STANCE, initial_state

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(APP_NAME)

ROUND_SECONDS = int(os.getenv("ROUND_SECONDS", "90"))
WRAP_LEAD_SECONDS = int(os.getenv("WRAP_LEAD_SECONDS", "20"))
GRACE_SECONDS = int(os.getenv("GRACE_SECONDS", "20"))
TTS_MODEL = os.getenv("TTS_MODEL", "gemini-2.5-flash-preview-tts")
SAMPLE_CACHE = Path(__file__).resolve().parent / ".cache" / "voice_samples"

session_service = InMemorySessionService()

app = FastAPI(title=APP_NAME)
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
                      "pyramid": p.pyramid} for p in PERSONA_CARDS.values()],
    }


@app.get("/voice-sample/{voice_id}")
async def voice_sample(voice_id: str):
    """A short preview of each voice, made once with Gemini TTS (same prebuilt voices) and cached."""
    v = VOICE_CARDS.get(voice_id)
    if not v:
        raise HTTPException(404, "unknown voice")
    path = SAMPLE_CACHE / f"{voice_id}.wav"
    if not path.exists():
        try:
            resp = await genai.Client().aio.models.generate_content(
                model=TTS_MODEL,
                contents=f"Say it in a {v.vibe} way, with a light Singaporean accent: {v.sample}",
                config=types.GenerateContentConfig(
                    response_modalities=["AUDIO"],
                    speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=v.voice_name))),
                ),
            )
            pcm = resp.candidates[0].content.parts[0].inline_data.data
        except Exception as e:
            log.warning("voice sample failed for %s: %r", voice_id, e)
            raise HTTPException(503, "voice sample unavailable")
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(pcm)
        SAMPLE_CACHE.mkdir(parents=True, exist_ok=True)
        path.write_bytes(buf.getvalue())
    return Response(path.read_bytes(), media_type="audio/wav")


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
        "persona": {"id": persona.id, "name": persona.name, "emoji": persona.emoji, "pyramid": persona.pyramid},
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

    # Transcripts may stream as fragments and then repeat in full with finished=True.
    # Use the fragments; fall back to the finished text only if no fragments came.
    saw_fragment = {"user": False, "persona": False}

    def take(role, tr):
        text = getattr(tr, "text", None) if tr else None
        if not text:
            return None
        if getattr(tr, "finished", False):
            had = saw_fragment[role]
            saw_fragment[role] = False
            return None if had else text
        saw_fragment[role] = True
        return text

    async def handle(event):
        if (text := take("user", getattr(event, "input_transcription", None))):
            record_user_words(session.id, text)             # K2 grounding: what the user really said
            await websocket.send_text(json.dumps({"type": "transcript", "role": "user", "text": text}))
        if (text := take("persona", getattr(event, "output_transcription", None))):
            await websocket.send_text(json.dumps({"type": "transcript", "role": "persona", "text": text}))
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
        # Tool calls + results -> the browser. For Blitzen, also track which tiers are still
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
