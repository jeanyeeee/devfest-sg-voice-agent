"""Booth station 3: superpowers, i.e. the ADK tools a friend can call by itself.

Each persona picks its own combination from CATALOG (personas.Persona.superpowers).

  Gemini 2.5 Flash-Lite sub-agents (AgentTool, thinking off, ~1-2 s):
  - know_it_all       Google Search (a built-in tool can't sit on the same agent as function tools,
                      so it gets its own sub-agent).
  - pitch_polisher    structured output: the visitor's pitch as one sharp line + a pyramid version.
  - agent_blueprint   structured output: a voice-agent spec card for the visitor's problem.

  Plain function tools:
  - math_whiz         real Python, evaluated locally and safely. Instant.
  - make_friend_card  the souvenir card at the end of the call.

Gemini Live: the Flash-Lite sub-agents are NON_BLOCKING (NON_BLOCKING_TOOLS=1, the default), so the
friend keeps talking while they run and works the result in when it's idle (WHEN_IDLE).

The friend narrates what it's about to search or calculate before calling a tool (personas.BASE),
so the visitor hears what's happening and can cut in. If it calls one silently, the booth plays a
short cached line in the friend's voice instead (personas.BRIDGE_LINES).
"""
import ast
import math
import operator
import os
import re
from typing import Callable, Iterable

from google.adk.agents import Agent
from google.adk.tools import google_search
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.function_tool import FunctionTool
from google.genai import types
from pydantic import BaseModel, Field

TOOL_MODEL = os.getenv("TOOL_MODEL", "gemini-2.5-flash-lite")
# 0 = thinking off. A quick lookup gains little from reasoning, and the visitor is waiting on the line.
TOOL_THINKING_BUDGET = int(os.getenv("TOOL_THINKING_BUDGET", "0"))
# Gemini Live asynchronous function calling: the friend keeps talking while a sub-agent runs.
# Set NON_BLOCKING_TOOLS=0 if the live model rejects it.
NON_BLOCKING = os.getenv("NON_BLOCKING_TOOLS", "1") == "1"


def _lite_agent(name: str, description: str, instruction: str, *, tools=None, output_schema=None) -> Agent:
    """A one-job Flash-Lite sub-agent, thinking off, for the live friend to call as a tool."""
    return Agent(
        name=name,
        model=TOOL_MODEL,
        description=description,
        instruction=instruction,
        tools=tools or [],
        output_schema=output_schema,
        generate_content_config=types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(thinking_budget=TOOL_THINKING_BUDGET)),
    )


def _search_agent() -> Agent:
    return _lite_agent(
        "know_it_all",
        "Looks up fresh, real-world facts on Google Search (news, launches, prices, "
        "people, events). Pass the question as the request.",
        "Answer with fresh facts from Google Search, in one short spoken sentence.",
        tools=[google_search],
    )


# ---------- structured-output sub-agents (the result is shown as a card on the booth screen) ----------

class PolishedPitch(BaseModel):
    one_liner: str = Field(description="The visitor's pitch as one sharp, spoken sentence (max 25 words).")
    answer: str = Field(description="Pyramid tier 1: their main point or ask, in one short sentence.")
    because: str = Field(description="Pyramid tier 2: the strongest reason or proof they gave, in one short sentence.")
    so_what: str = Field(description="Pyramid tier 3: the next step or ask, in one short sentence.")


class AgentBlueprint(BaseModel):
    agent_name: str = Field(description="A catchy two- or three-word name for the voice agent.")
    hears: str = Field(description="What the agent listens to, in a few words.")
    does: str = Field(description="What the agent does for the user, in one short sentence.")
    tool: str = Field(description="The one tool or API it would call, e.g. 'Google Calendar API'.")
    verdict: str = Field(description="'Voice fits' or 'Not voice', plus a reason in under ten words.")


