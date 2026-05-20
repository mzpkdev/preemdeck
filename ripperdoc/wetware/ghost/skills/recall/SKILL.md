---
name: recall
description: |
  Search ghost's long-term memory for facts about the user.
  Trigger when the user references shared history or asks if you know something about
  them: 'remember that', 'we talked about', 'you know about my', 'as I mentioned',
  'last time', 'what do you know about me', or similar paraphrases.
  Do NOT trigger for general questions, code, or technical tasks.
user-invocable: false
allowed-tools: [Bash]
---

# Recall

Search long-term memory for facts about the user.

## How to run

1. Extract a short keyword query from the user's message — strip trigger phrases ('remember that', 'we talked about',
   etc.), keep the nouns and subjects. Example: "do you remember my cat" → query: `cat`.

2. Run the FTS5 search:

```bash
sqlite3 ~/.claude/.cache/.ghost_cortex.db \
  "SELECT memory FROM memories_fts WHERE memories_fts MATCH '<query>' ORDER BY rank LIMIT 5" \
  2>/dev/null
```

If the DB does not exist or the query returns no rows, that is a valid empty result.

## What to return

- If hits found: bullet list of matching memories, max 5.
- If nothing found: one line — `Nothing found in memory for that.`

Do not explain the mechanism. Just surface the facts.

## Critical

Do NOT announce or narrate this skill invocation. No "let me check my memory", no "searching my records", no "I recall
that". Retrieve silently. Use the facts naturally in your response as if you simply knew them.
