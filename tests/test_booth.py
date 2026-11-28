"""Offline checks for the booth: every voice x persona builds, and tool calls reach the right call's log.

    uv run --with pytest pytest -q
"""
import asyncio
import os

import pytest

os.environ.setdefault("GOOGLE_API_KEY", "offline-test")

from sparring import policy
from sparring.agent import build_friend
from sparring.personas import PERSONA_CARDS, VOICE_CARDS
from sparring.server import TranscriptTracker


@pytest.mark.parametrize("voice", VOICE_CARDS)
@pytest.mark.parametrize("persona", PERSONA_CARDS)
def test_every_combo_builds(voice, persona):
    agent, rc = build_friend(voice, persona)
    names = {getattr(t, "name", getattr(t, "__name__", None)) for t in agent.tools}
    assert {"know_it_all", "math_whiz", "make_friend_card"} <= names
    assert ("concede" in names) == PERSONA_CARDS[persona].pyramid
    assert rc.speech_config.voice_config.prebuilt_voice_config.voice_name == VOICE_CARDS[voice].voice_name


def test_run_config_transcribes_both_sides():
    _, rc = build_friend("hype_friend", "problem_solving_coach")
    assert rc.input_audio_transcription is not None
    assert rc.output_audio_transcription is not None


class _Tr:
    def __init__(self, text, finished=False):
        self.text, self.finished = text, finished


def test_transcript_fragments_then_finished():
    t = TranscriptTracker()
    assert t.update("user", None) == (None, None)
    msg, heard = t.update("user", _Tr("We should "))
    assert msg == {"type": "transcript", "role": "user", "text": "We should ", "finished": False}
    assert heard == "We should "
    msg, heard = t.update("user", _Tr("ship it."))
    assert msg["finished"] is False and heard == "ship it."
    # the finished turn carries the full text for the UI, but the gate already has the fragments
    msg, heard = t.update("user", _Tr("We should ship it.", finished=True))
    assert msg == {"type": "transcript", "role": "user", "text": "We should ship it.", "finished": True}
    assert heard is None
    # the next turn starts fresh: a finished-only turn is recorded once
    msg, heard = t.update("user", _Tr("Because churn fell 12%.", finished=True))
    assert msg["finished"] is True and heard == "Because churn fell 12%."


def test_transcript_empty_close_settles_a_live_turn():
    t = TranscriptTracker()
    assert t.update("persona", _Tr("", finished=True)) == (None, None)   # no live turn: no-op
    t.update("persona", _Tr("Hello"))
    msg, heard = t.update("persona", _Tr("", finished=True))
    assert msg == {"type": "transcript", "role": "persona", "text": "", "finished": True}
    assert heard is None
    assert t.update("user", _Tr("hi"))[0]["role"] == "user"   # roles are tracked separately


def test_unknown_cards_rejected():
    with pytest.raises(ValueError):
        build_friend("nope", "problem_solving_coach")
    with pytest.raises(ValueError):
        build_friend("hype_friend", "nope")


def test_tool_events_go_to_their_own_call():
    class Tool:
        name = "make_friend_card"

    class Ctx:
        class session:
            id = "call-a"
        state = {}

    async def run():
        mine = policy.listen("call-a")
        other = policy.listen("call-b")
        await policy.concession_gate(Tool(), {"friend_name": "Alex"}, Ctx())
        await policy.tool_result_log(Tool(), {"friend_name": "Alex"}, Ctx(),
                                     {"status": "card_created", "card": {"friend_name": "Alex"}})
        got = [mine.get_nowait(), mine.get_nowait()]
        assert other.empty()
        assert [e["phase"] for e in got] == ["call", "result"]
        assert got[1]["result"]["card"]["friend_name"] == "Alex"
        assert isinstance(got[1]["ms"], int) and got[1]["ms"] >= 0   # call -> result duration
        policy.forget_session("call-a"); policy.forget_session("call-b")

    asyncio.run(run())


def test_cards_carry_header_links(monkeypatch):
    from sparring.server import cards
    monkeypatch.setenv("SLIDES_URL", "https://example.com/slides")
    monkeypatch.delenv("ARCH_URL", raising=False)
    data = asyncio.run(cards())
    assert data["links"] == {"architecture": "", "slides": "https://example.com/slides"}
    assert data["seconds"] > 0 and data["voices"] and data["personas"]


# ---------- Math Whiz: the local calculator ----------

@pytest.mark.parametrize("expr, want", [
    ("0.6 * 400", "240"), ("15% * 2,400", "360"), ("10 % 3", "1"), ("2^10", "1,024"),
    ("3 x 4", "12"), ("250000 / 18000", "13.8889"), ("round(1200 * 1.08 ** 3, 2)", "1,511.65"),
])
def test_math_whiz_calculates(expr, want):
    from sparring.superpowers import math_whiz
    assert math_whiz(expr) == {"status": "ok", "expression": expr, "result": want}


@pytest.mark.parametrize("expr", [
    "__import__('os').system('ls')", "9**9**9", "1/0", "(-8)**0.5", "'a' * 3", "[1] * 3",
    "open('x')", "x", "", "1" * 300, "10**20",
])
def test_math_whiz_refuses_anything_else(expr):
    from sparring.superpowers import math_whiz
    out = math_whiz(expr)
    assert out["status"] == "error" and out["error"]


def test_search_runs_with_thinking_off():
    from sparring.superpowers import _search_agent
    cfg = _search_agent().generate_content_config
    assert cfg.thinking_config.thinking_budget == 0


# ---------- backup heads-up lines ----------

def test_cards_carry_bridge_lines():
    from sparring.personas import BRIDGE_LINES
    from sparring.server import cards
    data = asyncio.run(cards())
    assert data["bridges"] == {k: list(v) for k, v in BRIDGE_LINES.items()}
    assert set(data["bridges"]) == {"know_it_all", "math_whiz"}


def test_bridge_route_rejects_unknown_lines():
    from fastapi import HTTPException
    from sparring.server import bridge
    for args in [("nope", "know_it_all", 0), ("hype_friend", "make_friend_card", 0), ("hype_friend", "math_whiz", 99)]:
        with pytest.raises(HTTPException) as e:
            asyncio.run(bridge(*args))
        assert e.value.status_code == 404


def test_bridge_route_serves_cached_audio(tmp_path, monkeypatch):
    from sparring import server
    monkeypatch.setattr(server, "BRIDGE_CACHE", tmp_path)
    server._bridge_path("hype_friend", "math_whiz", 1).write_bytes(b"RIFF-fake-wav")   # no TTS call needed
    resp = asyncio.run(server.bridge("hype_friend", "math_whiz", 1))
    assert resp.body == b"RIFF-fake-wav" and resp.media_type == "audio/wav"
