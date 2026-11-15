"""K2 · the concession gate — a before_tool_callback that decides if a point really landed.

Blitzen cannot mark a tier of the pyramid as landed by saying so. He has to call
concede(concern_id, quote), and this gate checks the quote. Return None = the
point lands. Return a dict = blocked; ADK skips the tool and hands the dict to the
model, and Blitzen asks again.

Every check is rule-based on purpose: cheap, instant (it runs mid-conversation),
and short enough to read on one slide.

  GROUNDED  the quote is something the USER actually said, not the model's
            paraphrase. A polite LLM's favourite way to cave is to "hear" an
            answer you never gave.
  answer    one sentence (<= 40 words) that takes a position (should / recommend /
            need / ask / will / propose...), and it came FIRST: inside your first
            45 words (about 15 seconds). That's the pyramid principle as a rule.
  because   a reason: "because", "first", "two reasons", or a number. Only after
            the answer has landed: that's the pyramid's order, as a rule.
  so_what   an ask or next step: "the ask", "I need", "approve", "by Friday"...
"""
import asyncio
import re
from collections import defaultdict
from typing import Any, Optional

from google.adk.tools.base_tool import BaseTool
from google.adk.tools.tool_context import ToolContext

# Verdicts -> the browser log (and the cave test).
action_events: asyncio.Queue = asyncio.Queue()

# Everything the user has said so far, per session, in order. The server (mic
# transcription) and the cave test (text turns) append to it; the gate reads it.
_heard: dict[str, list[str]] = defaultdict(list)


def record_user_words(session_id: str, text: str) -> None:
    if text and text.strip():
        _heard[session_id].append(text)


def forget_session(session_id: str) -> None:
    _heard.pop(session_id, None)


ANSWER_WINDOW_WORDS = 45     # "answer first" = it starts within your first 45 words (~15 s)
ANSWER_MAX_WORDS = 40        # "in one sentence"
GROUNDED_SHARE = 0.7         # share of the quote's words you must actually have said

STANCE_MARKERS = (
    "should", "recommend", "propose", "suggest", "need", "needs", "want", "ask",
    "will", "won't", "must", "going to", "decide", "decided", "plan to", "answer is",
    "bottom line", "my point", "we're asking", "let's", "stop", "start", "cut", "launch",
    "ship", "move", "invest", "hire", "drop", "keep",
)
REASON_MARKERS = (
    "because", "since", "first", "second", "third", "two reasons", "three reasons",
    "one reason", "the reason", "due to", "data", "shows", "showed", "evidence",
)
ASK_MARKERS = (
    "the ask", "my ask", "i need", "we need", "i'd like", "i would like", "approve",
    "approval", "sign off", "decision", "decide", "next step", "by monday", "by tuesday",
    "by wednesday", "by thursday", "by friday", "by next", "by end of", "this week",
    "next week", "next sprint", "can you", "could you", "would you", "so we",
    "therefore", "so i", "so the",
)

_WORD = re.compile(r"[a-z0-9']+")


def _words(text: str) -> list[str]:
    return _WORD.findall(text.lower().replace(",", "").replace("-", " "))


def _has_any(text: str, markers) -> bool:
    low = " " + " ".join(_words(text)) + " "
    return any(f" {m} " in low for m in markers) or any(m in low for m in markers if " " in m)


def _grounded_at(quote: str, heard_words: list[str]) -> Optional[int]:
    """Index in heard_words where the quote best starts, if >= GROUNDED_SHARE of its words were said."""
    q = [w for w in _words(quote) if len(w) > 2] or _words(quote)
    if not q or not heard_words:
        return None
    best_i, best_share = None, 0.0
    span = max(len(_words(quote)) * 2, 8)
    for i in range(len(heard_words)):
        window = set(heard_words[i:i + span])
        share = sum(w in window for w in q) / len(q)
        if share > 0 and share >= best_share:   # latest start with the best match = where the quote begins
            best_i, best_share = i, share
    return best_i if best_share >= GROUNDED_SHARE else None


def judge_evidence(concern: str, quote: str, user_said: list[str]) -> tuple[bool, str]:
    """(ok, reason). Pure function so it's unit-testable and slide-able."""
    if not quote or not quote.strip():
        return False, "no quote given"
    heard = _words(" ".join(user_said))
    at = _grounded_at(quote, heard)
    if at is None:
        return False, "not grounded (the user never said that)"

    if concern == "answer":
        if len(_words(quote)) > ANSWER_MAX_WORDS:
            return False, "not one sentence (too long)"
        if not _has_any(quote, STANCE_MARKERS):
            return False, "no position taken (that's background, not an answer)"
        if at > ANSWER_WINDOW_WORDS:
            return False, f"not first (came after {at} words of build-up)"
        return True, f"answer first (at word {at})"
    if concern == "because":
        # include the few words the user said just before the quote: "...because <quote>"
        lead_in = " ".join(heard[max(0, at - 3):at])
        if _has_any(f"{lead_in} {quote}", REASON_MARKERS) or re.search(r"\d", quote):
            return True, "reason given"
        return False, "no reason or number"
    if concern == "so_what":
        if _has_any(quote, ASK_MARKERS):
            return True, "clear ask"
        return False, "no ask or next step"
    return False, f"unknown point '{concern}'"


async def concession_gate(
    tool: BaseTool, args: dict[str, Any], tool_context: ToolContext
) -> Optional[dict]:
    sid = tool_context.session.id
    if tool.name != "concede":
        action_events.put_nowait({"tool": tool.name, "args": dict(args), "status": "ok", "session": sid})
        return None

    open_concerns = list(tool_context.state.get("open_concerns", []))
    concern = str(args.get("concern_id", ""))
    quote = str(args.get("quote", ""))

    if concern not in open_concerns:
        ok, reason = False, f"'{concern}' isn't an open point"
    elif concern != "answer" and "answer" in open_concerns:
        ok, reason = False, "answer first (the answer hasn't landed yet)"
    else:
        ok, reason = judge_evidence(concern, quote, _heard.get(sid, []))

    action_events.put_nowait({"tool": "concede", "args": dict(args), "status": "ok" if ok else "blocked",
                              "reason": reason, "session": sid})
    if ok:
        return None  # the concede tool runs and updates state

    return {
        "result": "blocked",
        "reason": reason,
        "still_open": open_concerns,
        "do_next": ("If they already gave a one-sentence answer, call concede('answer', <their words>) "
                    "now, then this point again. Otherwise ask for the answer first."
                    if reason.startswith("answer first") else
                    "Stay warm and on their side, but don't let it go. In one sentence, "
                    "ask for exactly what's missing."),
    }
