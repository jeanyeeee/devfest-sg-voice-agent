"""Assembling the friend: one voice + one persona + all the superpowers.

  - voice       -> Gemini Live speech config (personas.VOICE_CARDS)
  - persona     -> agent instruction (personas.PERSONALITIES)
  - superpowers -> ADK tools, every persona gets all of them (superpowers.py)
  - Blitzen     -> also gets concede + the concession gate (stance.py, policy.py)

`build_friend(voice, persona)` is what the server calls once per phone call.
`make_agent(gated=False)` is Blitzen's prompt-only baseline for the cave test.
`root_agent` is what `adk web` loads (pick it with BOOTH_VOICE / BOOTH_PERSONA).
"""
import os
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from google.adk.agents import Agent
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.models import Gemini
from google.genai import types

from sparring.personas import (DEFAULT_PERSONA, DEFAULT_VOICE, PERSONA_CARDS, PERSONALITIES,
                               VOICE_CARDS)
from sparring.policy import concession_gate, tool_result_log
from sparring.stance import STANCE, instruction
from sparring.superpowers import superpowers
from sparring.tools import concede

LIVE_MODEL = os.getenv("LIVE_MODEL", "gemini-3.1-flash-live-preview")


def _speech(voice_name: str) -> types.SpeechConfig:
    return types.SpeechConfig(voice_config=types.VoiceConfig(
        prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice_name)))


def _model(voice_name: str) -> Gemini:
    return Gemini(model=LIVE_MODEL, speech_config=_speech(voice_name))


def run_config(voice: str) -> RunConfig:
    return RunConfig(
        streaming_mode=StreamingMode.BIDI,  # no effect on Gemini Live (always bidi); affects the runner only
        response_modalities=["AUDIO"],
        speech_config=_speech(VOICE_CARDS[voice].voice_name),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
    )


def build_friend(voice: str, personality: str) -> tuple[Agent, RunConfig]:
    if voice not in VOICE_CARDS:
        raise ValueError(f"unknown voice card {voice!r}")
    if personality not in PERSONALITIES:
        raise ValueError(f"unknown persona card {personality!r}")
    tools = list(superpowers().values())
    if PERSONA_CARDS[personality].pyramid:
        tools.append(concede)
    agent = Agent(
        name="booth_friend",
        model=_model(VOICE_CARDS[voice].voice_name),
        instruction=PERSONALITIES[personality],
        tools=tools,
        before_tool_callback=concession_gate,   # logs every call; gates concede
        after_tool_callback=tool_result_log,    # logs every result (the Friend Card arrives here)
    )
    return agent, run_config(voice)


def make_agent(gated: bool = True) -> Agent:
    """Blitzen alone, for the cave test: concede + gate (gated) vs the prompt-only baseline."""
    return Agent(
        model=_model(VOICE_CARDS[DEFAULT_VOICE].voice_name),
        name=STANCE.id if gated else f"{STANCE.id}_prompt_only",
        instruction=instruction(STANCE, gated=gated),
        tools=[concede] if gated else [],
        before_tool_callback=concession_gate if gated else None,
    )


root_agent, _ = build_friend(os.getenv("BOOTH_VOICE", DEFAULT_VOICE),
                             os.getenv("BOOTH_PERSONA", DEFAULT_PERSONA))
