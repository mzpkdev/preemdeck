#!/usr/bin/env bun
import type { StandardSchemaV1 } from "cmdore"
import { defineCommand, effect, execute } from "cmdore"
import { assertIdea } from "./assert-idea.ts"
import {
    escapeGroovy,
    groovyProjectByCwd,
    resolveExecPaths,
    runGroovy,
    runGroovyOn,
    webpreviewOpenBody
} from "./core/index.ts"

/** One parsed `--action`: its `name`, and the `=arg` payload (`null` when bare). */
export type Action = { name: string; arg: string | null }

/** The notification group id the balloon registers under. */
export const NOTIFY_GROUP_ID = "idea.toolbox"

/**
 * Allowed --type tokens -> the NotificationType enum constant to embed (a bare
 * Groovy token, never raw input).
 */
export const NOTIFICATION_TYPES: Record<string, string> = {
    info: "INFORMATION",
    warning: "WARNING",
    error: "ERROR"
}

// Closure-body locals are prefixed `action*` so re-fetching the project INSIDE
// the closure does not re-declare `projects`/`project` from the enclosing
// invokeLater scope (a Groovy compile error). {arg} is the escaped CLI arg slot.
const OPEN_FILE_BODY = `def actionProjects = com.intellij.openapi.project.ProjectManager.getInstance().getOpenProjects()
if (actionProjects.length == 0) return
def actionProject = actionProjects[0]
def vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath("{arg}")
if (vf == null) return
com.intellij.openapi.fileEditor.FileEditorManager.getInstance(actionProject).openFile(vf, true)`

// The "open-preview" closure body: fetch the project under action*-prefixed names
// (so it doesn't shadow the enclosing invokeLater scope), then splice in the
// shared WebPreview-open fragment (parity with previewUrl), pointed at that
// re-fetched project. {arg} is the URL; the tab title reuses the same URL literal.
// Built by passing the literal "{arg}" sentinel through webpreviewOpenBody so the
// slot lands in BOTH the url and title positions, then substituted at render time.
const OPEN_PREVIEW_BODY = `def actionProjects = com.intellij.openapi.project.ProjectManager.getInstance().getOpenProjects()
if (actionProjects.length == 0) return
def actionProject = actionProjects[0]
${webpreviewOpenBody("{arg}", "{arg}", { projectVar: "actionProject" })}`

// Registry entry: [label, needsArg, body]. label is a static registry string
// (NOT user input); body's {arg} slot is filled with the escaped CLI arg.
type ActionEntry = [label: string, needsArg: boolean, body: string]

/**
 * Vetted registry of clickable balloon actions, keyed by the `--action` name. Each
 * entry is `[label, needsArg, body]`; only these whitelisted names may run, so a
 * caller never injects arbitrary Groovy.
 */
export const NOTIFICATION_ACTIONS: Record<string, ActionEntry> = {
    "open-url": ["Open in browser", true, 'com.intellij.ide.BrowserUtil.browse("{arg}")'],
    "open-file": ["Open file", true, OPEN_FILE_BODY],
    "open-preview": ["Open preview", true, OPEN_PREVIEW_BODY]
}

// Groovy run on the EDT against the live IntelliJ Platform API. {actions} is
// zero-or-more rendered n.addAction(...) lines (empty when no --action).
//
// Targeting (within ONE IDE process): this script always pops in a SINGLE window —
// the project whose basePath is the longest prefix of `cwd` (the window the
// terminal sits in), falling back to a null/application-level target, which
// IntelliJ routes to the focused frame. The `--all` broadcast lives a layer up:
// notify dispatches this same script to every running IDE's launcher (see
// runGroovyOn), so there is no all-windows branch here. The `fire` closure builds
// a FRESH Notification per call — a Notification is single-shot.
const groovyNotify = (
    group: string,
    title: string,
    content: string,
    type: string,
    actions: string,
    cwd: string
): string => {
    return `import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationType
import com.intellij.notification.Notifications
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager

ApplicationManager.getApplication().invokeLater {
    def fire = { target ->
        def n = new Notification("${group}", "${title}", "${content}", NotificationType.${type})${actions}
        Notifications.Bus.notify(n, target)
    }
    def projects = ProjectManager.getInstance().getOpenProjects()
    def cwd = "${cwd}"
${groovyProjectByCwd({ varName: "best", fallback: "null", indent: "    " })}
    fire(best)
}
`
}

