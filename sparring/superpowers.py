"""Booth station 3: superpowers, i.e. the ADK tools every friend can call by itself.

  - know_it_all       Google Search, wrapped as an AgentTool sub-agent (built-in tools can't sit
                      on the same agent as function tools). One round trip to a second, non-live
                      model, kept fast: Flash-Lite with thinking off (~1-2 s).
  - math_whiz         a plain function tool: real Python, evaluated locally and safely. Instant.
  - make_friend_card  a plain function tool: the souvenir card at the end of the call.

The friend narrates what it's about to search or calculate before calling a tool (personas.BASE),
so the visitor hears what's happening and can cut in. If it calls one silently, the booth plays a
short cached line in the friend's voice instead (personas.BRIDGE_LINES).
"""
import ast
import math
import operator
import os
import re

from google.adk.agents import Agent
from google.adk.tools import google_search
from google.adk.tools.agent_tool import AgentTool
from google.genai import types

TOOL_MODEL = os.getenv("TOOL_MODEL", "gemini-2.5-flash-lite")
# 0 = thinking off. A quick lookup gains little from reasoning, and the visitor is waiting on the line.
TOOL_THINKING_BUDGET = int(os.getenv("TOOL_THINKING_BUDGET", "0"))


def _search_agent() -> Agent:
    return Agent(
        name="know_it_all",
        model=TOOL_MODEL,
        description="Looks up fresh, real-world facts on Google Search (news, launches, prices, "
                    "people, events). Pass the question as the request.",
        instruction="Answer with fresh facts from Google Search, in one short spoken sentence.",
        tools=[google_search],
        generate_content_config=types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(thinking_budget=TOOL_THINKING_BUDGET)),
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


def superpowers() -> dict:
    """Fresh tool instances for one call (every persona gets all of them)."""
    return {
        "know_it_all": AgentTool(agent=_search_agent()),
        "math_whiz": math_whiz,
        "friend_card": make_friend_card,
    }
