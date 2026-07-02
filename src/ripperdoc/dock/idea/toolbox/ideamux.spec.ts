/**
 * ideamux.spec.ts — subprocess smoke test for the `ideamux` shell wrapper.
 *
 * A fake `tmux` (via IDEAMUX_TMUX) records the subcommand it is exec'd with and
 * fakes has-session's exit code (FAKE_HAS_SESSION), so the three branches are
 * observable without a real tmux server: create a session, attach to an existing
 * one, and the safety fallback that execs the login shell when tmux is absent.
 *
 * IDEAMUX_SOCKET_PATH is set directly, so the wrapper skips its git/hash block and
 * the test needs neither a git repo nor md5.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const WRAPPER = join(import.meta.dir, "ideamux")

const temps: string[] = []
const mkTemp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "pd-ideamux-w-"))
    temps.push(dir)
    return dir
}
afterEach(() => {
    while (temps.length > 0) {
        rmSync(temps.pop() as string, { recursive: true, force: true })
    }
})

const writeExec = (path: string, body: string): string => {
    writeFileSync(path, body)
    chmodSync(path, 0o755)
    return path
}

// A fake tmux: has-session exits FAKE_HAS_SESSION; anything else echoes its argv.
const FAKE_TMUX = `#!/bin/sh
for a in "$@"; do
  case "$a" in
    has-session) exit \${FAKE_HAS_SESSION:-1} ;;
  esac
done
echo "tmux $*"
`

const run = async (env: Record<string, string>): Promise<{ code: number; stdout: string }> => {
    const subprocess = Bun.spawn(["bash", WRAPPER], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env }
    })
    const stdout = await new Response(subprocess.stdout).text()
    const code = await subprocess.exited
    return { code, stdout }
}

describe("ideamux", () => {
    it("creates a new session when none exists", async () => {
        const dir = mkTemp()
        const tmux = writeExec(join(dir, "tmux"), FAKE_TMUX)
        const sock = join(dir, "repo.sock")
        const { code, stdout } = await run({
            HOME: dir,
            IDEAMUX_TMUX: tmux,
            IDEAMUX_SOCKET_DIR: dir,
            IDEAMUX_SOCKET_PATH: sock,
            FAKE_HAS_SESSION: "1"
        })
        expect(code).toBe(0)
        expect(stdout).toContain("new-session")
        expect(stdout).toContain(sock)
    })

    it("attaches when a session already exists", async () => {
        const dir = mkTemp()
        const tmux = writeExec(join(dir, "tmux"), FAKE_TMUX)
        const sock = join(dir, "repo.sock")
        const { code, stdout } = await run({
            HOME: dir,
            IDEAMUX_TMUX: tmux,
            IDEAMUX_SOCKET_DIR: dir,
            IDEAMUX_SOCKET_PATH: sock,
            FAKE_HAS_SESSION: "0"
        })
        expect(code).toBe(0)
        expect(stdout).toContain("attach-session")
    })

    it("falls back to the login shell when tmux is missing (terminal never breaks)", async () => {
        const dir = mkTemp()
        const shell = writeExec(join(dir, "fake-shell"), "#!/bin/sh\necho FAKE_SHELL_RAN\n")
        const { code, stdout } = await run({
            HOME: dir,
            IDEAMUX_TMUX: join(dir, "no-such-tmux-zzz"),
            SHELL: shell
        })
        expect(code).toBe(0)
        expect(stdout).toContain("FAKE_SHELL_RAN")
    })
})
