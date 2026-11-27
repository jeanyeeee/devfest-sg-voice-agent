"""Booth station 3: superpowers, i.e. the ADK tools every friend can call by itself.

Built-in tools (Google Search, code execution) are wrapped as AgentTool sub-agents so
they can sit on the same agent as custom function tools. Each wrapped call is a
round trip to a second, non-live model, so expect a 2-5 second pause: the BASE
instruction makes the friend say out loud what it's doing to cover it.
"""
import os

from google.adk.agents import Agent
from google.adk.code_executors import BuiltInCodeExecutor
from google.adk.tools import google_search
from google.adk.tools.agent_tool import AgentTool

TOOL_MODEL = os.getenv("TOOL_MODEL", "gemini-2.5-flash")


def _search_agent() -> Agent:
    return Agent(
        name="know_it_all",
        model=TOOL_MODEL,
        description="Looks up fresh, real-world facts on Google Search (news, launches, prices, "
                    "people, events). Pass the question as the request.",
        instruction="Answer with fresh facts from Google Search, in one short spoken sentence.",
        tools=[google_search],
    )


def _math_agent() -> Agent:
    return Agent(
        name="math_whiz",
        model=TOOL_MODEL,
        description="Writes and runs real Python to calculate an exact answer (runway, ROI, "
                    "percentages, dates, unit conversions). Pass the problem as the request.",
        instruction="Write and run Python to calculate the answer. Return one short spoken sentence.",
        code_executor=BuiltInCodeExecutor(),
    )


def make_friend_card(friend_name: str, catchphrase: str, verdict: str) -> dict:
    """Creates a souvenir card summarising the chat for the booth screen. Call it once, as the chat wraps up.

    Args:
        friend_name: the visitor's name if they said it, otherwise a fun nickname based on the chat.
        catchphrase: the visitor's best line from the chat, in a few words.
        verdict: your one-line verdict on the chat, in character.
    """
    card = {"friend_name": friend_name, "catchphrase": catchphrase, "verdict": verdict}
    # The after-tool callback (policy.tool_result_log) pushes this result to the booth UI.
    return {"status": "card_created", "card": card}


def superpowers() -> dict:
    """Fresh tool instances for one call (every persona gets all of them)."""
    return {
        "know_it_all": AgentTool(agent=_search_agent()),
        "math_whiz": AgentTool(agent=_math_agent()),
        "friend_card": make_friend_card,
    }
