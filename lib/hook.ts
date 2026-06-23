/**
 * lib/hook.ts — context-injection hook envelope, byte-compatible with the Python
 * injectors (ripperdoc/wetware/{directive/scripts/inject_mode,imprint/scripts/inject_hook}.py).
 *
 * Contract for porting fixers: every UserPromptSubmit/SessionStart/BeforeAgent
 * injector hook reads its JSON payload from stdin, decides what (if anything) to
 * inject via a `render` callback, and emits the SAME envelope the Python emits:
 *
 *     {"hookSpecificOutput":{"hookEventName":<event>,"additionalContext":<text>}}
 *
 * ...or `{}` when there's nothing to inject. Always exit 0 — a host must never
 * block on a context hook (matches the Python `print("{}"); return 0` no-op).
 *
 * Event resolution mirrors the Python precedence EXACTLY:
 *   1. payload.hook_event_name, when it's a non-empty string  (stdin always wins)
 *   2. the `event` option                                     (the manifest's --event)
 *   3. "UserPromptSubmit"                                     (DEFAULT_EVENT)
 */

const DEFAULT_EVENT = "UserPromptSubmit";

export type HookPayload = Record<string, unknown>;

export interface RunHookOptions {
  /**
   * Fallback event label when the stdin payload omits `hook_event_name`. This is
   * the `--event` value the manifest passes; stdin still wins over it.
   * Defaults to "UserPromptSubmit".
   */
  event?: string;
  /**
   * Produce the `additionalContext` body from the parsed payload. Return a
   * non-null, non-empty string to inject it; return `null` (or an empty string)
   * for a silent no-op (`{}`). Mirrors the Python `if not text: return 0` guard.
   */
  render: (payload: HookPayload) => string | null;
  /** Stdin source. Defaults to `Bun.stdin`. Override in tests. */
  stdin?: { text(): Promise<string> };
  /** Sink for the JSON line. Defaults to `console.log`. Override in tests. */
  write?: (line: string) => void;
}

/**
 * Read stdin, resolve the event, and emit the injection envelope (or `{}`).
 * Never throws and never returns non-zero intent: the caller should
 * `process.exit(0)` unconditionally after this resolves, exactly as the Python
 * `sys.exit(main())` does where `main` always returns 0.
 */
export async function runHook(options: RunHookOptions): Promise<void> {
  const { event, render } = options;
  const stdin = options.stdin ?? Bun.stdin;
  const write = options.write ?? ((line: string) => console.log(line));

  // Parse stdin -> object. Empty or invalid input degrades to {} (matches the
  // Python `json.loads(sys.stdin.read() or "{}")` + try/except no-op).
  let payload: HookPayload = {};
  try {
    const raw = (await stdin.text()) || "{}";
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as HookPayload;
    }
  } catch {
    payload = {};
  }

  // Event precedence: payload.hook_event_name (non-empty string) > event > default.
  let eventName = event && event.length > 0 ? event : DEFAULT_EVENT;
  const fromPayload = payload.hook_event_name;
  if (typeof fromPayload === "string" && fromPayload.length > 0) {
    eventName = fromPayload;
  }

  let text: string | null;
  try {
    text = render(payload);
  } catch {
    // A render failure is a no-op, never a host-blocking error.
    text = null;
  }

  if (text == null || text.length === 0) {
    write("{}");
    return;
  }

  write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: text,
      },
    }),
  );
}
