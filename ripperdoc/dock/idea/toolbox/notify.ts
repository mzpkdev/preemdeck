#!/usr/bin/env bun
/**
 * notify.ts — pop an in-IDE notification balloon in the running JetBrains IDE.
 * Behavior-identical TS port of notify.py (additive — the .py stays live).
 *
 * A sibling to open_url: instead of opening a tab, it raises a transient
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
 * Execution rides core's runGroovy scaffolding. Like its siblings it NEVER
 * throws: a missing live IDE / unimplemented platform / spawn error is swallowed
 * with a short stderr note. The CLI guards a live IDE up front (the inIdea gate).
 */

import { parseArgs } from "node:util";
import type { Action } from "../../../../lib/args.ts";
import { argparseError, argparseMessage } from "./_cli.ts";
import { IdeaError, NotImplementedError } from "./core/_errors.ts";
import { escapeGroovy, inIdea, runGroovy, webpreviewOpenBody } from "./core/index.ts";

const PROG = "notify.py";
const USAGE =
  "usage: notify.py [-h] [--title TITLE] [--type {info,warning,error}]\n                 [--action NAME[=ARG]]\n                 message";

// The notification group id the balloon registers under.
export const NOTIFY_GROUP_ID = "idea.toolbox";

// Allowed --type tokens -> the NotificationType enum constant to embed (a bare
// Groovy token, never raw input).
export const NOTIFICATION_TYPES: Record<string, string> = {
  info: "INFORMATION",
  warning: "WARNING",
  error: "ERROR",
};

// Closure-body locals are prefixed `action*` so re-fetching the project INSIDE
// the closure does not re-declare `projects`/`project` from the enclosing
// invokeLater scope (a Groovy compile error). {arg} is the escaped CLI arg slot.
const OPEN_FILE_BODY = `def actionProjects = com.intellij.openapi.project.ProjectManager.getInstance().getOpenProjects()
if (actionProjects.length == 0) return
def actionProject = actionProjects[0]
def vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath("{arg}")
if (vf == null) return
com.intellij.openapi.fileEditor.FileEditorManager.getInstance(actionProject).openFile(vf, true)`;

// The "open-preview" closure body: fetch the project under action*-prefixed names
// (so it doesn't shadow the enclosing invokeLater scope), then splice in the
// shared WebPreview-open fragment (parity with previewUrl), pointed at that
// re-fetched project. {arg} is the URL; the tab title reuses the same URL literal.
// Built by passing the literal "{arg}" sentinel through webpreviewOpenBody so the
// slot lands in BOTH the url and title positions, then substituted at render time.
const OPEN_PREVIEW_BODY = `def actionProjects = com.intellij.openapi.project.ProjectManager.getInstance().getOpenProjects()
if (actionProjects.length == 0) return
def actionProject = actionProjects[0]
${webpreviewOpenBody("{arg}", "{arg}", { projectVar: "actionProject" })}`;

// Registry entry: [label, needsArg, body]. label is a static registry string
// (NOT user input); body's {arg} slot is filled with the escaped CLI arg.
type ActionEntry = [label: string, needsArg: boolean, body: string];

export const NOTIFICATION_ACTIONS: Record<string, ActionEntry> = {
  "open-url": ["Open in browser", true, 'com.intellij.ide.BrowserUtil.browse("{arg}")'],
  "open-file": ["Open file", true, OPEN_FILE_BODY],
  "open-preview": ["Open preview", true, OPEN_PREVIEW_BODY],
};