/** Render one vetted action into its n.addAction(...) line, body {arg} slot escaped. */
const renderAction = (name: string, arg: string | null): string => {
    const entry = NOTIFICATION_ACTIONS[name]
    if (entry === undefined) {
        throw new Error(`unknown action ${name}`) // programming error: CLI only passes whitelisted names
    }
    const [label, , bodyTemplate] = entry
    const body = bodyTemplate.replaceAll("{arg}", escapeGroovy(arg ?? ""))
    // Indent a multi-line body so every statement sits inside the closure braces.
    const indented = body
        .split("\n")
        .map((line) => `        ${line}`)
        .join("\n")
    return `    n.addAction(NotificationAction.createSimple("${label}", {\n${indented}\n    } as Runnable))`
}

/** Render the parsed --action list to the {actions} block, in CLI order. */
const renderActions = (actions: Action[]): string => {
    if (actions.length === 0) {
        return ""
    }
    return `\n${actions.map(({ name, arg }) => renderAction(name, arg)).join("\n")}`
}

/**
 * Render the notification Groovy for title/message/typeToken/actions.
 *
 * `cwd` selects the target window (the project whose basePath is the longest
 * prefix of it) — escaped like every other literal so a path can't break out of
 * the Groovy string. The `--all` broadcast is handled at dispatch (one run of this
 * same script per running IDE), not in the rendered Groovy.
 */
export const groovyFor = (
    title: string,
    message: string,
    typeToken: string,
    actions: Action[] = [],
    cwd = ""
): string => {
    const constant = NOTIFICATION_TYPES[typeToken]
    if (constant === undefined) {
        throw new Error(`unknown type ${typeToken}`) // programming error: CLI only passes whitelisted tokens
    }
    return groovyNotify(
        escapeGroovy(NOTIFY_GROUP_ID),
        escapeGroovy(title),
        escapeGroovy(message),
        constant,
        renderActions(actions),
        escapeGroovy(cwd)
    )
}

/** Options for {@link notify}: balloon title, the --type token (info/warning/error), the action registry entries, the cwd used to target the terminal's window, and the all-windows broadcast toggle. */
export type NotifyOptions = {
    title?: string
    typeToken?: string
    actions?: Action[]
    /** Working directory used to pick the terminal's window (longest basePath prefix). Defaults to `process.cwd()`. */
    cwd?: string
    /** Broadcast one balloon to every running JetBrains IDE (deduped by launcher) instead of just the one that launched the terminal. */
    all?: boolean
}

/**
 * Pop an in-IDE notification balloon for `message` in the running JetBrains IDE.
 * The Groovy write is wrapped in `effect()` so `--dry-run` skips the real IDE
 * call; it is best-effort and never rejects (a missing IDE or spawn error degrades
 * to a stderr note).
 *
 * @param message - the balloon body text.
 * @param options - title, the `--type` token, and clickable actions; see {@link NotifyOptions}.
 * @returns nothing; resolves once the balloon Groovy has been dispatched.
 *
 * @example
 * await notify("Build finished") // plain info balloon titled "PreemDeck", in the terminal's window
 * await notify("Tests failed", { typeToken: "error", actions: [{ name: "open-file", arg: "log.txt" }] }) // error balloon with a clickable action
 * await notify("Deploy done", { all: true }) // one balloon in every running JetBrains IDE
 */
