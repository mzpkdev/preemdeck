#!/usr/bin/env -S preemdeck-runtime
/**
 * install-acp.ts — pin the JetBrains ACP config so the IDE keeps launching Claude
 * Code as an agent server after node/npx moves (an nvm switch, a version bump).
 *
 * The IDE reads `~/.jetbrains/acp.json` to spawn the ACP adapter; the stored
 * `agent_servers."Claude Code".command` is an ABSOLUTE npx path that goes stale
 * whenever the active npx changes. This resolves the current npx and rewrites that
 * one entry, preserving every other key in the file. Idempotent: an entry already
 * pointing at the current npx is left untouched.
 *
 * Ported from references/preemclaud's ensure_acp.py SessionStart hook, reshaped as
 * a manual installer (matching install-tmux): running it is the opt-in, so the
 * JetBrains-terminal env guard is dropped. --restore removes the entry (or restores
 * the .bak); --dry-run reports without writing. Best-effort progress on stderr.
 */

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { defineCommand, effect, execute } from "cmdore"

/** The agent-server key this installer owns in acp.json. */
export const AGENT_NAME = "Claude Code"
/** The ACP adapter the entry launches (Zed's Claude Code ACP bridge). */
export const ACP_ARGS: readonly string[] = ["@zed-industries/claude-agent-acp"]

/** Path to the JetBrains ACP config for `home`. */
export const acpPath = (home: string): string => join(home, ".jetbrains", "acp.json")

/** The full agent-server entry pinned to `npxPath` (command + fixed args + empty env). */
export type AcpEntry = { command: string; args: string[]; env: Record<string, string> }
export const buildEntry = (npxPath: string): AcpEntry => ({ command: npxPath, args: [...ACP_ARGS], env: {} })

type Dict = Record<string, unknown>
const isDict = (value: unknown): value is Dict => value !== null && typeof value === "object" && !Array.isArray(value)

/** Parse acp.json text into a plain object; {} on empty, non-object, or invalid JSON (fail-open). */
export const parseConfig = (text: string | null): Dict => {
    if (text === null || text.trim() === "") {
        return {}
    }
    try {
        const data: unknown = JSON.parse(text)
        return isDict(data) ? data : {}
    } catch {
        return {}
    }
}

/** The current `command` of the Claude Code entry, or null when absent/malformed. */
export const currentCommand = (config: Dict): string | null => {
    const servers = config.agent_servers
    if (!isDict(servers)) {
        return null
    }
    const entry = servers[AGENT_NAME]
    return isDict(entry) && typeof entry.command === "string" ? entry.command : null
}

export type Upsert = { config: Dict; previous: string | null; changed: boolean }

/**
 * Upsert the Claude Code agent-server entry to point at `npxPath`, preserving every
 * other key. Idempotent on the COMMAND (mirrors ensure_acp.py): an entry already at
 * `npxPath` returns changed:false; any other command (or a missing entry) rewrites
 * the entry to the default shape.
 */
export const upsertClaudeCode = (config: Dict, npxPath: string): Upsert => {
    const previous = currentCommand(config)
    if (previous === npxPath) {
        return { config, previous, changed: false }
    }
    const servers = isDict(config.agent_servers) ? config.agent_servers : {}
    return {
        config: { ...config, agent_servers: { ...servers, [AGENT_NAME]: buildEntry(npxPath) } },
        previous,
        changed: true
    }
}

/** Remove the Claude Code entry (and an emptied agent_servers), preserving other keys. */
export const stripClaudeCode = (config: Dict): { config: Dict; changed: boolean } => {
    const servers = config.agent_servers
    if (!isDict(servers) || !(AGENT_NAME in servers)) {
        return { config, changed: false }
    }
    const nextServers: Dict = { ...servers }
    delete nextServers[AGENT_NAME]
    const next: Dict = { ...config }
    if (Object.keys(nextServers).length === 0) {
        delete next.agent_servers
    } else {
        next.agent_servers = nextServers
    }
    return { config: next, changed: true }
}

const serialize = (config: Dict): string => `${JSON.stringify(config, null, 2)}\n`
const exists = (path: string): Promise<boolean> => Bun.file(path).exists()

/** Pin the entry, backing the original up to `.bak` once. */
const applyAcp = async (file: string, npxPath: string): Promise<void> => {
    const current = await readFile(file, "utf8").catch(() => null)
    const { config, previous, changed } = upsertClaudeCode(parseConfig(current), npxPath)
    if (!changed) {
        process.stderr.write(`install-acp: ${file} already pins npx (${npxPath})\n`)
        return
    }
    await effect(async () => {
        await mkdir(dirname(file), { recursive: true })
        if (current !== null && !(await exists(`${file}.bak`))) {
            await copyFile(file, `${file}.bak`)
        }
        await writeFile(file, serialize(config))
    })
    const was = previous ? ` (was ${previous})` : current === null ? " (created)" : ""
    process.stderr.write(`install-acp: pinned "${AGENT_NAME}" to ${npxPath}${was}\n`)
}

/** Undo: restore the `.bak` if present, else strip only the Claude Code entry. */
const restoreAcp = async (file: string): Promise<void> => {
    if (await exists(`${file}.bak`)) {
        await effect(async () => {
            await copyFile(`${file}.bak`, file)
            await rm(`${file}.bak`)
        })
        process.stderr.write(`install-acp: restored ${file} from .bak\n`)
        return
    }
    const current = await readFile(file, "utf8").catch(() => null)
    if (current === null) {
        process.stderr.write(`install-acp: nothing to restore (${file} absent)\n`)
        return
    }
    const { config, changed } = stripClaudeCode(parseConfig(current))
    if (!changed) {
        process.stderr.write(`install-acp: no "${AGENT_NAME}" entry in ${file}\n`)
        return
    }
    await effect(() => writeFile(file, serialize(config)))
    process.stderr.write(`install-acp: removed "${AGENT_NAME}" from ${file}\n`)
}

const command = defineCommand({
    name: "install-acp",
    description:
        "Pin ~/.jetbrains/acp.json's Claude Code command to the current npx (JetBrains ACP); --restore to undo.",
    options: [
        { name: "restore", arity: 0, description: "undo: restore acp.json from .bak, or strip the Claude Code entry" }
    ],
    run: async ({ restore }) => {
        const file = acpPath(process.env.HOME ?? homedir())
        if (restore) {
            await restoreAcp(file)
            return
        }
        const npx = Bun.which("npx")
        if (npx === null) {
            process.stderr.write("install-acp: npx not found on PATH; cannot pin the ACP command\n")
            process.exit(1)
        }
        await applyAcp(file, npx)
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
