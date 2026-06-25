/**
 * lifecycle.test.ts — the deterministic operational layer. Port of the unit
 * stratum of server/tests/test_lifecycle.py (the integration start/stop cycle
 * stays in the Python suite — it spawns a real server).
 *
 * Hermetic throughout: the state dir is redirected to a tmp dir via WIRE_STATE_DIR
 * so nothing touches a real ~/.wire, and every I/O seam (UDP socket, fetch, the
 * port bind-probe) is injected, mirroring the monkeypatch seams the Python used.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type * as dgram from "node:dgram"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    clearState,
    detectLanIp,
    findFreePort,
    healthOk,
    readState,
    renderHandoff,
    statePath,
    type UdpSocketFactory,
    writeState
} from "./lifecycle.ts"

const context = describe

let dir = ""
const savedStateDir = process.env.WIRE_STATE_DIR

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wire-lifecycle-"))
    process.env.WIRE_STATE_DIR = dir
})

afterEach(async () => {
    if (savedStateDir === undefined) {
        delete process.env.WIRE_STATE_DIR
    } else {
        process.env.WIRE_STATE_DIR = savedStateDir
    }
    await rm(dir, { recursive: true, force: true })
})

const exists = async (p: string): Promise<boolean> => Bun.file(p).exists()

/** A fake UDP socket whose `.address()` returns `addr`; tracks close(). */
const fakeSocket = (addr: string): { factory: UdpSocketFactory; closed: () => boolean } => {
    let wasClosed = false
    const factory: UdpSocketFactory = () =>
        ({
            connect: (_port: number, _host: string, cb?: (err?: Error) => void) => {
                cb?.()
            },
            address: () => ({ address: addr, family: "IPv4", port: 54321 }),
            close: () => {
                wasClosed = true
            }
        }) as unknown as dgram.Socket
    return { factory, closed: () => wasClosed }
}

/** A fake UDP socket whose `connect` fails (no route); tracks close(). */
const failSocket = (): { factory: UdpSocketFactory; closed: () => boolean } => {
    let wasClosed = false
    const factory: UdpSocketFactory = () =>
        ({
            connect: (_port: number, _host: string, cb?: (err?: Error) => void) => {
                cb?.(new Error("network is unreachable"))
            },
            address: () => {
                throw new Error("should not be called after connect fails")
            },
            close: () => {
                wasClosed = true
            }
        }) as unknown as dgram.Socket
    return { factory, closed: () => wasClosed }
}

context("state round-trip", () => {
    it("writes, reads back, then clears the state file", async () => {
        expect(await readState()).toBeNull() // nothing yet

        await writeState({
            pid: 4242,
            host: "0.0.0.0",
            port: 5557,
            secret: "sekret",
            url: "http://10.0.0.5:5557",
            topic: "design sync"
        })

        expect(await readState()).toEqual({
            pid: 4242,
            host: "0.0.0.0",
            port: 5557,
            secret: "sekret",
            url: "http://10.0.0.5:5557",
            topic: "design sync"
        })

        // file lives at <state_dir>/wire.json and is valid JSON
        const file = join(dir, "wire.json")
        expect(await exists(file)).toBe(true)
        expect(JSON.parse(await readFile(file, "utf-8")).port).toBe(5557)

        await clearState()
        expect(await readState()).toBeNull()
        expect(await exists(file)).toBe(false)
    })

    it("places the state file at <stateDir>/wire.json", async () => {
        expect(await statePath()).toBe(join(dir, "wire.json"))
    })

    it("clears idempotently — twice with nothing there raises nothing", async () => {
        await clearState() // nothing there → no error
        await clearState()
        expect(await readState()).toBeNull()
    })
})

context("renderHandoff", () => {
    it("renders the exact handoff block with url + secret substituted", () => {
        const out = renderHandoff("http://192.168.1.20:5555", "abc123")
        const expected =
            "Send this prompt to your other agents:\n" +
            "```bash\n" +
            'Execute `curl -s "http://192.168.1.20:5555/shard?secret=abc123"`, ' +
            "then follow the instructions there as written.\n" +
            "```"
        expect(out).toBe(expected)
        // the substituted url + secret both land in the block
        expect(out).toContain("http://192.168.1.20:5555/shard?secret=abc123")
    })
})

context("detectLanIp", () => {
    it("returns the connected socket's address on the happy path", async () => {
        const { factory, closed } = fakeSocket("192.168.50.7")
        expect(await detectLanIp(factory)).toBe("192.168.50.7")
        expect(closed()).toBe(true) // socket closed on the success path too
    })

    it("falls back to loopback and still closes the socket on connect failure", async () => {
        const { factory, closed } = failSocket()
        expect(await detectLanIp(factory)).toBe("127.0.0.1")
        expect(closed()).toBe(true) // socket still closed on the failure path
    })

    it("yields a string from a real call (whatever the environment)", async () => {
        expect(typeof (await detectLanIp())).toBe("string")
    })
})

context("healthOk", () => {
    it("is down when nothing is listening (connection refused)", async () => {
        // Port 1 is never our server; the connection refuses → down. Real fetch.
        expect(await healthOk("127.0.0.1", 1, 500)).toBe(false)
    })

    it("is up on an exact {status:ok} body", async () => {
        const fakeFetch = async () => new Response('{"status":"ok"}', { status: 200 })
        expect(await healthOk("127.0.0.1", 5555, 500, fakeFetch)).toBe(true)
    })

    it.each([
        ['{"status":"degraded"}'],
        ["not json at all"]
    ])("is down on a 200 whose body is not {status:ok}: %p", async (body) => {
        const fakeFetch = async () => new Response(body, { status: 200 })
        expect(await healthOk("127.0.0.1", 5555, 500, fakeFetch)).toBe(false)
    })

    it.each([
        ["", "127.0.0.1"],
        ["0.0.0.0", "127.0.0.1"],
        ["10.0.0.5", "10.0.0.5"]
    ])("probes %p as host %p", async (host, expectedHost) => {
        let seen = ""
        const fakeFetch = async (url: string) => {
            seen = url
            return new Response('{"status":"ok"}', { status: 200 })
        }
        await healthOk(host, 5555, 500, fakeFetch)
        expect(seen).toBe(`http://${expectedHost}:5555/health`)
    })
})

context("findFreePort", () => {
    it("returns the start port when it is free", async () => {
        const allFree: (h: string, p: number) => Promise<boolean> = async () => true
        expect(await findFreePort("127.0.0.1", 5555, 100, allFree)).toBe(5555)
    })

    it("skips busy ports and returns the first free one", async () => {
        // First two probes busy, third free.
        const seq = [false, false, true]
        let i = 0
        const probe = async () => seq[i++] ?? true
        expect(await findFreePort("127.0.0.1", 5555, 100, probe)).toBe(5557)
    })

    it("throws when every probed port is busy (exhaustion)", async () => {
        const alwaysBusy: (h: string, p: number) => Promise<boolean> = async () => false
        await expect(findFreePort("127.0.0.1", 5555, 3, alwaysBusy)).rejects.toThrow("no free port")
    })

    it("binds a real free port via the default probe", async () => {
        // Exercise the real node:net bind path once, against an ephemeral-ish high port.
        const port = await findFreePort("127.0.0.1", 53121, 50)
        expect(port).toBeGreaterThanOrEqual(53121)
    })
})
