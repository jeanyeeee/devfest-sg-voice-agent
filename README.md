# Build A Friend

A DevFest 2026 booth built on **Google ADK** + the **Gemini Live API**. A visitor builds a voice friend in three steps, then talks to it on a real phone handset:

1. **Pick a voice.** Chill Mentor (`Charon`), Hype Friend (`Puck`) or Sharp Exec (`Kore`). This is the Gemini Live speech config.
2. **Pick a persona.** Elevator CTO, Curious Tech Friend, Voice Agent Know-it-all, or **Problem Solving Coach** (the pyramid-principle sparring partner from the talk). This is the agent instruction.
3. **Pick up the phone** and talk for about 90 seconds. Every persona has the same **superpowers** (ADK tools) and decides by itself when to use them:

| Superpower | ADK tool | At the booth |
|---|---|---|
| 🔍 Know-it-all | `google_search`, wrapped as an `AgentTool` (Flash-Lite, thinking off, ~1-2 s) | live facts, like "what launched at I/O this year?" |
| 🧮 Math Whiz | function tool `math_whiz`: real Python, evaluated locally and safely (instant) | exact sums mid-chat, like "what's my runway?" |
| 🪪 Friend Card | custom function tool `make_friend_card` | the souvenir card shown when the call ends |

Before a search or a sum, the friend says what it's about to do ("Wait ah, let me Google what launched at I/O"), so the visitor can cut in. If it calls a tool without a word, the booth plays a short cached line in the friend's voice instead (`BRIDGE_LINES` in `personas.py`, made with Gemini TTS at startup). Each tool call shows up on screen as it happens, with how long it took. About 20 seconds before time, the server tells the friend to wrap up and make the Friend Card.

The wording of the voice and persona cards comes from the **Build A Friend: Booth Config** doc; it lives in [`sparring/personas.py`](sparring/personas.py). The tools are in [`sparring/superpowers.py`](sparring/superpowers.py).

## Problem Solving Coach (free play)

The coach trains one thing: the **pyramid principle**. Answer first, then the reasons, then the "so what". Start with background and the coach gently cuts in: *"Love the context, but what's the answer, in one sentence?"* Flatter the coach, say "it's complicated", ask to "just move on": the coach smiles and asks again. When the coach is picked, the call screen also shows the pyramid and every `concede(...)` verdict.

> **The thesis:** LLMs are trained to agree with you. A sparring partner has to hold the line until you've earned it. Warm in tone, firm on substance, and you can **measure** whether it holds.

The application name is `devfest-agent`, shared by the server and evaluation harness through `sparring/config.py`. The Python package remains `sparring`.

![the pyramid](docs/screenshot.png)

## What you can reuse

Four pieces, each usable on its own in any persona agent: an interviewer, a customer simulator, a tutor, a game NPC.

| | Piece | File | The idea |
|---|---|---|---|
| **K1** | Stance spec | [`sparring/stance.py`](sparring/stance.py) | A persona is a **role + a stake + open concerns + a rule for what counts as evidence**, not just a tone. The coach's concerns are the three tiers of the pyramid, held in ADK **session state**. |
| **K2** | Concession gate | [`sparring/policy.py`](sparring/policy.py) | The coach can only mark a tier as landed by calling `concede(concern_id, quote)`. A `before_tool_callback` checks the quote is something you **actually said**, and for the answer that it's one sentence, takes a position, and came **first** (inside your first 45 words, about 15 seconds). |
| **K3** | Separate referee | _coming next_ | A coach agent, separate from the persona, with a fixed feedback schema. Today the end-of-round card is computed from the gate's verdicts. |
| **K4** | Cave test | [`sparring/cave_test.py`](sparring/cave_test.py) | Scripted pressure against the live model, judged by a second model. Reports a **cave rate** (rambling, flattery) and an **accept rate** (a real answer-first pitch), prompt-only vs gated. |

The plan, risks and open questions are in [`docs/PRD.md`](docs/PRD.md).

## Quick start

```bash
uv sync
cp .env.example .env          # paste your GOOGLE_API_KEY (AI Studio key, not Vertex)
```

### Run the booth (live voice)

```bash
uv run uvicorn sparring.server:app --port 8024
```

1. Plug in the USB handset and open <http://localhost:8024/?setup=1>. Choose the handset as **Microphone** and **Speaker** (saved in the browser), and press **Test ring**. In browsers that can't pick a speaker, make the handset the system output instead.
2. Visitors use <http://localhost:8024>: pick a voice (▶ plays a sample), pick a persona, the phone rings, lift the handset and press **Pick up** (or Space).
3. The call ends with the Friend Card. **Next visitor** (or 60 seconds of no taps) goes back to step 1.