// Groovy run on the EDT against the live IntelliJ Platform API. {actions} is
// zero-or-more rendered n.addAction(...) lines (empty when no --action, leaving
// the render byte-identical to the action-less path).
function groovyNotify(group: string, title: string, content: string, type: string, actions: string): string {
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
`;
}

/** Render one vetted action into its n.addAction(...) line, body {arg} slot escaped. */
function renderAction(name: string, arg: string | null): string {
  const entry = NOTIFICATION_ACTIONS[name];
  if (entry === undefined) {
    throw new Error(`unknown action ${name}`); // programming error: CLI only passes whitelisted names
  }
  const [label, , bodyTemplate] = entry;
  const body = bodyTemplate.replaceAll("{arg}", escapeGroovy(arg ?? ""));
  // Indent a multi-line body so every statement sits inside the closure braces.
  const indented = body
    .split("\n")
    .map((line) => `        ${line}`)
    .join("\n");
  return `    n.addAction(NotificationAction.createSimple("${label}", {\n${indented}\n    } as Runnable))`;
}

/** Render the parsed --action list to the {actions} block, in CLI order. */
function renderActions(actions: Action[]): string {
  if (actions.length === 0) {
    return "";
  }
  return `\n${actions.map(({ name, arg }) => renderAction(name, arg)).join("\n")}`;
}

/** Render the notification Groovy for title/message/typeToken/actions. */
export function groovyFor(title: string, message: string, typeToken: string, actions: Action[] = []): string {
  const constant = NOTIFICATION_TYPES[typeToken];
  if (constant === undefined) {
    throw new Error(`unknown type ${typeToken}`); // programming error: CLI only passes whitelisted tokens
  }
  return groovyNotify(
    escapeGroovy(NOTIFY_GROUP_ID),
    escapeGroovy(title),
    escapeGroovy(message),
    constant,
    renderActions(actions),
  );
}

// Engine seam: tests override `_internals.runGroovy` instead of mock.module on
// ./core (which leaks across the single `bun test` run). Production runs the real
// ideScript bridge.
export const _internals = { inIdea, runGroovy, notify };

export interface NotifyOptions {
  title?: string;
  typeToken?: string;
  actions?: Action[];
}

/** Pop an in-IDE notification balloon for `message` in the running IDE (best-effort). */
export async function notify(message: string, options: NotifyOptions = {}): Promise<void> {
  const title = options.title ?? "PreemDeck";
  const typeToken = options.typeToken ?? "info";
  const actions = options.actions ?? [];
  await _internals.runGroovy(groovyFor(title, message, typeToken, actions), "notify: could not pop notification");
}

/** argparse choices=() parity for --type: bad value -> exit 2 with the exact message. */
function validateType(raw: string): string {
  if (!(raw in NOTIFICATION_TYPES)) {
    argparseError(USAGE, PROG, `argument --type: invalid choice: '${raw}' (choose from 'info', 'warning', 'error')`);
  }
  return raw;
}

/** Split + whitelist a --action value, mirroring notify.py _validate_action (exit 2 on bad). */
function validateAction(value: string): Action {
  const eq = value.indexOf("=");
  const name = eq === -1 ? value : value.slice(0, eq);
  const arg = eq === -1 ? null : value.slice(eq + 1);
  const entry = NOTIFICATION_ACTIONS[name];
  if (entry === undefined) {
    const allowed = Object.keys(NOTIFICATION_ACTIONS).sort().join(", ");
    argparseError(USAGE, PROG, `argument --action: unknown action '${name}' (choose from ${allowed})`);
  }
  if (entry[1] && (arg === null || arg.length === 0)) {
    argparseError(USAGE, PROG, `argument --action: action '${name}' needs an argument: --action ${name}=<value>`);
  }
  return { name, arg };
}

export async function main(argv: string[] = Bun.argv.slice(2)): Promise<number> {
  const options = {
    title: { type: "string" },
    type: { type: "string" },
    action: { type: "string", multiple: true },
  } as const;
  let parsed: ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true });
  } catch (err) {
    argparseError(USAGE, PROG, argparseMessage(err));
  }
  const message = parsed.positionals[0];
  if (message === undefined) {
    argparseError(USAGE, PROG, "the following arguments are required: message");
  }
  if (parsed.positionals.length > 1) {
    argparseError(USAGE, PROG, `unrecognized arguments: ${parsed.positionals.slice(1).join(" ")}`);
  }
  const title = parsed.values.title ?? "PreemDeck";
  const typeToken = parsed.values.type !== undefined ? validateType(parsed.values.type) : "info";
  const actions = (parsed.values.action ?? []).map(validateAction);

  try {
    // Cheap CLI gate: fail fast/clean outside a JetBrains terminal.
    if (!_internals.inIdea()) {
      throw new IdeaError("no JetBrains IDE in the process ancestry");
    }
    await _internals.notify(message, { title, typeToken, actions });
  } catch (exc) {
    if (exc instanceof IdeaError || exc instanceof NotImplementedError) {
      process.stderr.write(`notify: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
