/**
 * lifecycle.ts — operational plumbing for the wire server, the deterministic
 * layer (including the free-port scan).
 *
 * Owns what the launch/teardown skills used to do in bash: the on-disk state file
 * (one room per host), LAN-IP detection, the operator handoff render, the /health
 * liveness probe, and the free-port scan. Primitive-parameterized — it never
 * imports Config — so it stays unit-testable.
 *
 * State lives in a single JSON file under the state dir (env `WIRE_STATE_DIR`, else
 * `~/.wire`). The `wire serve` process is the single writer; start/stop/status only
 * read and clear it.
 *
 * I/O functions take their dependency (socket / fetch / binder seam) as a trailing
 * param with a real default, mirroring os-notify.ts, so tests drive them without a
 * real network or filesystem race.
 */

import * as dgram from "node:dgram"
import * as fs from "node:fs/promises"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"

/** The one state file, relative to the state dir. One room per host. */
const STATE_FILENAME = "wire.json"

/** Default teardown / probe timeout for a single /health GET, in milliseconds. */
export const HEALTH_TIMEOUT_MS = 2000

/** How many consecutive ports to probe from the start port before giving up. */
export const PORT_SCAN_ATTEMPTS = 100

/** The persisted room-state shape — the single JSON object the writer emits. */
export type WireState = {
    pid: number
    host: string
    port: number
    secret: string
    url: string
    topic: string
}

/**
 * Return the state directory, creating it if absent. `WIRE_STATE_DIR` overrides
 * the default of `~/.wire` — tests point it at a tmp dir so they never touch a real
 * room's state.
 */
export const stateDir = async (): Promise<string> => {
    const env = process.env.WIRE_STATE_DIR
    const base = env ? env : path.join(os.homedir(), ".wire")
    await fs.mkdir(base, { recursive: true })
    return base
}

/** Path to the single `wire.json` state file. */
export const statePath = async (): Promise<string> => {
    return path.join(await stateDir(), STATE_FILENAME)
}

/** Path to the detached server's log file (`wire.log`). */
export const logPath = async (): Promise<string> => {
    return path.join(await stateDir(), "wire.log")
}

/** Write the room state file. Called by the `serve` process only. */
export const writeState = async (state: WireState): Promise<void> => {
    const payload = {
        pid: state.pid,
        host: state.host,
        port: state.port,
        secret: state.secret,
        url: state.url,
        topic: state.topic
    }
    await fs.writeFile(await statePath(), `${JSON.stringify(payload, null, 2)}\n`, "utf-8")
}

/** Return the parsed state file, or `null` if it's absent or unreadable. */
export const readState = async (): Promise<WireState | null> => {
    try {
        const raw = await fs.readFile(await statePath(), "utf-8")
        // The writer always emits a JSON object; the cast asserts that without
        // changing what is returned.
        return JSON.parse(raw) as WireState
    } catch {
        return null
    }
}

/** Remove the state file (and the detached log). Idempotent. */
export const clearState = async (): Promise<void> => {
    for (const target of [await statePath(), await logPath()]) {
        try {
            await fs.unlink(target)
        } catch {
            // missing file (or any unlink error) is fine — clearing is idempotent.
        }
    }
}

/** Factory for a connectable UDP socket — the injectable seam for {@link detectLanIp}. */
export type UdpSocketFactory = () => dgram.Socket

const defaultUdpSocket: UdpSocketFactory = () => dgram.createSocket("udp4")

/**
 * Best-effort LAN IP of this host.
 *
 * Opens a UDP socket and `connect`s it to a public address; no packets are
 * actually sent, but the kernel picks the source interface, and `.address()` then
 * reveals that interface's address. On any failure (no route, sandbox), fall back
 * to loopback. The socket is always closed.
 *
 * @param makeSocket - UDP-socket factory, injectable for tests (default: a udp4 socket).
 * @returns the LAN IP, or `127.0.0.1` on any failure.
 */
export const detectLanIp = async (makeSocket: UdpSocketFactory = defaultUdpSocket): Promise<string> => {
    const sock = makeSocket()
    try {
        await new Promise<void>((resolve, reject) => {
            // node:dgram `connect` is async; it only sets the default peer (no
            // packets). Errors -> fallback.
            sock.connect(80, "8.8.8.8", (err?: Error) => {
                if (err) {
                    reject(err)
                } else {
                    resolve()
                }
            })
        })
        return sock.address().address
    } catch {
        return "127.0.0.1"
    } finally {
        try {
            sock.close()
        } catch {
            // socket may already be torn down — closing is best-effort.
        }
    }
}

