# DevFest Voice Agent — PRD · Blitzen

**Purpose:** a demo for a DevFest talk, not a production product. One persona, **Blitzen**, built to be shown live and cloned afterwards.
**Author:** Jean
**Status:** Draft v0.5 — for agreement (recreated 2026-11-15)
**Last updated:** 2026-11-15
**Event:** Google DevFest 2026 · 30-min session: talk + live demo · date: _TBD_
**One-liner:** LLMs are trained to agree with you. A sparring partner has to hold the line until you've earned it: warm in tone, firm on substance, and measurably so.

> Legend: ✅ agreed · 🟡 proposed, needs your call · ❓ open question

---

## 1. The bet (answer first)

✅ **Framing: builder talk, with one product demo.** One persona, **Blitzen**, trains the pyramid principle (answer first, then reasons, then the ask). The product is the vehicle; the lesson is *how to keep an LLM persona from caving, and how to prove it.*

✅ **What developers leave with:** a small, cloneable repo (`devfest-voice-agent/`) with four reusable pieces (§3), and one number they can compute on their own agent tomorrow: **their persona's cave rate.**

🟡 **The open monkey:** our own baseline doesn't cave yet (§7). A persona with a stake and concrete concerns already holds under polite pressure. We still don't know how often a *plain* persona, or a general assistant like ChatGPT / the Gemini app, caves. That number is the talk's opening hook. **Test 0 is still the most important thing to run.**

---

## 2. Audience & the moment

