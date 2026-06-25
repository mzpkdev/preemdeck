#!/usr/bin/env bun
import type { StandardSchemaV1 } from "cmdore"
import { defineCommand, effect, execute } from "cmdore"
import type { Action } from "../../../../lib/args.ts"
import { assertIdea } from "./assert-idea.ts"
import { escapeGroovy, runGroovy, webpreviewOpenBody } from "./core/index.ts"

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
// zero-or-more rendered n.addAction(...) lines (empty when no --action, leaving
// the render byte-identical to the action-less path).
const groovyNotify = (group: string, title: string, content: string, type: string, actions: string): string => {
    return `import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationType
import com.intellij.notification.Notifications
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager

ApplicationManager.getApplication().invokeLater {
    def projects = ProjectManager.getInstance().getOpenProjects()
    def project = projects.length > 0 ? projects[0] : null
    def n = new Notification("${group}", "${title}", "${content}", NotificationType.${type})${actions}
    Notifications.Bus.notify(n, project)
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

/** Render the notification Groovy for title/message/typeToken/actions. */
export const groovyFor = (title: string, message: string, typeToken: string, actions: Action[] = []): string => {
    const constant = NOTIFICATION_TYPES[typeToken]
    if (constant === undefined) {
        throw new Error(`unknown type ${typeToken}`) // programming error: CLI only passes whitelisted tokens
    }
    return groovyNotify(
        escapeGroovy(NOTIFY_GROUP_ID),
        escapeGroovy(title),
        escapeGroovy(message),
        constant,
        renderActions(actions)
    )
}

/** Options for {@link notify}: balloon title, the --type token (info/warning/error), and the action registry entries. */
export type NotifyOptions = {
    title?: string
    typeToken?: string
    actions?: Action[]
}

/** Pop an in-IDE notification balloon for `message` in the running IDE (best-effort). */
export const notify = async (message: string, options: NotifyOptions = {}): Promise<void> => {
    const title = options.title ?? "PreemDeck"
    const typeToken = options.typeToken ?? "info"
    const actions = options.actions ?? []
    // runGroovy never rejects (it degrades a missing IDE / spawn error to a stderr
    // note); --dry-run flips effect off so the IDE write is skipped.
    await effect(() => runGroovy(groovyFor(title, message, typeToken, actions), "notify: could not pop notification"))
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
        }
    ],
    run: async ({ message, title, type, action }) => {
        assertIdea()
        await notify(message, { title, typeToken: type, actions: action })
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
