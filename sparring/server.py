"""Built A Friend? backend: a live 90-second pyramid-principle round with Blitzen.

Same skeleton as live-dj's EP3 (LiveRequestQueue up, run_live down, the policy door feeding
the action log). What's new:
  - the session STARTS with state (K1): Blitzen's open concerns live there;
  - the user's transcribed words are recorded so the gate (K2) can check that
    evidence is grounded in what they actually said;
  - every verdict also carries the remaining open concerns, for the UI.
"""
import asyncio
import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from google.genai import types
from google.adk.runners import Runner, RunConfig
from google.adk.agents.run_config import StreamingMode
from google.adk.agents import LiveRequestQueue
from google.adk.sessions import InMemorySessionService

from sparring.agent import root_agent, VOICE
from sparring.config import APP_NAME
from sparring.policy import action_events, forget_session, record_user_words
from sparring.stance import STANCE, initial_state

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(APP_NAME)

ROUND_SECONDS = int(os.getenv("ROUND_SECONDS", "90"))

# Runner
session_service = InMemorySessionService()
runner = Runner(app_name=APP_NAME, agent=root_agent, session_service=session_service)

# RunConfig 
RUN_CONFIG = RunConfig(
    streaming_mode=StreamingMode.BIDI, #IMPT: This has no effect on Gemini Live, which is always bidi. It only affects the runner's behavior.
    response_modalities=["AUDIO"],
    speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(
        prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=VOICE))),
    input_audio_transcription=types.AudioTranscriptionConfig(),
    output_audio_transcription=types.AudioTranscriptionConfig(),
)

app = FastAPI(title=APP_NAME)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
FRONTEND = Path(__file__).resolve().parent / "frontend"


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    session = await session_service.create_session(
        app_name=APP_NAME, user_id="speaker", state=initial_state(STANCE))
    log.info("round start: session=%s voice=%s", session.id, VOICE)
    live_request_queue = LiveRequestQueue()

    await websocket.send_text(json.dumps({
        "type": "round", "seconds": ROUND_SECONDS, "persona": STANCE.name,
        "concerns": [{"id": c.id, "label": c.label, "question": c.question} for c in STANCE.concerns],
    }))
    # Blitzen opens with a warm hello so the user isn't facing silence.
    live_request_queue.send_content(types.Content(role="user", parts=[types.Part.from_text(
        text="(The session is starting soon, Greet me warmly in one short sentence and ask what's on my mind.)")]))

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

    async def downstream(): #async generator that yields events from the runner to the websocket
        async for event in runner.run_live( #IMPT: opens WebSocket to Gemini Live, sends events to the websocket
            user_id=session.user_id, session_id=session.id,
            live_request_queue=live_request_queue, run_config=RUN_CONFIG,
        ):
            await handle(event)

    async def policy_feed():
        # Gate verdicts -> the action log. On an allowed concede, the tool updates state
        # right after the callback, so compute what's still open from the verdict itself.
        open_now = list(initial_state(STANCE)["open_concerns"])
        while True:
            v = await action_events.get()
            if v.get("tool") == "concede" and v.get("status") == "ok":
                open_now = [c for c in open_now if c != v["args"].get("concern_id")]
            await websocket.send_text(json.dumps({"type": "action", **v, "open": open_now}))

    while not action_events.empty():
        action_events.get_nowait()

    up = asyncio.create_task(upstream(), name="upstream")
    down = asyncio.create_task(downstream(), name="downstream")
    feed = asyncio.create_task(policy_feed(), name="policy_feed")
    try:
        done, pending = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
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
        log.info("round closed: session=%s", session.id)


if FRONTEND.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")
