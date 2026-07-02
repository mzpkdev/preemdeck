/**
 * skin.ts — the ripperdoc install skin: ANSI palette + banner + phased output helpers.
 *
 * Dep-free strings only (safe for the install/update import graph). The palette is gated
 * on a real stdout TTY + NO_COLOR, so redirected installs and the test harness (which
 * spies console.log) stay plain. The banner/typewriter ANIMATE only on a TTY; section()/
 * sub() always emit (color auto-stripped) so a piped log still reads.
 */

import { RACKS } from "./constants"

export const CHECK = "✓"
export const CROSS = "✗"

// ── install UI (ripperdoc skin) ─────────────────────────
// ANSI palette gated on a real stdout TTY + NO_COLOR, so redirected installs and the test
// harness (which spies console.log) stay plain.
export const IS_TTY = Boolean(process.stdout.isTTY)
// NO_COLOR (any value) hard-disables; FORCE_COLOR opts a non-TTY pipe back in. Animation
// stays TTY-only regardless — a redirected log gets color (if forced) but no typewriter.
const FORCE_COLOR = ["1", "true", "yes"].includes((process.env.FORCE_COLOR ?? "").toLowerCase())
const COLOR = !process.env.NO_COLOR && (IS_TTY || FORCE_COLOR)
const sgr = (code: string): string => (COLOR ? code : "")
export const CYAN = sgr("\x1b[96m")
export const RED = sgr("\x1b[91m")
export const DIM = sgr("\x1b[2m")
export const BOLD = sgr("\x1b[1m")
export const WHITE = sgr("\x1b[97m")
export const RESET = sgr("\x1b[0m")

// PREEMDECK in the ANSI Shadow figlet font — shares the "PREEM" prefix with preemclaud's
// rig banner; only D-E-C-K diverge. Trailing spaces on the K rows are intentional glyph fill.
export const BANNER = `${CYAN}${BOLD}
    ██████╗ ██████╗ ███████╗███████╗███╗   ███╗██████╗ ███████╗ ██████╗██╗  ██╗
    ██╔══██╗██╔══██╗██╔════╝██╔════╝████╗ ████║██╔══██╗██╔════╝██╔════╝██║ ██╔╝
    ██████╔╝██████╔╝█████╗  █████╗  ██╔████╔██║██║  ██║█████╗  ██║     █████╔╝
    ██╔═══╝ ██╔══██╗██╔══╝  ██╔══╝  ██║╚██╔╝██║██║  ██║██╔══╝  ██║     ██╔═██╗
    ██║     ██║  ██║███████╗███████╗██║ ╚═╝ ██║██████╔╝███████╗╚██████╗██║  ██╗
    ╚═╝     ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝     ╚═╝╚═════╝ ╚══════╝ ╚═════╝╚═╝  ╚═╝
${RESET}${DIM}                  chrome for claude code · codex · gemini cli${RESET}`

/** Phase header — `>>> label`. */
export function section(label: string): void {
    console.log(`    ${DIM}>>>${RESET} ${BOLD}${label}${RESET}`)
}

/** Indented detail line under a section — `› msg`. */
export function sub(msg: string): void {
    console.log(`        ${DIM}›${RESET} ${msg}`)
}

/** Typewriter a line to a TTY; plain print when not interactive (tests, pipes). */
export async function typing(text: string, delay = 12): Promise<void> {
    if (!IS_TTY) {
        console.log(`    ${text}`)
        return
    }
    process.stdout.write("    ")
    for (const ch of text) {
        process.stdout.write(ch)
        await Bun.sleep(delay)
    }
    process.stdout.write("\n")
}

export function printSummary(harness: string, results: Record<string, string>): void {
    const errors: string[] = []
    for (const name of RACKS) {
        const status = results[name] ?? ""
        if (status && status !== "ok") {
            errors.push(`${harness} / ${name}: ${status}`)
        }
    }

    console.log()
    const marks = RACKS.map((name) => {
        const ok = results[name] === "ok"
        return `${ok ? CYAN + CHECK : RED + CROSS}${RESET} ${name}`
    })
    console.log(`    ${DIM}rig${RESET}  ${harness.padEnd(7)}${marks.join("   ")}`)

    // Per-harness errors surface here, next to their rig. The pass/fail banner + restart
    // hint print ONCE at the end of main() across every target — not per rig.
    if (errors.length > 0) {
        console.log()
        for (const line of errors) {
            console.log(`    ${RED}${CROSS}${RESET} ${line}`)
        }
    }
    console.log()
}
