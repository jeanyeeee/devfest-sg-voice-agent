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


@pytest.mark.parametrize("voice", VOICE_CARDS)
@pytest.mark.parametrize("persona", PERSONA_CARDS)
def test_every_combo_builds(voice, persona):
    agent, rc = build_friend(voice, persona)
    names = {getattr(t, "name", getattr(t, "__name__", None)) for t in agent.tools}
    assert {"know_it_all", "math_whiz", "make_friend_card"} <= names
    assert ("concede" in names) == PERSONA_CARDS[persona].pyramid
    assert rc.speech_config.voice_config.prebuilt_voice_config.voice_name == VOICE_CARDS[voice].voice_name


def test_unknown_cards_rejected():
    with pytest.raises(ValueError):
        build_friend("nope", "blitzen")
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
        policy.forget_session("call-a"); policy.forget_session("call-b")

    asyncio.run(run())