def _pitch_agent() -> Agent:
    return _lite_agent(
        "pitch_polisher",
        "Sharpens what the visitor has said into one crisp line and a pyramid (answer, because, "
        "so what). Pass everything they've said about themselves or their idea as the request.",
        "Rewrite the visitor's words into a sharp pitch. Use only facts they gave; never invent "
        "numbers or names. Plain spoken English, no jargon.",
        output_schema=PolishedPitch,
    )


def _blueprint_agent() -> Agent:
    return _lite_agent(
        "agent_blueprint",
        "Sketches a voice-agent spec card for the visitor's problem: what it hears, what it does, "
        "which tool it calls, and whether voice really fits. Pass the problem as the request.",
        "Design a simple voice agent built with Google ADK and Gemini Live for the problem. Be "
        "honest: if hands and eyes aren't busy, voice may not fit, so say 'Not voice'.",
        output_schema=AgentBlueprint,
    )


# ---------- Math Whiz: a safe calculator (no eval: only arithmetic nodes are allowed) ----------

_BINOPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
           ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.Pow: operator.pow}
_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_FUNCS = {"round": round, "abs": abs, "min": min, "max": max, "sqrt": math.sqrt, "log": math.log,
          "log10": math.log10, "ceil": math.ceil, "floor": math.floor}
_CONSTS = {"pi": math.pi, "e": math.e}
MAX_EXPR_CHARS = 200
MAX_EXPONENT = 100
MAX_MAGNITUDE = 1e15


def _check(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError("not a real number")
    if math.isnan(v) or math.isinf(v) or abs(v) > MAX_MAGNITUDE:
        raise ValueError("number too big")
    return v


def _eval(node):
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant) and type(node.value) in (int, float):
        return _check(node.value)
    if isinstance(node, ast.Name) and node.id in _CONSTS:
        return _CONSTS[node.id]
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
        return _check(_UNARY[type(node.op)](_eval(node.operand)))
    if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
        left, right = _eval(node.left), _eval(node.right)
        if isinstance(node.op, ast.Pow) and abs(right) > MAX_EXPONENT:
            raise ValueError("exponent too big")
        return _check(_BINOPS[type(node.op)](left, right))
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCS
            and not node.keywords and len(node.args) <= 10):
        return _check(_FUNCS[node.func.id](*[_eval(a) for a in node.args]))
    raise ValueError("only numbers and + - * / // % ** ( ) round abs min max sqrt log ceil floor")


def _normalise(expression: str) -> str:
    s = expression.strip().lower()
    s = s.replace("×", "*").replace("÷", "/").replace("^", "**")
    s = re.sub(r"(?<=\d),(?=\d{3}\b)", "", s)          # 2,400 -> 2400
    s = re.sub(r"(\d+(?:\.\d+)?)\s*%(?!\s*[\d(])", r"(\1/100)", s)  # 15% * 2400 -> (15/100) * 2400; 10 % 3 stays modulo
    s = re.sub(r"(?<=[\d)])\s*x\s*(?=[\d(])", "*", s)   # 3 x 4 -> 3*4
    return s


def _say(v) -> str:
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if isinstance(v, int):
        return f"{v:,}"
    return f"{v:,.4f}".rstrip("0").rstrip(".")


def calculate(expression: str) -> str:
    """Evaluate an arithmetic expression safely. Raises ValueError on anything else."""
    if not expression or len(expression) > MAX_EXPR_CHARS:
        raise ValueError("expression missing or too long")
    try:
        tree = ast.parse(_normalise(expression), mode="eval")
    except SyntaxError:
        raise ValueError("not a valid expression")
    try:
        return _say(_eval(tree))
    except ZeroDivisionError:
        raise ValueError("division by zero")
    except OverflowError:
        raise ValueError("number too big")


