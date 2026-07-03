/**
 * install.e2e.ts — end-to-end check of the PUBLIC install one-liner.
 *
 * Runs the exact `curl … | bash` one-liner documented in README.md's "## Install"
 * section against a throwaway $HOME and asserts a clean exit. This is a REAL
 * install: it curls main/boot.sh off GitHub, which clones the channel's branch into
 * $HOME/.preemdeck, vendors the pinned Bun, runs `bun install`, and copies the
 * overlay into the seeded ~/.claude. Network- and time-heavy by nature.
 *
 * PREEMDECK_E2E_CHANNEL (default "stable") picks the one-liner + branch: stable
 * clones `stable` (the deployed release), edge clones `main`. CI sets it from the
 * triggering branch (main push -> edge, so a push validates its own install.ts;
 * stable push -> stable), so the E2E tests the branch it fired on, not always
 * stable.
 *
 * Not part of `bun test` (CI) on purpose: the `.e2e.ts` suffix doesn't match
 * Bun's discovery glob (*.test / *.spec), so bare `bun test` skips it. Run it
 * explicitly:
 *     bun run test:e2e            # alias for: bun test ./e2e/install.e2e.ts
 *
 * Safety: $HOME is redirected to a mkdtemp dir, so the clone, the Bun runtime and
 * the overlay copy all land there — the developer's real ~/.preemdeck / ~/.claude
 * are never touched. The temp dir is removed afterward.
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..")

// install.ts auto-detects targets by the presence of a host's config dir under
// $HOME and aborts nonzero if a DETECTED host's CLI is missing from PATH. So the
// set of hosts this test exercises is exactly the set whose CLIs the runner has
// installed. Default to claude only, so a bare local `bun run test:e2e` needs just
// the claude CLI on PATH; the CI e2e workflow installs all three CLIs and sets
// PREEMDECK_E2E_HOSTS=claude,codex,gemini to exercise each. Unknown names are
// dropped so a typo can't silently seed a bogus dir that detection ignores.
const KNOWN_HOSTS = new Set(["claude", "codex", "gemini"])
const E2E_HOSTS = (process.env.PREEMDECK_E2E_HOSTS ?? "claude")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => KNOWN_HOSTS.has(host))

type Channel = "stable" | "edge"
// The channel to install. CI sets PREEMDECK_E2E_CHANNEL from the triggering branch
// (main -> edge, stable -> stable); a bare local run defaults to stable.
const E2E_CHANNEL: Channel = process.env.PREEMDECK_E2E_CHANNEL === "edge" ? "edge" : "stable"

/**
 * Pull the install one-liner for `channel` out of README.md instead of hardcoding
 * it, so this test breaks the moment the documented command drifts. Scans the bash
 * fences in the "## Install" section for the `curl … boot.sh` line and picks by
 * channel: edge is the line that sets `PREEMDECK_CHANNEL=edge`, stable is the plain
 * one. Bounded to the section (stops at the next `##` heading) so the later
 * re-bootstrap block can't match.
 */
function installCommand(channel: Channel): string {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8")
    const section = readme.split(/^##\s+Install\b.*$/m)[1]?.split(/^##\s+/m)[0] ?? ""
    const curlLines = [...section.matchAll(/```bash\n([\s\S]*?)```/g)]
        .flatMap((fence) => (fence[1] ?? "").split("\n"))
        .map((line) => line.trim())
        .filter((line) => line.startsWith("curl") && line.includes("boot.sh"))
    const command = curlLines.find((line) => line.includes("PREEMDECK_CHANNEL=edge") === (channel === "edge"))
    if (!command) {
        throw new Error(`README.md '## Install' has no ${channel} \`curl … boot.sh\` command — did the docs change?`)
    }
    return command
}

let home = ""

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "preemdeck-e2e-"))
    // Seed each host's config dir so install.ts detects and targets it. An empty
    // $HOME detects no harness and aborts nonzero by design.
    for (const host of E2E_HOSTS) {
        mkdirSync(join(home, `.${host}`), { recursive: true })
    }
})

afterEach(() => {
    if (home) {
        rmSync(home, { recursive: true, force: true })
    }
})

test(`README ${E2E_CHANNEL} install one-liner completes cleanly`, async () => {
    const command = installCommand(E2E_CHANNEL)
    // `-o pipefail` so a curl failure fails the pipeline instead of being
    // masked by a happy `bash` reading empty stdin. The command text itself is
    // verbatim from the README.
    const proc = Bun.spawn(["bash", "-o", "pipefail", "-c", command], {
        // Redirect every install write into the throwaway HOME; pin the channel so
        // an inherited PREEMDECK_CHANNEL can't override the one under test.
        env: { ...process.env, HOME: home, PREEMDECK_CHANNEL: E2E_CHANNEL },
        stdout: "pipe",
        stderr: "pipe"
    })
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
    ])
    if (exitCode !== 0) {
        console.error(`install exited ${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
    }
    expect(exitCode).toBe(0)
    // Proof the install actually ran, not merely exited 0: the stable clone
    // landed in the isolated HOME, and — since main() returns nonzero if ANY
    // detected host fails — exit 0 means every seeded host was chromed. Assert
    // each host's overlay files landed in ~/.<host> so a silently-dropped host
    // can't pass as a green run.
    expect(existsSync(join(home, ".preemdeck", "install.ts"))).toBe(true)
    for (const host of E2E_HOSTS) {
        expect(readdirSync(join(home, `.${host}`)).length).toBeGreaterThan(0)
    }
}, 600_000)