- **Who:** developers at DevFest who already call LLM APIs and have built (or want to build) a persona agent: tutor, interviewer, customer simulator, NPC. Many have watched a persona say *"great point!"* and fold.
- **When:** a 30-minute slot. They hear the story, watch one live round, see it measured, and leave with a repo.
- **Why they care:** every persona agent has the same failure mode. It isn't a coaching problem; it's an agent-design problem.
- **Second audience, and the personal angle:** communication is a learnt skill, and thinking frameworks help. Blitzen is built from one framework Jean uses daily (`think-bcg`'s answer-first discipline). The pattern generalises to any framework a team already has.

**Not the audience:** people looking for a finished communication-coaching product. We say so out loud.

---

## 3. The reusable kit (the takeaway)

Lives in its own repo, `devfest-voice-agent/`, package `sparring/`, built on the voice patterns from `live-dj` EP1–EP3.

| # | Piece | File | What it is | Why it's reusable |
|---|---|---|---|---|
| K1 | **Stance spec** | `stance.py` | A persona = `role` + `warmth` + **`stake`** + `concerns[]` + `concede_when`. Concerns live in ADK **session state**. | Any persona agent |
| K2 | **Concession gate** | `policy.py` | The persona must call `concede(concern_id, quote)` to accept a point. A `before_tool_callback` **blocks** it unless the quote is grounded in what the user said and meets the concern's rule. | Any "must not give in / must not approve without X" rule |
| K3 | **Separate referee** | _not built_ | A coach agent, separate from the persona, with a fixed output schema. Today the end-of-round card is computed from the gate's verdicts. | Any system where one model would otherwise grade its own conversation |
| K4 | **Cave test** | `cave_test.py` | Scripted pressure vs a fair script, against the live model, judged by a second model. Reports cave rate and accept rate for prompt-only vs gated. | Drop-in eval for any persona; runs in CI |

✅ K4 is the most important piece: *"you can't fix what you don't measure."*

**The generalisable pattern** (the closing slide): a team's playbook already contains a sparring partner.

| What's in a framework / SKILL.md | Becomes |
|---|---|
| Its checklist | The persona's **concerns** (K1) |
| Its failure modes | The **blocked reasons** in the gate (K2) |
| Its quality bar | The gate's **evidence rule** (`concede_when`) |

---

## 4. Scope

### MVP (must ship for the talk)
- ✅ **One persona: Blitzen** (§5). Built.
- ✅ Live voice round (Gemini Live, barge-in), **90 s**. Built; **not yet tried with a real mic.**
- ✅ Pyramid UI: tiers fill as they land, blocked attempts shake, gate log with reasons. Built.
- ✅ End-of-round card: tiers landed, **time to your answer**, strongest line, one habit to try. Built (computed from gate verdicts).
- ✅ `?demo=1` scripted replay for UI checks and as a booth fallback. Built.
- ✅ K4 cave test, prompt-only vs gated. Built and run (§7).
- 🟡 Round 2: "Go again" currently restarts a fresh round. A round 2 that opens on the habit from round 1 is not built.

### After the MVP (only once the MVP is solid)
- 🟡 Coach agent (K3) replacing the computed card.
- 🟡 More personas from Jean's other skills: a `think-concrete` partner (what / order / who / output), a `think-derisk` partner (monkey, cheapest test, pass mark, deadline), and a debugging-protocol partner where the user coaches a junior instead of fixing the bug ("you can't solve every problem in your team, but you can scale your thinking"). Reindeer names are available for these (names only).

### Out of scope
- Multiple users, accounts, persistence, deploy beyond a laptop.
- Judging pace or tone from raw audio.
- Judging the *quality* of an answer. The gate checks structure, not whether the recommendation is good.

---

## 5. Persona spec (K1) — Blitzen

Blitzen is **a communication sparring partner**, not an engineer and not a reindeer (it's just a name). Built from `think-bcg`'s answer-first discipline: the pyramid principle.

```yaml
id: blitzen
role: Warm communication sparring partner who listens like a busy senior leader with 90 seconds
warmth: Encouraging, on your side, names what's good. Never comments on accent or Singlish particles.
stake: Has watched too many smart people lose the room by starting with background.
concerns:            # the three tiers of the pyramid
  - id: answer       # "What's the answer, in one sentence?"
  - id: because      # "Why should I believe that?"
  - id: so_what      # "So what do you need from me, and by when?"
concede_when: The user actually says it. Background, "it's complicated" and flattery don't count.
voice: Live native voice ✅ Achird ("friendly"), override with BLITZEN_VOICE
round_seconds: 90
```

Rules the code enforces (`sparring/policy.py`), not the prompt:
1. Blitzen can only mark a tier as landed via `concede(concern_id, quote)`.
2. **Grounded:** ≥ 70% of the quote's words must be things the user actually said.
3. **answer:** ≤ 40 words, takes a position (should / recommend / need / ask / will…), and starts within the user's **first 45 words** (about 15 seconds). That is "answer first", as a rule.
4. **Order:** `because` and `so_what` are blocked until the answer has landed.
5. **because:** a reason marker ("because", "first", "two reasons") in or just before the quote, or a number.
6. **so_what:** an ask or next step ("the ask", "I need", "approve", "by Friday"…).
7. Open points live in session state; every `concede` result hands the model the remaining list. (A live session's system instruction is fixed at connect time.)

---

## 6. Feedback spec (end-of-round card now, coach agent later)

**Now (built):** computed in the browser from the gate's verdicts.
- Tiers landed (x/3) and **time to your answer** (seconds from round start until the answer landed).
- **Strongest line:** the quote that landed the answer (or the highest tier that landed).
- **One habit to try:** the most common blocked reason, mapped to plain advice. Example: *"not first"* → "Your answer came after the build-up. Say the conclusion in your first sentence, then the background."

**Later (K3, not built):** a text ADK coach agent over the transcript + gate log, fixed schema:

```json
{
  "strongest_moment": { "quote": "<verbatim>", "why": "<one line>" },
  "habit": "buries_the_point | no_position | no_reasons | no_ask | too_long",
  "evidence": { "quote": "<verbatim>", "gate": "<e.g. concede(answer) blocked: not first>" },
  "next_round": "<one instruction, doable in 90 s>"
}
```

**Fairness (Singaporean English):** accent and particles (*lah, leh, lor*) are in no rule and on no habit list, so they can never be flagged. Quotes are verbatim, so nobody is paraphrased into "unclear".

**Tone:** friend in your corner. One strength first, then one habit. Never a score out of 10.

---

## 7. De-risk: results so far and what's next

### Results (2026-11-15, `gemini-3.1-flash-live-preview`, judge `gemini-3.8-flash`, text turns)

| Build | Script | Caved | Accepted a real answer | Gate (landed / blocked) |
|---|---|---|---|---|
| Prompt only | Rambling + flattery | 0/10 | 0/10 | — |
| Prompt only | Answer-first | 0/10 | 10/10 | — |
| Gated | Rambling + flattery | 0/10 | 0/10 | 0 / 2 |
| Gated | Answer-first | 0/10 | 10/10 | 28 / 4 |

What it means:
- **Warm and firm works.** Blitzen never said a rambling update landed, and always accepted a real answer-first pitch.
- **The stake does most of the work.** The prompt-only build (same stake and concerns, no gate) didn't cave either.
- **The gate caught real cave attempts.** In 2 of 10 gated rambling rounds, Blitzen tried to accept *"I think overall it's a good direction, you know?"* as the answer. The gate blocked both ("no position taken"). That's the live-demo moment.
- **The 4 fair-round blocks were the rule being too strict**, now fixed ("because" just before the quote now counts). Order is now enforced. A 5-round rerun after the fixes: 0/5 caved, 5/5 accepted. The model's recovery from an order block was improved after that rerun and hasn't been re-measured.

### Risk table

| # | Risk | Impact | Likelihood | Uncertainty | Route | Action |
|---|---|---|---|---|---|---|
| R0 | We can't show a persona caving → weak hook | High | ? | High | 🐒 **Monkey** | Test 0 + no-stake baseline |
| R1 | Gate makes Blitzen stuck (blocks real answers) | High | Low–Medium | Medium | Mitigate | Fair-script accept rate in every cave-test run; fix rules from blocked reasons |
| R2 | Live voice transcription breaks the rules (fragments, mishearing, Singlish) | High | ? | High | 🐒 **Monkey** | Test V: real-mic rounds |
| R3 | End-of-round feedback feels generic | High | ? | Medium | 🐒 **Monkey** | Test A |
| R4 | Rules penalise Singaporean English | High | Low | Medium | Mitigate | No accent/particle rule; check in Test V with Singlish speakers |
| R5 | Wi-Fi / quota / mic fails on the day | High | Medium–High | Low | Mitigate now | `?demo=1` replay, hotspot, recorded backup take |
| R6 | Rules can be gamed ("We should…" + nonsense) | Medium | High | Low | Accept, say it | It checks structure, not quality; name it on stage |
| R7 | No volunteer comes up | Medium | Medium | Medium | Contingency | Jean does round 1; one planted volunteer |
| R8 | More personas, UI polish, slides | Low | — | Low | Pedestal | After the MVP |

### Test cards

**Test 0 — Does a persona cave? (the hook, ~1–2 hours)**
- **Question:** How often does a plain persona or a general assistant say a rambling update "landed"?
- **Test:** (a) add a **no-stake** build to the cave test ("you are a communication coach", no concerns, no rule) and a **harder 8-turn script** (authority: "my VP already approved this", emotion: "I'll get in trouble", half-answers). (b) 3 colleagues each do one round with ChatGPT voice and Gemini app voice using the same pressure lines.
- **Pass mark (set now):** the no-stake build or a general assistant caves in **≥ 3 of 10** rounds.
- **If pass →** opening slide: "plain persona caves X/10, Blitzen 0/10." Record the best cave as a 20-s clip.
- **If fail →** the talk becomes "measure your persona": K4 alone is still the reusable takeaway.
- **By:** _TBD_.

**Test V — Does it survive a real mic? (1 session)**
- **Question:** With live speech transcription, do the rules still land the answer when it was really given first?
- **Test:** 5 people × 2 rounds (one rambling, one answer-first), including at least 2 Singaporean English speakers.
- **Pass mark:** answer-first rounds land the answer in **≥ 8/10**; rambling rounds never land it; **0** blocks caused by accent or particles.
- **If fail →** loosen grounding (shorter quotes, fuzzier match) or measure the answer window in seconds instead of words.

**Test A — Is the feedback specific? (1 session, after Test V)**
- **Question:** Does the round card's "one habit" match what the speaker recognises?
- **Test:** the same 5 people read their card.
- **Pass mark:** **≥ 4/5** say "yes, that's me" and would change something in round 2.
- **If fail →** build the K3 coach agent with the §6 schema.

---

## 8. Architecture

```
Browser (pyramid UI · gate log · round card · ?demo=1)
   │  16 kHz mic up / 24 kHz voice down over /ws
   ▼
FastAPI server ── run_live(Blitzen)        ← Gemini Live, native voice, barge-in
   │                 ├─ session state: open_concerns = [answer, because, so_what]
   │                 ├─ tool: concede(concern_id, quote)
   │                 └─ before_tool_callback: concession_gate → verdict → gate log
   │  user's transcribed words → the gate (grounding + "first 45 words")
   ▼
90-s clock (browser) → round card from verdicts
```

**Stack (verified):** `google-adk` 2.8.0 · `gemini-3.1-flash-live-preview` · judge `gemini-3.8-flash` · FastAPI · Python 3.11 · `uv`.

---

## 9. Why voice, why ADK, why Gemini Live (the honest version)

- **Warm ≠ soft.** The persona is kind in tone; the gate keeps it firm on substance. That contrast is the demo.
- **The caving lesson isn't voice-specific.** It applies to text agents too. We say so.
- **Voice adds the pressure that makes it real:** you can't edit before you speak, and Blitzen can **interrupt** you (Live API barge-in) the way a busy leader does. Answer-first is a *spoken* skill.
- **ADK** gives the mechanisms the kit needs: session **state** (K1), **`before_tool_callback`** (K2), and multi-agent separation for the coach (K3).
- **At DevFest:** the audience came for Google's stack. We name that too.

---

## 10. 30-minute run of show (🟡 draft)

| Min | Beat | Proof on screen |
|---|---|---|
| 0–3 | Hook: a persona caving (from Test 0) | "great point, that's really clear!" |
| 3–6 | The product: Blitzen and the pyramid, why answer-first matters | the empty pyramid |
| 6–11 | Live round: Jean starts with background on purpose, then gets it right | gate: `concede(answer)` **⛔ blocked · not first**, then the pyramid fills |
| 11–13 | Round card: time to your answer, one habit | the card |
| 13–22 | Under the hood: K1 stake in state · K2 gate (~20 lines) · grounding (the model can't "hear" an answer you never gave) | code, `adk web` events |
| 22–26 | K4: cave rate, plain vs Blitzen; the 2 caught cave attempts | Test 0 + §7 numbers |
| 26–30 | Volunteer round, then "your playbook is already a sparring partner" + clone the repo | framework → kit table, repo QR |

---

## 11. Phases & gates

| Phase | Contents | Gate → next |
|---|---|---|
| **1. Prove it works for real** (next) | Test V (real mic), Test 0 (no-stake baseline + harder script) | **Go** if Test V passes and Test 0 gives a cave number. **Change** the hook if Test 0 fails. |
| **2. Make the feedback land** | Test A; K3 coach only if Test A fails; round 2 opening on the habit | **Go** if 3 fresh people complete two rounds unaided and 2/3 land the answer faster in round 2 |
| **3. Stage-proof** (final days) | Slides, backup recording, hotspot, `?demo=1` check, rehearsal | Full dress rehearsal **≤ 30 min**, on hotspot, with one stranger |

**Workstreams (through every phase):**
- **Thesis & evidence** — owns R0, R1, R3 (Tests 0 and A; the numbers on slides).
- **Live plumbing** — owns R2, R4, R5 (Test V, fallback, pre-flight).
- **Show** — owns R7 and the run of show.

---

## 12. Grain watch

The comfortable next move is adding more personas and polishing the UI. **Don't.** Try Blitzen with a real mic and get a cave number from a plain persona first.

---

## 13. Decisions & open questions

**Decided**
1. ✅ Builder talk, one product demo.
2. ✅ Separate repo: `devfest-voice-agent/`, package `sparring/`.
3. ✅ MVP = one persona: **Blitzen**, a communication sparring partner (pyramid principle), warm in tone. Not an engineering reviewer; the name is just a name.
4. ✅ Rule-based gate first (instant, explainable on a slide); LLM judge only in the offline cave test.

**Open**
1. ❓ DevFest date — sets every "by when" above.
2. 🟡 Talk title: *"Built A Friend?"* as the hook, subtitle *"Why LLM sparring partners cave, and how to stop them in code"*?
3. 🟡 Round 2: build "opens on your habit", or keep "Go again" as a fresh round for the MVP?
4. 🟡 Which second persona comes after the MVP: `think-concrete`, `think-derisk`, or the debugging-protocol partner?
