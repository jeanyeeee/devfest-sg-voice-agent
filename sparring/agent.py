"""Blitzen as an ADK agent: a warm communication sparring partner who can't be flattered into agreeing.

  - K1 stance  -> instruction + session state (stance.py)
  - K2 gate    -> before_tool_callback=concession_gate (policy.py)

`root_agent` is what the server and `adk web` load. `make_agent(gated=False)` is
the prompt-only baseline the cave test compares against.
"""
import os
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from google.adk.agents import Agent
from google.adk.models import Gemini
from google.genai import types

from sparring.policy import concession_gate
from sparring.stance import STANCE, instruction
from sparring.tools import concede

VOICE = os.getenv("BLITZEN_VOICE", "Algenib")  


def make_agent(gated: bool = True) -> Agent:
    return Agent(
        model=Gemini(
            model=os.getenv("LIVE_MOagDEL", "gemini-3.1-flash-live-preview"),
            speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=VOICE))),
        ),
        name=STANCE.id if gated else f"{STANCE.id}_prompt_only",
        instruction=instruction(STANCE, gated=gated),
        tools=[concede] if gated else [],
        before_tool_callback=concession_gate if gated else None,
    )


root_agent = make_agent(gated=True)
