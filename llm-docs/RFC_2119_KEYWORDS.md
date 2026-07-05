# RFC 2119 Keywords

How we mark requirement levels in every markdown an LLM reads — prompts, skills, agents, hooks. Based on BCP 14 (RFC
2119 + RFC 8174). Keywords are **levels, not volume** — for emphasis rules see
[Prompting Best Practices](PROMPTING_BEST_PRACTICES.md).

---

## The keywords

Five levels. The RFC's synonyms are legal but we skip them — one word per level keeps the signal clean.

| Keyword    | Level                | Reader contract                                  |
| ---------- | -------------------- | ------------------------------------------------ |
| MUST       | absolute requirement | No exceptions. Violating output is wrong output. |
| MUST NOT   | absolute prohibition | Same force, inverted.                            |
| SHOULD     | strong default       | Deviate only for a concrete, weighed reason.     |
| SHOULD NOT | strong avoidance     | Same force, inverted.                            |
| MAY        | genuine freedom      | Either choice is compliant.                      |

Skipped synonyms: REQUIRED, SHALL (= MUST) · SHALL NOT (= MUST NOT) · RECOMMENDED (= SHOULD) · NOT RECOMMENDED (= SHOULD
NOT) · OPTIONAL (= MAY).

House additions: REQUIRED / OPTIONAL keep one narrow job — labeling inputs, fields, and arguments, never sentences.
ALWAYS / NEVER (not RFC words) mark every-case, every-turn rules.

---

## Case carries the force

RFC 8174: keywords are normative **only in ALL CAPS**. Lowercase "must" / "should" is plain English — use it freely when
you don't mean a requirement.

```text
# Avoid — accidental normativity, accidental softness
You should run the tests before committing. The hook Must exit 0.

# Prefer
You MUST run the tests before committing. A reader in a hurry should start at the checklist.
```

---

## Pick the level

Litmus-test the violation, not the wish. If you can name a legitimate exception, it is not a MUST.

| A violation would…                           | Level                     |
| -------------------------------------------- | ------------------------- |
| break the contract — you'd reject the output | MUST (NOT)                |
| make you ask "why did you do that?"          | SHOULD (NOT)              |
| go unnoticed                                 | MAY — or cut the sentence |

Name the escape hatch on a SHOULD when you know it: "Responses SHOULD fit one screen unless the user asked for a full
listing."

---

## Dose it — keywords are levels, not volume

RFC 2119 §6: imperatives are for interoperation and harm-limiting, not style preferences. Same failure mode as
[shouting](PROMPTING_BEST_PRACTICES.md): a doc where everything is MUST teaches the reader to ignore MUST.

- Plain imperative stays the default voice ("Run `bun test`."). Reach for a keyword only when the requirement **level
  itself** is information.
- One keyword per sentence, main clause, active voice: "The hook MUST exit 0."
- Don't stack levels in one sentence — split it.
- MAY is freedom, never politeness. Don't soften a real requirement into MAY.

```text
# Avoid — inflation drowns the one real requirement
You MUST read the file. You MUST prefer tables. You MUST be concise. You MUST exit 0 on success.

# Prefer — one contract, one default, plain steps
Read the file, then edit. Tables SHOULD replace comparison prose. The hook MUST exit 0 on success.
```

---

## Declaring the convention

In-repo docs carry no boilerplate — this file is the global declaration. A doc that leaves the repo (published skill,
standalone prompt) SHOULD carry the BCP 14 line:

```text
The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" in this document are to be
interpreted as described in BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in all capitals.
```

---

## Why LLMs respond to it

- **Trained prior** — models have read decades of RFC-styled specs; ALL-CAPS keywords bind as requirements, not
  decoration.
- **Compression** — "MUST" replaces "it is critically important that you always…" at a fraction of the tokens.
- **Conflict resolution** — graded levels give a tiebreak when instructions collide: MUST > SHOULD > MAY; the lower
  level yields.

---

## Quick checklist

```
Force        ── UPPERCASE only; lowercase must/should is plain prose (RFC 8174)
Vocabulary   ── MUST, MUST NOT, SHOULD, SHOULD NOT, MAY — synonyms skipped
MUST         ── no legitimate exception exists; violating output gets rejected
SHOULD       ── strong default; name the escape hatch when you know it
MAY          ── genuine freedom, never politeness
Dose         ── plain imperative by default; keyword only when the level is information
Inflation    ── an all-MUST doc teaches the reader to ignore MUST
Boilerplate  ── none in-repo; BCP 14 line when a doc leaves the repo
Conflicts    ── MUST > SHOULD > MAY; the lower level yields
```