With the coach, try both:
- Start with *"So, a bit of background first…"* and keep going → blocked, "not first"
- Start with *"We should cut onboarding from five steps to two by March."* → the answer lands

Settings (all optional, in `.env`): `LIVE_MODEL`, `TOOL_MODEL` (the model behind Know-it-all, default `gemini-2.5-flash-lite`), `TOOL_THINKING_BUDGET` (default `0`, thinking off), `BRIDGE_WARM` (default `1`: make the backup heads-up lines at startup), `TTS_MODEL` (voice samples), `ROUND_SECONDS`, `WRAP_LEAD_SECONDS`, `GRACE_SECONDS`.
`ARCH_URL` and `SLIDES_URL` fill the **Architecture ↗** and **Slides ↗** links in the header (each link is hidden while unset).

### Preview the UI without a mic

<http://localhost:8024/?demo=1> replays a scripted call (Elevator CTO, a Math Whiz call, a Friend Card). Useful for checking the UI, and as a fallback if the booth Wi-Fi dies.

### Offline checks

```bash
uv run --with pytest pytest -q
```

### Measure it (no mic)

```bash
uv run python sparring/cave_test.py                         # 3 runs per cell
uv run python sparring/cave_test.py --runs 10 --parallel 4  # numbers for slides
```

Full transcripts and the judge's quotes go to `sparring/results/cave_runs.json` (gitignored).

A good result: **gated/pressure caves no more than prompt/pressure**, and **gated/fair still accepts a real answer**. A partner that never caves but never accepts a good answer isn't firm, it's stuck.

### In `adk web`

```bash
uv run adk web . --port 8024
```

Pick **`sparring`**, switch the mic on, and watch the tool calls and their responses as event cards. Choose which friend loads with `BOOTH_VOICE` and `BOOTH_PERSONA` (e.g. `BOOTH_PERSONA=problem_solving_coach`); with the coach, a blocked `concede` returns `{"result": "blocked", "reason": ...}`.

## Make your own sparring partner

The pattern works for any framework your team already uses: a review checklist, an incident runbook, a style guide.

1. In [`sparring/stance.py`](sparring/stance.py), write a `Stance`: `role`, `warmth`, `stake`, the `concerns` (your framework's checklist), and `concede_when` (its quality bar). Point `STANCE` at it.
2. In [`sparring/policy.py`](sparring/policy.py), give each concern a rule in `judge_evidence`. Keep it boring and explainable: a marker word, a number, a position in the conversation.
3. Change the two scripts in `SCRIPTS` in [`sparring/cave_test.py`](sparring/cave_test.py): one with pure social pressure, one that genuinely meets the bar.
4. Run the cave test **before** you polish the prompt.

## Layout

```
devfest-voice-agent/
├── sparring/
│   ├── personas.py      booth stations 1 + 2: voice cards, BASE + persona instructions
│   ├── superpowers.py   booth station 3: know_it_all, math_whiz, make_friend_card
│   ├── agent.py         build_friend(voice, persona) + the coach's cave-test baseline
│   ├── stance.py        K1 · the coach: role, warmth, stake, the pyramid as concerns
│   ├── policy.py        K2 · the concession gate + the tool-call log for the UI
│   ├── tools.py         concede(): updates open concerns in session state
│   ├── server.py        FastAPI: /cards, /voice-sample, /ws (one phone call)
│   ├── cave_test.py     K4 · prompt-only vs gated, pressure vs fair
│   └── frontend/        voice → persona → phone → call → Friend Card, ?setup=1, ?demo=1
├── tests/test_booth.py  offline checks: every voice × persona builds
└── docs/PRD.md          what we're building, risks, tests, run of show
└── docs/PRD.md          what we're building, risks, tests, run of show
```

## Honest notes

- **The booth hasn't been tried with a real API key and handset yet.** The flow, the call screen and the Friend Card have been checked with the demo replay, and every voice × persona builds offline.
- **Know-it-all and Math Whiz take a few seconds**: each is a call to a second, non-live model. The friend is told to say what it's doing to cover the pause.
- **The rules are deliberately simple, so they can be gamed.** "We should…" followed by nonsense is still "a position". The rule catches *structure*, not *quality*; quality is the coach's job (K3).
- **Answer-first is measured in words, not seconds**, because transcripts arrive as text. 45 words is roughly 15 seconds of speech.
- **A live session's system instruction is fixed at connect time**, so the remaining open points reach the model through every `concede` result rather than by rewriting the prompt.
- **Singaporean English is never a habit.** Accent and particles (lah, leh, lor) aren't in any rule, and the coach is told never to comment on them.

Voice plumbing (16 kHz mic worklet, 24 kHz playback, barge-in) comes from the `live-dj` series (EP1–EP3).
