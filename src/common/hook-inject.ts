/**
 * hook-inject.ts — context-injection hook runner for the context injectors.
 *
 * Same stdin/event/no-op contract as lib/hook.ts `runHook`. The envelope is
 * emitted with native `JSON.stringify` — the host JSON-parses stdout, so the
 * exact byte framing (separator spacing / ascii-escaping) is irrelevant.
 * Event precedence is identical to runHook:
 *   payload.hook_event_name (non-empty string) > options.event.
 * A throwing/empty render is a silent `{}` no-op. The caller exits 0 unconditionally.
 */

/**
 * The knobs `runInjectionHook` needs: the rendering callback plus the host
 * event, with seams (`stdin`/`write`) so tests can drive it without real IO.
 */
export type RunInjectionOptions = {
    /** Host event, always supplied by the caller/manifest; stdin's hook_event_name overrides it. */
    event: string
    /** Produce additionalContext; non-empty string injects, null/"" is a no-op. May be async (e.g. an IDE read). */
    render: (payload: Record<string, unknown>) => string | null | Promise<string | null>
    /** Stdin source. Defaults to Bun.stdin. Override in tests. */
    stdin?: { text(): Promise<string> }
    /** Sink for the JSON line. Defaults to console.log. Override in tests. */
    write?: (line: string) => void
}

/** Read stdin, resolve the event, emit the JSON envelope (or `{}`). */
export const runInjectionHook = async (options: RunInjectionOptions): Promise<void> => {
    const { event, render } = options
    const stdin = options.stdin ?? Bun.stdin
    const write = options.write ?? ((line: string) => console.log(line))

    const payload = parsePayload((await stdin.text()) || "{}")
    const fromPayload = payload.hook_event_name
    const eventName = typeof fromPayload === "string" && fromPayload.length > 0 ? fromPayload : event

    const text = await tryRender(render, payload)
    if (!text) {
        write("{}")
        return
    }
    write(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } }))
}

/** Parse stdin JSON into a plain object; invalid or non-object input → `{}`. */
const parsePayload = (raw: string): Record<string, unknown> => {
    try {
        const parsed: unknown = JSON.parse(raw)
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {}
    } catch {
        return {}
    }
}

/** Run the render callback (sync or async); a throw/rejection becomes `null` (a silent no-op upstream). */
const tryRender = async (
    render: RunInjectionOptions["render"],
    payload: Record<string, unknown>
): Promise<string | null> => {
    try {
        return await render(payload)
    } catch {
        return null
    }
}
