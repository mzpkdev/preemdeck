# Prompting Best Practices

How we write system prompts and agent harnesses. Cross-lab consensus plus the patterns worth stealing, turned into
rules.

______________________________________________________________________

## Start simple, escalate on evidence

Begin with the simplest prompt that could work. Add agentic complexity — planning, tools, multi-agent — only when
simpler approaches demonstrably fail. Agents trade latency and cost for capability; pay that price when the task earns
it.

| Reach for    | When                                                              |
| ------------ | ----------------------------------------------------------------- |
| **Workflow** | Predictable task, known steps — predefined code paths orchestrate |
| **Agent**    | Open-ended task, flexibility at scale — the model directs control |

A workflow is code that calls the model at fixed points. An agent is the model deciding what to do next. Ship the
workflow until it can't bend to the task
([Anthropic — Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)).

______________________________________________________________________

## Don't shout at the model

On current reasoning models (Claude Opus 4.5/4.6, GPT-5), aggressive imperatives cause over-triggering — the model fires
a tool or behavior far more than you wanted. Contradictory or vague instructions are worse: the model burns reasoning
tokens trying to reconcile them. Soften the force, de-conflict the rules.

```text
# Avoid
CRITICAL: You MUST use this tool when the user asks about pricing.
If in doubt, use [tool].

# Prefer
Use this tool when the user asks about pricing.
```

Drop the "if in doubt" line entirely — it manufactures the doubt it claims to resolve. A wrong-but-single instruction
beats two instructions that fight each other
([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices),
[OpenAI GPT-5](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)).

______________________________________________________________________

## Structure the prompt

Split the prompt into explicitly delimited sections — XML tags (`<instructions>`, `<context>`, `<input>`) or Markdown
headers. Lead with Role and Objective so the model knows who it is and what it's for before it reads anything else.

OpenAI's GPT-4.1 section ordering, top to bottom:

- Role / Objective
- Instructions
- Reasoning Steps
- Output Format
- Examples
- Context
- A final "think step by step" line

Pitch instructions at the right altitude — specific enough to guide, loose enough to generalize.

```text
# Avoid — too rigid, brittle on the first unseen case
If the file ends in .py, run black; if .js, run prettier; if .go, run gofmt; ...

# Avoid — too vague, the model guesses
Format the code nicely.

# Prefer — right altitude
Format each file with the project's configured formatter before saving.
```

Cite
([Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
[OpenAI GPT-4.1](https://cookbook.openai.com/examples/gpt4-1_prompting_guide)).

______________________________________________________________________

## Put the query last (long context)

Place large documents and data at the TOP of the prompt; put the specific query and instructions at the END. In
Anthropic's tests this ordering buys up to ~30% quality on long-context tasks. For very long context, repeat the
instructions at BOTH the top and the bottom.

```text
<documents>
  <document>
    ID: 1 | TITLE: Q3 Report | CONTENT: ...
  </document>
  ...
</documents>

Now answer the question below using only the documents above.
<question>...</question>
```

Wrap documents in XML or pipe-delimited `ID | TITLE | CONTENT` records. JSON performs poorly as a document wrapper — the
syntax noise costs more than the structure buys
([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices),
[OpenAI GPT-4.1](https://cookbook.openai.com/examples/gpt4-1_prompting_guide),
[Lost in the Middle](https://arxiv.org/abs/2307.03172)).

______________________________________________________________________

## Spend context like a budget

Context is finite and returns diminish as it fills. Curate the smallest high-signal token set, not the largest one you
can fit. The same discipline governs tools: each must be self-contained, robust to bad input, and unambiguous in scope.

Bloated tool sets with overlapping functions are the top agent failure mode — if a human can't tell which tool applies,
the agent can't either.

For long-horizon work, three techniques keep the budget under control:

| Technique            | What it does                                                                  |
| -------------------- | ----------------------------------------------------------------------------- |
| **Compaction**       | Near the context limit, summarize the thread and reinitialize from it         |
| **Structured notes** | Write state to external memory the agent reads back later                     |
| **Sub-agents**       | Explore wide in a child context; return a condensed 1,000–2,000 token summary |

Cite
([Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
[Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents),
[Long-running agent harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)).

______________________________________________________________________

## Steer agent eagerness

Autonomy is a dial, not a switch. Three "agentic reminders" moved GPT-4.1 ~20% on SWE-bench Verified — persistence
("keep going until the query is fully resolved before yielding"), tool-calling guidance, and explicit planning. Planning
alone accounted for ~4%.

- On reasoning models, tune the `reasoning_effort` parameter to match task difficulty — high for hard multi-step work,
  low for routine calls.
- Pass prior reasoning traces back across turns instead of forcing the model to rebuild its plan from scratch. OpenAI
  saw Tau-Bench Retail climb 73.9% → 78.2% doing exactly this.

Cite ([OpenAI GPT-4.1](https://cookbook.openai.com/examples/gpt4-1_prompting_guide),
[OpenAI GPT-5](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)).

______________________________________________________________________

## Orchestration patterns

Five primitives compose into most agent systems. Start with the simplest that fits.

| Pattern                  | Shape                                                             |
| ------------------------ | ----------------------------------------------------------------- |
| **Prompt chaining**      | Sequential steps; each output feeds the next input                |
| **Routing**              | Classify the input, dispatch to a specialist handler              |
| **Parallelization**      | Run sub-tasks at once — sectioning the work or voting across runs |
| **Orchestrator-workers** | Central LLM decomposes, delegates to workers, synthesizes results |
| **Evaluator-optimizer**  | Generator drafts, critic scores, loop until the bar is met        |

Reasoning-agent patterns layer on top:

- **ReAct** — interleave reasoning and tool actions; grounding the model in real observations cuts hallucination versus
  chain-of-thought alone ([Yao et al.](https://arxiv.org/abs/2210.03629)).
- **Reflexion** — the agent reflects on failures in words and stores the reflection in episodic memory, improving across
  trials ([Shinn et al.](https://arxiv.org/abs/2303.11366)).
- **Self-critique / competing hypotheses** — track confidence and keep a hypothesis tree or notes file the agent revises
  as evidence arrives
  ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).

The five primitives come from
([Anthropic — Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)).

______________________________________________________________________

## Gotchas — looks right, isn't

| Looks right                        | Reality                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| "Always add few-shot examples"     | Google's "always" guidance doesn't hold — treat examples as optional, add when they earn their tokens |
| All-caps `CRITICAL: YOU MUST`      | Over-triggers current models — soften the imperative                                                  |
| Wrap long-context docs in JSON     | Performs poorly — use XML or pipe-delimited records                                                   |
| One big tool that does everything  | Bloated, overlapping tools are the top agent failure mode — keep them narrow and unambiguous          |
| Vendor benchmark numbers as gospel | Self-reported single evals — trust the direction, not the exact magnitude                             |

______________________________________________________________________

## Quick checklist

```
Escalate     ── simplest prompt first; add agents only when simpler fails
Tone         ── soften imperatives; de-conflict; contradictions waste reasoning
Structure    ── delimited sections, Role first, right altitude
Query last   ── docs at top, query at bottom; repeat both ends if very long
Budget       ── smallest high-signal context; narrow tools; compact / notes / sub-agents
Eagerness    ── tune persistence + planning + reasoning_effort; replay prior traces
Orchestrate  ── chaining / routing / parallel / orchestrator-workers / evaluator-optimizer
Gotchas      ── examples optional · no shouting · no JSON wrappers · narrow tools · benchmarks are directional
```
