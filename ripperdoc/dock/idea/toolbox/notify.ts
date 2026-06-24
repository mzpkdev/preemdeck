#!/usr/bin/env bun
/**
 * notify.ts — pop an in-IDE notification balloon in the running JetBrains IDE.
 *
 * A sibling to openUrl: instead of opening a tab, it raises a transient
 * notification balloon via the platform's Notification API, driven through the
 * same ideScript bridge. On the EDT it constructs a Notification(group, title,
 * content, type) and hands it to Notifications.Bus.notify(n, project). The group
 * id is "idea.toolbox"; the NotificationType is chosen from a whitelist (never
 * interpolated from raw user input) and filled in as a bare enum token.
 *
 * The balloon can carry clickable action buttons from a vetted registry
 * (NOTIFICATION_ACTIONS) via the repeatable `--action name[=arg]` flag.
 * "open-preview" reuses the SAME shared webpreviewOpenBody fragment as previewUrl
 * so the two can't drift. The action `name` is whitelisted; the `arg` is escaped;
 * the label is a static registry string. title/content/each action arg are
 * embedded as escaped Groovy string literals via escapeGroovy.
 *
 * Execution rides core's runGroovy scaffolding, which NEVER rejects: a missing
 * live IDE / unimplemented platform / spawn error is swallowed with a short
 * stderr note. The CLI is a cmdore commandless command: cmdore owns parsing,
 * help, the global flags, and exit codes. The whitelisted --type/--action are
 * validated by Standard Schemas (a bad value -> CmdoreError). main() wraps
 * execute() with onError:"throw" so it keeps the repo CLI shape (return a number;
 * process.exit only under the import.meta.main guard), gates a live IDE up front
 * (the inIdea gate), and maps IdeaError / CmdoreError to the notify: stderr line.
 */

import type { StandardSchemaV1 } from "cmdore"
import { CmdoreError, defineCommand, effect, execute } from "cmdore"
import type { Action } from "../../../../lib/args.ts"
import { IdeaError } from "./core/errors.ts"
import { escapeGroovy, inIdea, runGroovy as rawRunGroovy, webpreviewOpenBody } from "./core/index.ts"

const PROG = "notify"

/** cmdore metadata for the commandless CLI; version mirrors the idea plugin manifest. */
const METADATA = {
  name: PROG,
  version: "0.1.0",
  description: "Pop an in-IDE notification balloon in the running JetBrains IDE.",
} as const

/** The notification group id the balloon registers under. */
export const NOTIFY_GROUP_ID = "idea.toolbox"

/**
 * Allowed --type tokens -> the NotificationType enum constant to embed (a bare
 * Groovy token, never raw input).
 */
export const NOTIFICATION_TYPES: Record<string, string> = {
  info: "INFORMATION",
  warning: "WARNING",
  error: "ERROR",
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
  "open-preview": ["Open preview", true, OPEN_PREVIEW_BODY],
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
    renderActions(actions),
  )
}

/**
 * The write side-effect, wrapped as a cmdore `effect.fn` so it is skipped on
 * `--dry-run` (when cmdore flips `effect.enabled` off) and mockable in tests by
 * the WRAPPER REFERENCE (`effect.mock(runGroovy, …)`) — no per-file mutable seam.
 * runGroovy itself NEVER rejects: it degrades a missing IDE / spawn error to a
 * stderr note. The IDE Groovy bridge is the toolbox's one pure write.
 */
export const runGroovy = effect.fn(rawRunGroovy, "ide.runGroovy")

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
  await runGroovy(groovyFor(title, message, typeToken, actions), "notify: could not pop notification")
}

/**
 * A Standard Schema for the whitelisted `--type` token. cmdore hands it the raw
 * arity-1 string; an off-whitelist value fails validation, which cmdore surfaces
 * as a CmdoreError carrying this message.
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
    },
  },
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
 * each, short-circuiting to a CmdoreError on the first bad entry.
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
    },
  },
}

/**
 * The cmdore command behind the CLI. Gates on a live IDE (cheap fail-fast before
 * runGroovy's deeper launcher resolution), then pops the balloon for `message`
 * with the validated title/type/actions.
 */
const notifyCommand = defineCommand({
  name: PROG,
  description: METADATA.description,
  arguments: [{ name: "message", description: "the balloon message", required: true }],
  options: [
    { name: "title", arity: 1, hint: "title", description: "balloon title", defaultValue: () => "PreemDeck" },
    {
      name: "type",
      arity: 1,
      hint: "info|warning|error",
      description: "notification type",
      defaultValue: () => "info",
      schema: typeSchema,
    },
    {
      name: "action",
      hint: "name[=arg]",
      description: "add a clickable balloon action (repeatable)",
      defaultValue: () => [] as Action[],
      schema: actionsSchema,
    },
  ],
  run: async ({ message, title, type, action }) => {
    if (!inIdea()) {
      throw new IdeaError("no JetBrains IDE in the process ancestry")
    }
    await notify(message, { title, typeToken: type, actions: action })
  },
})

/**
 * CLI entrypoint. Hands argv to cmdore (parsing, help, global flags), then maps
 * the two domain failures to the notify: stderr line and their exit codes:
 * IdeaError -> 1, CmdoreError (bad flag / missing message / off-whitelist
 * --type/--action) -> its own exitCode. Anything else is a bug and rethrown.
 */
export const main = async (argv: string[] = Bun.argv.slice(2)): Promise<number> => {
  try {
    await execute(notifyCommand, { argv, metadata: METADATA, onError: "throw" })
  } catch (error) {
    if (error instanceof IdeaError) {
      process.stderr.write(`${PROG}: ${error.message}\n`)
      return 1
    }
    if (error instanceof CmdoreError) {
      process.stderr.write(`${PROG}: ${error.message}\n`)
      return error.exitCode
    }
    throw error
  }
  return 0
}

if (import.meta.main) {
  const code = await main(Bun.argv.slice(2))
  process.exit(code)
}
