import { describe, expect, it } from "bun:test"
import { CONFIG_DEFAULTS, type Config, makeConfig } from "./config.ts"

const context = describe

const REQUIRED = { host: "127.0.0.1", port: 8080, secret: "s3cret", topic: "the topic" } as const

describe("makeConfig", () => {
    context("with only the required fields", () => {
        it("carries the supplied host/port/secret/topic verbatim", () => {
            const config = makeConfig(REQUIRED)
            expect(config.host).toBe("127.0.0.1")
            expect(config.port).toBe(8080)
            expect(config.secret).toBe("s3cret")
            expect(config.topic).toBe("the topic")
        })

        it.each([
            ["publicUrl", null],
            ["waitDefault", 30],
            ["waitMax", 60],
            ["idleTimeout", 300],
            ["sweepInterval", 15],
            ["emptyGrace", 900],
            ["maxConnections", 64]
        ] as [keyof Config, unknown][])("defaults %s to %p", (field, value) => {
            const config = makeConfig(REQUIRED)
            expect(config[field]).toBe(value as Config[typeof field])
        })

        it("exposes the same defaults via CONFIG_DEFAULTS", () => {
            expect(CONFIG_DEFAULTS).toEqual({
                publicUrl: null,
                waitDefault: 30,
                waitMax: 60,
                idleTimeout: 300,
                sweepInterval: 15,
                emptyGrace: 900,
                maxConnections: 64
            })
        })
    })

    context("with overrides", () => {
        it("applies each supplied optional field over its default", () => {
            const config = makeConfig({
                ...REQUIRED,
                publicUrl: "https://room.example",
                waitDefault: 5,
                waitMax: 10,
                idleTimeout: 20,
                sweepInterval: 2,
                emptyGrace: 30,
                maxConnections: 8
            })
            expect(config.publicUrl).toBe("https://room.example")
            expect(config.waitDefault).toBe(5)
            expect(config.waitMax).toBe(10)
            expect(config.idleTimeout).toBe(20)
            expect(config.sweepInterval).toBe(2)
            expect(config.emptyGrace).toBe(30)
            expect(config.maxConnections).toBe(8)
        })

        it("accepts an explicit null publicUrl", () => {
            const config = makeConfig({ ...REQUIRED, publicUrl: null })
            expect(config.publicUrl).toBeNull()
        })
    })

    context("immutability", () => {
        it("freezes the returned config", () => {
            const config = makeConfig(REQUIRED)
            expect(Object.isFrozen(config)).toBe(true)
        })

        it("rejects mutation of a field in strict mode", () => {
            const config = makeConfig(REQUIRED)
            expect(() => {
                ;(config as { port: number }).port = 9999
            }).toThrow()
        })
    })

    context("the idleTimeout > waitMax invariant", () => {
        it("builds when idleTimeout safely exceeds waitMax", () => {
            const config = makeConfig({ ...REQUIRED, waitMax: 10, idleTimeout: 20 })
            expect(config.idleTimeout).toBe(20)
        })

        it.each([
            ["idleTimeout below waitMax", 60, 30],
            ["idleTimeout equal to waitMax", 60, 60]
        ] as [string, number, number][])("throws given %s", (_label, waitMax, idleTimeout) => {
            expect(() => makeConfig({ ...REQUIRED, waitMax, idleTimeout })).toThrow(
                /idleTimeout .* must exceed waitMax/
            )
        })

        it("skips the assertion when idle drop is disabled (idleTimeout === 0)", () => {
            const config = makeConfig({ ...REQUIRED, waitMax: 60, idleTimeout: 0 })
            expect(config.idleTimeout).toBe(0)
        })
    })
})
