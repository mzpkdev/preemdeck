/**
 * install core — preemdeck installer (behavior-identical v1).
 *
 * Wears a ripperdoc install skin (ANSI banner + phased section()/sub() output), gated on a
 * real stdout TTY + NO_COLOR. It also installs its OWN node_modules as an early phase
 * (installDeps — relocated from boot.sh so the bun-install runs under the banner, not as
 * silent pre-handoff noise). To LOAD before those deps exist, the whole graph reachable
 * from here keeps zero third-party imports: its arg parse is hand-rolled, not argvex.
 *
 * Registers the marketplace (claude/codex) or installs per-extension (gemini) for
 * ONE harness, copies the per-harness overlay into the host config dir, and writes
 * the install manifest. `repoRoot` is threaded from the entry (import.meta.dir) — no
 * module-global REPO_ROOT lives under src/install.
 */

import { parseInstallArgs } from "./args"
import { recordChannel, seedConfig } from "./config"
import { MARKETPLACE_HOSTS, marketplaces, STAGE_ROOT } from "./constants"
import { installDeps } from "./deps"
import {
    configDir,
    detectHarnesses,
    installPlugin,
    onPath,
    readPluginSpecs,
    refreshMarketplace,
    registerMarketplace
} from "./hosts"
import { recordHarness } from "./manifest"
import { buildMirror, stampMirror } from "./mirror"
import { copyOverlay } from "./overlay"
import {
    BANNER,
    BOLD,
    CHECK,
    CROSS,
    CYAN,
    DIM,
    IS_TTY,
    printSummary,
    RED,
    RESET,
    section,
    sub,
    typing,
    WHITE
} from "./skin"

export async function installFor(harness: string, repoRoot: string, dryRun: boolean): Promise<number> {
    section(`rig · ${harness}`)
    if (!(await onPath(harness))) {
        process.stderr.write(`${harness} not on PATH. Install it and re-run.\n`)
        console.log(`    ${RED}${BOLD}ABORT${RESET}  ${harness} ${DIM}not on PATH — install it and re-run.${RESET}`)
        return 1
    }
    sub(`${harness.padEnd(7)} ${DIM}jacked in${RESET}`)
    console.log()

    section("grafting the overlay")
    const [ok, err, overlay] = copyOverlay(harness, repoRoot, configDir(harness), dryRun)
    if (!ok) {
        process.stderr.write(`  ${CROSS} overlay: ${err}\n`)
        console.log(`    ${RED}${BOLD}ABORT${RESET}  overlay: ${err}`)
        return 1
    }
    sub(`${overlay.length} file(s) ${DIM}→ ${configDir(harness)}${RESET}`)
    console.log()

    section("slotting chrome")
    const results: Record<string, string> = {}
    let anySuccess = false
    const registeredMarketplaces: string[] = []
    const installedPlugins: Array<Record<string, unknown>> = []

    for (const [name, path] of marketplaces(repoRoot)) {
        const [mOk, mErr] = await registerMarketplace(harness, path, dryRun)
        if (mOk) {
            results[name] = "ok"
            anySuccess = true
            if (MARKETPLACE_HOSTS.has(harness)) {
                registeredMarketplaces.push(name)
            }
            if (harness === "claude") {
                // Claude won't re-fetch the cached marketplace clone on install (claude-code#46081),
                // so local marketplace edits stay invisible until the clone is refreshed.
                await refreshMarketplace(harness, name, dryRun)
            }
            const slotted: string[] = []
            for (const spec of readPluginSpecs(path)) {
                const [pOk, pErr] = await installPlugin(harness, spec, name, dryRun)
                const lowered = pErr.toLowerCase()
                if (pOk || lowered.includes("already") || lowered.includes("exists")) {
                    installedPlugins.push({ host: harness, rack: name, name: spec.name })
                    slotted.push(spec.name)
                } else {
                    results[name] = `${spec.name}: ${pErr}`.slice(0, 60)
                }
            }
            const mark = results[name] === "ok" ? `${CYAN}${CHECK}${RESET}` : `${RED}${CROSS}${RESET}`
            sub(`${mark} ${name.padEnd(9)}${DIM}${slotted.join(" · ") || "—"}${RESET}`)
        } else {
            results[name] = mErr.slice(0, 60)
            sub(`${RED}${CROSS}${RESET} ${name.padEnd(9)}${RED}${mErr}${RESET}`)
        }
    }

    printSummary(harness, results)
    // Narrate the manifest write here (skin lives at this layer); recordHarness itself is
    // presentation-free and just skips the write on a dry run.
    if (dryRun) {
        sub(`${DIM}would record manifest: ${overlay.length} overlay file(s)${RESET}`)
    }
    recordHarness(repoRoot, harness, overlay, registeredMarketplaces, installedPlugins, dryRun)
    return anySuccess ? 0 : 1
}

