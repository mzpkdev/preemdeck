#!/usr/bin/env -S preemdeck-runtime
/**
 * install-tmux.ts — point the JetBrains terminal Shell path at preemdeck's `ideamux`
 * wrapper, so every IDE terminal lands in a per-repo tmux session WITHOUT touching
 * the user's shell rc. Configures the IDE, not the shell: the interactive shell
 * inside tmux stays whatever the user runs (tmux's default-shell = $SHELL).
 *
 * The setting lives in `<config>/options/terminal.xml` under the app component
 * `TerminalOptionsProvider`, as `<option name="shellPath" value="…"/>` (2023.2+;
 * legacy builds spell it `myShellPath`). This upserts that one option per detected
 * JetBrains config dir, backing the original file up to `<file>.bak` once so
 * `--restore` (or uninstall) can put it back.
 *
 * Two safety rails, because a bad shell path breaks the IDE terminal:
 *   1. A RUNNING IDE rewrites terminal.xml on exit and would clobber the edit, so
 *      the run refuses when any JetBrains IDE is up (override with --force).
 *   2. The `ideamux` wrapper itself execs the user's login shell when tmux is
 *      missing, so the terminal always opens even without tmux installed.
 *
 * Writes ride cmdore's effect(), so --dry-run reports every change without touching
 * a file. This is a user-run installer (not a hook); progress prints to stderr.
 */

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { defineCommand, effect, execute } from "cmdore"
import { ENV } from "../../../../../common/preemdeck"
import { resolveExecPaths } from "../core"

/** JetBrains config-dir names: `<Product><year>.<n>` (e.g. WebStorm2025.1); excludes `-backup`, service dirs. */
export const PRODUCT_DIR_RE =
    /^(?:WebStorm|IntelliJIdea|PyCharm|GoLand|PhpStorm|RubyMine|CLion|Rider|DataGrip|RustRover|AppCode|Aqua)\d{4}\.\d+$/i

/** True when `name` is a versioned JetBrains product config dir (not a backup or service dir). */
export const isProductDir = (name: string): boolean => PRODUCT_DIR_RE.test(name)

/** The JetBrains per-user config root for this platform: macOS "Application Support", else XDG `~/.config`. */
export const jetbrainsRoot = (platform: string, home: string, xdgConfigHome?: string): string => {
    if (platform === "darwin") {
        return join(home, "Library", "Application Support", "JetBrains")
    }
    return join(xdgConfigHome || join(home, ".config"), "JetBrains")
}

type DirLister = (root: string) => Promise<string[]>

const realLister: DirLister = async (root) => {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
}

/** Absolute paths to every versioned JetBrains product config dir under `root`; [] when the root is absent. */
export const discoverConfigDirs = async (root: string, list: DirLister = realLister): Promise<string[]> => {
    let names: string[]
    try {
        names = await list(root)
    } catch {
        return [] // no JetBrains root yet — nothing installed
    }
    return names
        .filter(isProductDir)
        .sort()
        .map((name) => join(root, name))
}

/** XML-escape a value destined for a double-quoted attribute. `&` first, so it can't double-escape. */
export const xmlEscapeAttr = (value: string): string =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

/** Reverse {@link xmlEscapeAttr} for comparing/reporting a captured attribute value. */
export const xmlUnescapeAttr = (value: string): string =>
    value.replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&")

/** The `value="…"` of a self-closing option tag (still escaped), or null when absent. */
export const extractValue = (tag: string): string | null => tag.match(/value="([^"]*)"/)?.[1] ?? null

/** Set/replace a self-closing tag's `value="…"` with the XML-escaped `value`. */
export const setValueAttr = (tag: string, value: string): string => {
    const escaped = xmlEscapeAttr(value)
    if (/value="[^"]*"/.test(tag)) {
        return tag.replace(/value="[^"]*"/, `value="${escaped}"`)
    }
    return tag.replace(/\s*\/>$/, ` value="${escaped}" />`)
}

const OPTION_RE = /<option\s+name="(?:shellPath|myShellPath)"[^>]*\/>/
const COMPONENT_OPEN_RE = /<component\s+name="TerminalOptionsProvider"\s*>/
const COMPONENT_SELF_RE = /<component\s+name="TerminalOptionsProvider"\s*\/>/

const skeleton = (optionTag: string): string =>
    `<application>\n  <component name="TerminalOptionsProvider">\n    ${optionTag}\n  </component>\n</application>\n`

/** Outcome of an upsert: the new XML, the previous shell path (unescaped) if any, and whether anything changed. */
export type Upsert = { xml: string; previous: string | null; changed: boolean }

/**
 * Upsert the terminal Shell path into a JetBrains terminal.xml, returning the new
 * document. Handles a missing/empty file (writes the skeleton), an existing
 * shellPath/myShellPath option (rewrites its value, reporting the old one), a
 * present-but-empty component (injects the option), and a component-less document
 * (injects the whole component before </application>). Idempotent: an option that
 * already points at `shellPath` returns `changed: false`.
 */
