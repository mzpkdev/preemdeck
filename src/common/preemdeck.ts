import * as os from "node:os"
import * as path from "node:path"

export const ENV = {
    get PLUGIN_ROOT() {
        const seg = (process.argv[1] ?? "").split(path.sep)
        const r = seg.lastIndexOf("ripperdoc")
        if (r === -1) throw new Error("PLUGIN_ROOT: not running from a ripperdoc plugin")
        return seg.slice(0, r + 3).join(path.sep)
    },
    get MARKETPLACE_ROOT() {
        const seg = (process.argv[1] ?? "").split(path.sep)
        const r = seg.lastIndexOf("ripperdoc")
        if (r === -1) throw new Error("MARKETPLACE_ROOT: not running from a ripperdoc plugin")
        return seg.slice(0, r + 2).join(path.sep)
    },
    get PREEMDECK_ROOT() {
        return path.join(os.homedir(), ".preemdeck")
    },
    get CACHED_PLUGIN_ROOT() {
        const plugin = path.basename(this.PLUGIN_ROOT)
        if (path.basename(this.HARNESS_ROOT) === ".gemini") {
            return path.join(this.HARNESS_ROOT, "extensions", plugin)
        }
        return path.join(this.HARNESS_ROOT, "plugins", "cache", path.basename(this.MARKETPLACE_ROOT), plugin)
    },
    get CACHED_MARKETPLACE_ROOT() {
        const dotdir = path.basename(this.HARNESS_ROOT)
        if (dotdir === ".gemini") throw new Error("CACHED_MARKETPLACE_ROOT: Gemini has no marketplace cache")
        const rack = path.basename(this.MARKETPLACE_ROOT)
        return dotdir === ".codex"
            ? path.join(this.HARNESS_ROOT, "marketplaces", rack)
            : path.join(this.HARNESS_ROOT, "plugins", "marketplaces", rack)
    },
    get HARNESS_ROOT() {
        const env = process.env
        if (env.GEMINI_SESSION_ID || env.GEMINI_PROJECT_DIR) return path.join(os.homedir(), ".gemini")
        if (env.CLAUDECODE === "1") return path.join(os.homedir(), ".claude")
        if (env.PLUGIN_ROOT || env.CODEX_HOME) return path.join(os.homedir(), ".codex")
        return path.join(os.homedir(), ".claude")
    }
}

/** A directive object: each slot holds the active mode for its axis ("" = neutral). */
export type Directive = {
    strategy?: string
    discretion?: string
}

/** The release channel an install tracks: stable (released main) or edge (main HEAD). */
export type Channel = "stable" | "edge"

/** A dock notification kind (the audio ding, or one of the four moments a visual alert fires),
 *  plus `broadcast` — the scope toggle: on = every running IDE, off = only the originating one —
 *  `tmux`, the per-state tmux window title (idle/busy/waiting), and `ideaTab`, its sibling: the
 *  per-state JetBrains (WebStorm) terminal tab title, mirroring the tmux window. */
export type NotifyKey = "sound" | "turn" | "permission" | "ask" | "plan" | "broadcast" | "tmux" | "ideaTab"

/**
 * Dock notification config. `true` or absent = everything on; `false` = everything
 * off; an object toggles each kind independently. Every key defaults to `true` when
 * omitted, so a partial object only ever subtracts.
 */
export type Notify = boolean | Partial<Record<NotifyKey, boolean>>

/** The shape of preemdeck.json — gitignored, user-local state. */
export type Config = {
    /** Active behavioral directives; a bare string is the legacy single-value form. */
    directive?: Directive | string
    /** Channel this install was set up with; install.ts persists it, update.ts forwards it to boot.sh. */
    channel?: Channel
    /** Dock notifications: enable/disable the ding and the per-moment desktop / IDE alerts. */
    notify?: Notify
    /** Env-style key/value toggles. `HOLO_PLANNER: true` serves the plan via holo (the
     *  interactive planner) and opens the running URL in the IDE; absent/false keeps the
     *  static IDE markdown preview. */
    env?: Record<string, boolean>
}

export type Recipe<TDraft> = (draft: TDraft) => TDraft | Promise<TDraft>

export const config = {
    async read(): Promise<Config> {
        const file = Bun.file(path.join(ENV.PREEMDECK_ROOT, "preemdeck.json"))
        return (await file.exists()) ? await file.json() : {}
    },
    async mutate(recipe: Recipe<Config>): Promise<void> {
        const draft = await this.read()
        const next = await recipe(draft)
        await Bun.write(path.join(ENV.PREEMDECK_ROOT, "preemdeck.json"), `${JSON.stringify(next, null, 2)}\n`)
    }
}

/**
 * Whether a dock notification `key` is enabled, with default-on semantics: an
 * absent `notify`, `notify: true`, a non-object value, or an omitted key all read
 * as enabled; only an explicit `false` — the whole `notify`, or that one key —
 * turns it off.
 */
export const notifyEnabled = (cfg: Config, key: NotifyKey): boolean => {
    const n = cfg.notify
    if (n === false) return false
    if (n === null || typeof n !== "object" || Array.isArray(n)) return true
    return n[key] !== false
}

/**
 * Read preemdeck.json and resolve {@link notifyEnabled} for `key`. Fail-open: any
 * read or parse error resolves `true`, so a missing or malformed config never
 * silently swallows a notification.
 */
export const isNotifyEnabled = async (key: NotifyKey): Promise<boolean> => {
    try {
        return notifyEnabled(await config.read(), key)
    } catch {
        return true
    }
}

/**
 * Whether the interactive holo planner is enabled: `true` ONLY for an explicit
 * `env.HOLO_PLANNER: true`. An absent flag, `false`, or any non-boolean value reads
 * as off, so the safe default is the static IDE markdown preview.
 */
export const interactiveEnabled = (cfg: Config): boolean => cfg.env?.HOLO_PLANNER === true

/**
 * Read preemdeck.json and resolve {@link interactiveEnabled}. Fail-CLOSED: unlike
 * notifications (fail-open), the safe default here is today's static preview, so
 * any read or parse error resolves `false` — a missing or malformed config falls
 * back to the static path rather than spinning up a holo server.
 */
export const isInteractive = async (): Promise<boolean> => {
    try {
        return interactiveEnabled(await config.read())
    } catch {
        return false
    }
}

export const markdown = {
    async read(path: string): Promise<string> {
        return Bun.file(path).text()
    },
    join(...markdowns: string[]): string {
        return markdowns
            .map((md) => md.trim())
            .filter((md) => md !== "")
            .join("\n\n")
    },
    interpolate(md: string, context: Record<string, string>): string {
        let out = md
        for (const [key, value] of Object.entries(context)) {
            out = out.replaceAll(`{{${key}}}`, value)
        }
        return out
    }
}