export const notify = async (message: string, options: NotifyOptions = {}): Promise<void> => {
    const title = options.title ?? "PreemDeck"
    const typeToken = options.typeToken ?? "info"
    const actions = options.actions ?? []
    const cwd = options.cwd ?? process.cwd()
    const all = options.all ?? false
    const groovy = groovyFor(title, message, typeToken, actions, cwd)
    const note = "notify: could not pop notification"
    // runGroovy / runGroovyOn never reject (a missing IDE / spawn error degrades to
    // a stderr note); --dry-run flips effect off so the IDE write is skipped.
    await effect(async () => {
        if (all) {
            // Broadcast: one balloon per running JetBrains IDE. Discovery degrades to
            // [] on any probe failure; an empty set (or the non-broadcast path) falls
            // back to the single ancestry binary so the balloon still pops locally.
            const execPaths = await resolveExecPaths()
            if (execPaths.length > 0) {
                await runGroovyOn(groovy, note, execPaths)
                return
            }
        }
        await runGroovy(groovy, note)
    })
}

/**
 * A Standard Schema for the whitelisted `--type` token. cmdore hands it the raw
 * arity-1 string; an off-whitelist value fails validation, which cmdore surfaces
 * as a CmdoreError (exit 2) carrying this message.
 */
const typeSchema: StandardSchemaV1<string> = {
    "~standard": {
        version: 1,
        vendor: "preemdeck",
        validate: (value: unknown) => {
            const raw = String(value)
            if (raw in NOTIFICATION_TYPES) {
                return { value: raw }
            }
            const allowed = Object.keys(NOTIFICATION_TYPES)
                .map((token) => `'${token}'`)
                .join(", ")
            return { issues: [{ message: `--type: invalid choice: '${raw}' (choose from ${allowed})` }] }
        }
    }
}

/**
 * Split + whitelist a single `--action` value into a vetted {@link Action}. The
 * value splits on the FIRST `=` only (so `=` inside a URL/path query survives);
 * an unknown name or a missing required arg yields an issue message.
 */
const parseAction = (value: string): { value: Action } | { message: string } => {
    const eq = value.indexOf("=")
    const name = eq === -1 ? value : value.slice(0, eq)
    const arg = eq === -1 ? null : value.slice(eq + 1)
    const entry = NOTIFICATION_ACTIONS[name]
    if (entry === undefined) {
        const allowed = Object.keys(NOTIFICATION_ACTIONS).sort().join(", ")
        return { message: `--action: unknown action '${name}' (choose from ${allowed})` }
    }
    if (entry[1] && (arg === null || arg.length === 0)) {
        return { message: `--action: action '${name}' needs an argument: --action ${name}=<value>` }
    }
    return { value: { name, arg } }
}

/**
 * A Standard Schema for the repeatable `--action` flag. cmdore accumulates the
 * repeated occurrences into a `string[]` (in CLI order); this validates + splits
 * each, short-circuiting to a CmdoreError (exit 2) on the first bad entry.
 */
const actionsSchema: StandardSchemaV1<Action[]> = {
    "~standard": {
        version: 1,
        vendor: "preemdeck",
        validate: (value: unknown) => {
            const raw = Array.isArray(value) ? (value as string[]) : []
            const out: Action[] = []
            for (const entry of raw) {
                const parsed = parseAction(entry)
                if ("message" in parsed) {
                    return { issues: [{ message: parsed.message }] }
                }
                out.push(parsed.value)
            }
            return { value: out }
        }
    }
}

const command = defineCommand({
    name: "notify",
    description: "Pop an in-IDE notification balloon in the running JetBrains IDE.",
    arguments: [{ name: "message", description: "the balloon message", required: true }],
    options: [
        { name: "title", arity: 1, hint: "title", description: "balloon title", defaultValue: () => "PreemDeck" },
        {
            name: "type",
            arity: 1,
            hint: "info|warning|error",
            description: "notification type",
            defaultValue: () => "info",
            schema: typeSchema
        },
        {
            name: "action",
            hint: "name[=arg]",
            description: "add a clickable balloon action (repeatable)",
            defaultValue: () => [] as Action[],
            schema: actionsSchema
        },
        {
            name: "all",
            arity: 0,
            description: "broadcast to every running JetBrains IDE (one balloon each), not just the launching one"
        }
    ],
    run: async ({ message, title, type, action, all }) => {
        assertIdea()
        await notify(message, { title, typeToken: type, actions: action, all })
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