export const upsertShellPath = (xml: string | null, shellPath: string): Upsert => {
    const optionTag = `<option name="shellPath" value="${xmlEscapeAttr(shellPath)}" />`
    if (xml === null || xml.trim() === "") {
        return { xml: skeleton(optionTag), previous: null, changed: true }
    }
    const existing = xml.match(OPTION_RE)
    if (existing) {
        const previous = xmlUnescapeAttr(extractValue(existing[0]) ?? "")
        if (previous === shellPath) {
            return { xml, previous, changed: false }
        }
        return { xml: xml.replace(OPTION_RE, setValueAttr(existing[0], shellPath)), previous, changed: true }
    }
    if (COMPONENT_OPEN_RE.test(xml)) {
        return {
            xml: xml.replace(COMPONENT_OPEN_RE, (open) => `${open}\n    ${optionTag}`),
            previous: null,
            changed: true
        }
    }
    if (COMPONENT_SELF_RE.test(xml)) {
        const expanded = `<component name="TerminalOptionsProvider">\n    ${optionTag}\n  </component>`
        return { xml: xml.replace(COMPONENT_SELF_RE, expanded), previous: null, changed: true }
    }
    if (/<\/application>/.test(xml)) {
        const component = `  <component name="TerminalOptionsProvider">\n    ${optionTag}\n  </component>\n`
        return { xml: xml.replace(/<\/application>/, `${component}</application>`), previous: null, changed: true }
    }
    return { xml: skeleton(optionTag), previous: null, changed: true }
}

/** Remove ONLY the shell-path option this installer added (value === `shellPath`); leave a user's own untouched. */
export const removeShellPathOption = (xml: string, shellPath: string): string => {
    const re = /[ \t]*<option\s+name="(?:shellPath|myShellPath)"[^>]*\/>\n?/g
    return xml.replace(re, (tag) => (xmlUnescapeAttr(extractValue(tag) ?? "") === shellPath ? "" : tag))
}

/** Absolute path to the deployed `ideamux` wrapper under ~/.preemdeck. */
export const ideamuxPath = (): string => join(ENV.PREEMDECK_ROOT, "src/ripperdoc/dock/idea/toolbox/ideamux")

const exists = (path: string): Promise<boolean> => Bun.file(path).exists()

/** Upsert one terminal.xml, backing the original up to `.bak` once. Reports what changed on stderr. */
const applyOne = async (file: string, shellPath: string): Promise<boolean> => {
    const current = await readFile(file, "utf8").catch(() => null)
    const { xml, previous, changed } = upsertShellPath(current, shellPath)
    if (!changed) {
        process.stderr.write(`install-tmux: ${file} already points at ideamux\n`)
        return false
    }
    await effect(async () => {
        await mkdir(dirname(file), { recursive: true })
        if (current !== null && !(await exists(`${file}.bak`))) {
            await copyFile(file, `${file}.bak`)
        }
        await writeFile(file, xml)
    })
    const was = previous ? ` (was ${previous})` : current === null ? " (created)" : ""
    process.stderr.write(`install-tmux: set shellPath in ${file}${was}\n`)
    return true
}

/** Undo one terminal.xml: restore its `.bak` if present, else strip only the option we added. */
const restoreOne = async (file: string, shellPath: string): Promise<boolean> => {
    if (await exists(`${file}.bak`)) {
        await effect(async () => {
            await copyFile(`${file}.bak`, file)
            await rm(`${file}.bak`)
        })
        process.stderr.write(`install-tmux: restored ${file} from .bak\n`)
        return true
    }
    const current = await readFile(file, "utf8").catch(() => null)
    if (current === null) {
        return false
    }
    const stripped = removeShellPathOption(current, shellPath)
    if (stripped === current) {
        return false
    }
    await effect(() => writeFile(file, stripped))
    process.stderr.write(`install-tmux: removed ideamux shellPath from ${file}\n`)
    return true
}

const command = defineCommand({
    name: "install-tmux",
    description: "Point the JetBrains terminal Shell path at preemdeck's ideamux (per-repo tmux); --restore to undo.",
    options: [
        { name: "restore", arity: 0, description: "undo: restore terminal.xml from .bak (or strip the added option)" },
        {
            name: "force",
            arity: 0,
            description: "proceed even while a JetBrains IDE is running (it may clobber the edit)"
        }
    ],
    run: async ({ restore, force }) => {
        const home = process.env.HOME ?? homedir()
        const root = jetbrainsRoot(process.platform, home, process.env.XDG_CONFIG_HOME)
        const shellPath = ideamuxPath()

        if (!restore && !force) {
            const running = await resolveExecPaths().catch(() => [])
            if (running.length > 0) {
                process.stderr.write(
                    `install-tmux: ${running.length} JetBrains IDE(s) running; a running IDE rewrites terminal.xml on exit.\n` +
                        "Close the IDE(s) and re-run, or pass --force to override.\n"
                )
                process.exit(1)
            }
        }

        const dirs = await discoverConfigDirs(root)
        if (dirs.length === 0) {
            process.stderr.write(`install-tmux: no JetBrains config dirs under ${root}\n`)
            return
        }

        let touched = 0
        for (const dir of dirs) {
            const file = join(dir, "options", "terminal.xml")
            touched += (restore ? await restoreOne(file, shellPath) : await applyOne(file, shellPath)) ? 1 : 0
        }
        process.stderr.write(
            `install-tmux: ${restore ? "restored" : "configured"} ${touched}/${dirs.length} config dir(s)\n`
        )
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
