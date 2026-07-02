/**
 * args.ts — the two hand-rolled, dep-free CLI parsers (install + update).
 *
 * Hand-rolled ON PURPOSE (no argvex): install.ts installs its own node_modules and
 * update.ts runs the installer, so both must LOAD with zero third-party imports — they
 * can't depend on a package they haven't installed yet. `parseUninstallArgs` (argvex)
 * stays in the uninstall core, which runs post-deps.
 */

import { HOSTS } from "./constants"

export interface CliArgs {
    // Explicit harness targets parsed from argv. EMPTY selects auto-detect — main() then
    // installs to every host detected via detectHarnesses().
    harnesses: string[]
    dryRun: boolean
}

export function parseInstallArgs(argv: string[]): CliArgs {
    // The parse is trivial: 0..N positionals + one flag. Zero positionals is NOT an error —
    // it selects auto-detect (main reads detectHarnesses()).
    const prog = "install.ts"
    const positionals: string[] = []
    let dryRun = false
    for (const arg of argv) {
        if (arg === "--dry-run") {
            dryRun = true
        } else if (arg.startsWith("-")) {
            process.stderr.write(`${prog}: unrecognized option: ${arg}\n`)
            process.exit(2)
        } else {
            positionals.push(arg)
        }
    }
    for (const harness of positionals) {
        if (!HOSTS.includes(harness)) {
            process.stderr.write(
                `${prog}: argument harness: invalid choice: '${harness}' (choose from ${HOSTS.join(", ")})\n`
            )
            process.exit(2)
        }
    }
    return { harnesses: positionals, dryRun }
}

export interface UpdateArgs {
    // Explicit harness targets forwarded to boot.sh → install.ts. EMPTY = auto-detect
    // every installed host (boot.sh's default), exactly as a bare re-install would.
    harnesses: string[]
}

export function parseUpdateArgs(argv: string[]): UpdateArgs {
    const prog = "update.ts"
    const positionals: string[] = []
    for (const arg of argv) {
        if (arg.startsWith("-")) {
            // No flags: --dry-run would be misleading here (boot.sh's fetch + reset --hard
            // are NOT dry, only install.ts's writes would be), so reject it like any option.
            process.stderr.write(`${prog}: unrecognized option: ${arg}\n`)
            process.exit(2)
        }
        positionals.push(arg)
    }
    for (const harness of positionals) {
        if (!HOSTS.includes(harness)) {
            process.stderr.write(
                `${prog}: argument harness: invalid choice: '${harness}' (choose from ${HOSTS.join(", ")})\n`
            )
            process.exit(2)
        }
    }
    return { harnesses: positionals }
}