def math_whiz(expression: str) -> dict:
    """Runs real Python to calculate an exact answer, instantly (percentages, runway, ROI, splits, unit maths).

    Args:
        expression: the sum as a Python arithmetic expression, for example "0.6 * 400",
            "250000 / 18000" or "round(1200 * 1.08 ** 3, 2)". Numbers and + - * / // % ** ( ) only,
            plus round, abs, min, max, sqrt, log, ceil, floor.
    """
    try:
        return {"status": "ok", "expression": expression, "result": calculate(expression)}
    except (ValueError, TypeError) as e:
        return {"status": "error", "expression": expression, "error": str(e),
                "do_next": "Say briefly that the sum didn't work, and do it in your head or ask them to rephrase."}


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


def _sub_agent_tool(agent: Agent) -> AgentTool:
    tool = AgentTool(agent=agent)
    if NON_BLOCKING:
        tool.behavior = types.Behavior.NON_BLOCKING
        tool.response_scheduling = types.FunctionResponseScheduling.WHEN_IDLE
    return tool


# Every superpower a persona can pick, by tool name. Each builder makes a fresh instance per call.
# math_whiz and make_friend_card stay blocking: one is instant, the other ends the call.
CATALOG: dict[str, Callable[[], BaseTool]] = {
    "know_it_all": lambda: _sub_agent_tool(_search_agent()),
    "pitch_polisher": lambda: _sub_agent_tool(_pitch_agent()),
    "agent_blueprint": lambda: _sub_agent_tool(_blueprint_agent()),
    "math_whiz": lambda: FunctionTool(math_whiz),
    "make_friend_card": lambda: FunctionTool(make_friend_card),
}


# ---------- the guaranteed Friend Card ----------
# Every call ends with a card. If the friend never called make_friend_card, the server asks Flash-Lite
# to write one from the transcript (structured output); if that fails too, a template card is used.

class FriendCard(BaseModel):
    friend_name: str = Field(description="The visitor's name if they said it, otherwise a fun nickname from the chat.")
    catchphrase: str = Field(description="The visitor's best line from the chat, in a few words.")
    verdict: str = Field(description="A warm one-line verdict on the chat, in the persona's voice.")


MAX_TRANSCRIPT_CHARS = 6000


def template_card(transcript: list[dict]) -> dict:
    said = [t.get("text", "").strip() for t in transcript if t.get("role") == "user" and t.get("text", "").strip()]
    line = " ".join(said[-1].split()[:12]) if said else "Hello?"
    return {"friend_name": "Mystery Friend", "catchphrase": line, "verdict": "Thanks for calling. Come back anytime!"}


async def write_friend_card(persona_name: str, transcript: list[dict]) -> tuple[dict, str]:
    """(card, source). source is 'flash-lite' or 'template'. Never raises."""
    lines = "\n".join(f"{'Visitor' if t.get('role') == 'user' else persona_name}: {t.get('text', '').strip()}"
                      for t in transcript if t.get("text", "").strip())[-MAX_TRANSCRIPT_CHARS:]
    if not lines:
        return template_card(transcript), "template"
    try:
        from google import genai
        resp = await genai.Client().aio.models.generate_content(
            model=TOOL_MODEL,
            contents=(f"You are {persona_name}. Write the souvenir Friend Card for this booth call. "
                      f"Use only what the visitor actually said.\n\n{lines}"),
            config=types.GenerateContentConfig(
                response_mime_type="application/json", response_schema=FriendCard,
                thinking_config=types.ThinkingConfig(thinking_budget=TOOL_THINKING_BUDGET)),
        )
        return FriendCard.model_validate_json(resp.text).model_dump(), "flash-lite"
    except Exception:
        return template_card(transcript), "template"


def superpowers(names: Iterable[str]) -> list[BaseTool]:
    """Fresh tool instances for one call: the persona's combination, in order."""
    unknown = [n for n in names if n not in CATALOG]
    if unknown:
        raise ValueError(f"unknown superpowers {unknown}")
    return [CATALOG[n]() for n in names]