/**
 * Render the operator handoff block.
 *
 * The fenced `bash` block holds a literal instruction for a *peer* agent — it is
 * printed, never executed. `url` and `secret` are substituted live.
 *
 * @param url - the room's base URL (e.g. `http://192.168.1.20:5555`).
 * @param secret - the room secret.
 * @returns the rendered handoff text.
 */
export const renderHandoff = (url: string, secret: string): string => {
    return (
        "Send this prompt to your other agents:\n" +
        "```bash\n" +
        `Execute \`curl -s "${url}/shard?secret=${secret}"\`, ` +
        "then follow the instructions there as written.\n" +
        "```"
    )
}

/** The fetch primitive, injectable for hermetic tests (default: global fetch). */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

/**
 * True iff `GET http://host:port/health` returns `{"status":"ok"}`.
 *
 * A dead room can't answer, so any connection error reads as down. The probe
 * targets loopback semantics: callers pass the bind host (`127.0.0.1` in tests) or
 * `127.0.0.1` for a `0.0.0.0` bind. A 200 whose body isn't exactly `{"status":"ok"}`
 * — including non-JSON — also reads as down.
 *
 * @param host - the bind host (`""` / `0.0.0.0` probe loopback).
 * @param port - the port to probe.
 * @param timeoutMs - per-GET timeout (default {@link HEALTH_TIMEOUT_MS}).
 * @param fetchImpl - fetch primitive, injectable for tests (default: global fetch).
 */
export const healthOk = async (
    host: string,
    port: number,
    timeoutMs: number = HEALTH_TIMEOUT_MS,
    fetchImpl: FetchLike = fetch
): Promise<boolean> => {
    const probeHost = host === "" || host === "0.0.0.0" ? "127.0.0.1" : host
    const url = `http://${probeHost}:${port}/health`
    let body: string
    try {
        const resp = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
        body = await resp.text()
    } catch {
        return false
    }
    try {
        const parsed = JSON.parse(body) as unknown
        return (
            typeof parsed === "object" &&
            parsed !== null &&
            Object.keys(parsed).length === 1 &&
            (parsed as Record<string, unknown>).status === "ok"
        )
    } catch {
        return false
    }
}

/** Probe whether `(host, port)` is bindable — the injectable seam for {@link findFreePort}. */
export type BindProbe = (host: string, port: number) => Promise<boolean>

/**
 * Bind a throwaway TCP server to `(host, port)`, then close it. Resolves true if
 * the bind succeeded (port free), false on EADDRINUSE / any bind error. The probe
 * server is always closed before returning, so a brief bind race remains
 * (acceptable for LAN use).
 */
const defaultBindProbe: BindProbe = (host, port) =>
    new Promise<boolean>((resolve) => {
        const server = net.createServer()
        const settle = (free: boolean): void => {
            server.removeAllListeners()
            server.close(() => resolve(free))
        }
        server.once("error", () => {
            // close() on a server that never listened still fires its callback.
            server.close(() => resolve(false))
        })
        server.once("listening", () => settle(true))
        server.listen(port, host)
    })

/**
 * Return the first bindable port at/above `start`, scanning upward.
 *
 * Probes each port by binding a throwaway socket to `(host, port)`; a busy port
 * advances by one. Throws if no free port is found within `attempts`.
 *
 * @param host - the host to bind the probe against.
 * @param start - the first port to try.
 * @param attempts - how many consecutive ports to probe (default {@link PORT_SCAN_ATTEMPTS}).
 * @param probe - bind-probe seam, injectable for tests (default: a real `node:net` bind).
 * @returns the first free port.
 * @throws if every probed port is busy.
 */
export const findFreePort = async (
    host: string,
    start: number,
    attempts: number = PORT_SCAN_ATTEMPTS,
    probe: BindProbe = defaultBindProbe
): Promise<number> => {
    for (let port = start; port < start + attempts; port++) {
        if (await probe(host, port)) {
            return port
        }
    }
    throw new Error(`no free port in range ${start}-${start + attempts - 1} on ${host}`)
}
