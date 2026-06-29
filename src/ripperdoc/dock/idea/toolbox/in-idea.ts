#!/usr/bin/env bun
import { defineCommand, execute } from "cmdore"
import { inIdea } from "./core"

// A detector, not a gate: it REPORTS whether this terminal runs inside a
// JetBrains IDE rather than asserting it. The exit code is the answer — 0
// inside, 1 outside — so it doubles as a shell gate; without -q it also prints a
// human line. "outside" is a valid result, not a failure, so run() drives the
// exit code via process.exit(1) instead of throwing.
//
// -q is this CLI's own `silent` option (alias q), NOT cmdore's global --quiet:
// it suppresses the human line. cmdore's --quiet mutes its own output only and
// never touches the exit code, so the gate survives it either way.

const command = defineCommand({
    name: "in-idea",
    description: "Report whether this terminal is running inside a JetBrains IDE.",
    options: [{ name: "silent", alias: "q", arity: 0, description: "no output; gate on the exit code only" }],
    run: ({ silent }) => {
        const inside = inIdea()
        if (!silent) {
            console.log(inside ? "in a JetBrains IDE terminal" : "not in a JetBrains IDE terminal")
        }
        if (!inside) {
            process.exit(1)
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