export async function main(argv: string[], repoRoot: string): Promise<number> {
    const args = parseInstallArgs(argv)
    console.log(BANNER)
    if (IS_TTY) {
        await Bun.sleep(300)
    }
    await typing("jacking in…", 20)
    console.log()

    // Named harness(es) override; with none, install to every host detected by config dir.
    const targets = args.harnesses.length > 0 ? args.harnesses : detectHarnesses()
    if (targets.length === 0) {
        process.stderr.write(
            "No supported harness detected — looked for ~/.claude, ~/.codex, ~/.gemini. Install one and re-run.\n"
        )
        console.log(
            `    ${RED}${BOLD}ABORT${RESET}  no harness detected ${DIM}— looked for ~/.claude · ~/.codex · ~/.gemini${RESET}`
        )
        console.log()
        return 1
    }

    // Harness-independent groundwork — runs ONCE no matter how many hosts we target.
    section("preflight")
    sub(`targets  ${DIM}${targets.join(" · ")}${RESET}`)
    if (args.dryRun) {
        sub(`${DIM}dry run — no changes will be written${RESET}`)
    }
    seedConfig(repoRoot, args.dryRun)
    recordChannel(repoRoot, args.dryRun)
    console.log()

    section("wiring runtime deps")
    const [depsOk, depsErr] = await installDeps(repoRoot, args.dryRun)
    if (depsOk) {
        sub(args.dryRun ? `${DIM}would install runtime deps${RESET}` : `runtime deps ${DIM}ready${RESET}`)
    } else {
        sub(`${RED}${CROSS}${RESET} ${DIM}${depsErr.slice(0, 60)}${RESET}`)
        sub(`${DIM}plugins may miss deps — re-run boot.sh to retry${RESET}`)
    }
    console.log()

    // Build the primitives-only mirror BEFORE registration: hosts register from
    // .stage/<rack>, and the SHA stamp is the cache key that forces a re-copy.
    section("minting the mirror")
    const mirrored = buildMirror(repoRoot, args.dryRun)
    await stampMirror(repoRoot, mirrored, args.dryRun)
    sub(`${mirrored.length} primitive(s) ${DIM}→ ${STAGE_ROOT}/${RESET}`)
    console.log()

    // One host failing (not on PATH, marketplace error) is isolated — others still install,
    // and the run reports nonzero so boot.sh's `set -e` surfaces it.
    let rc = 0
    const chromed: string[] = []
    for (const harness of targets) {
        if ((await installFor(harness, repoRoot, args.dryRun)) === 0) {
            chromed.push(harness)
        } else {
            rc = 1
        }
    }

    // Closing banner — printed ONCE for the whole run, not per rig. Lists every harness
    // that slotted clean so a single restart hint covers them all.
    if (rc === 0) {
        console.log(`    ${CYAN}${BOLD}━━━${RESET} ${WHITE}${BOLD}preem, choom. you're chromed.${RESET}`)
        console.log(`        ${DIM}restart ${chromed.join(" · ")} to load the new rig.${RESET}`)
    } else {
        console.log(`    ${RED}${BOLD}flatlined${RESET} ${DIM}— some racks didn't slot; see above.${RESET}`)
        if (chromed.length > 0) {
            console.log(`        ${DIM}restart ${chromed.join(" · ")} to load the new rig.${RESET}`)
        }
    }
    console.log()
    return rc
}
