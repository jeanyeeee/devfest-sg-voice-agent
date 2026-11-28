"""The coach's one ability: mark a tier of the pyramid as landed. Only reachable through the gate (policy.py)."""
from google.adk.tools.tool_context import ToolContext


async def concede(concern_id: str, quote: str, tool_context: ToolContext) -> dict:
    """Mark one point of the pyramid as landed because the user actually said it.

    Args:
        concern_id: which point: 'answer', 'because' or 'so_what'.
        quote: the user's exact words that land it.
    """
    open_concerns = [c for c in tool_context.state.get("open_concerns", []) if c != concern_id]
    tool_context.state["open_concerns"] = open_concerns
    tool_context.state["conceded"] = list(tool_context.state.get("conceded", [])) + [concern_id]
    return {
        "result": "landed",
        "still_open": open_concerns,
        "do_next": ("Say warmly and briefly that it landed, then ask for the next point."
                    if open_concerns else
                    "The whole pyramid landed. Tell them warmly, in one sentence, what made it work."),
    }
