/**
 * lib/inject.ts — byte-exact context-injection hook runner for the context
 * injectors.
 *
 * Same stdin/event/no-op contract as lib/hook.ts `runHook`, but the emitted
 * envelope is serialized with lib/pyjson.ts to match Python's BARE
 * `json.dumps({...})` defaults (", "/": " separators + ensure_ascii). See
 * pyjson.ts for why hook.ts's compact emitter isn't byte-identical to these
 * injectors. Event precedence is identical to runHook:
 *   payload.hook_event_name (non-empty string) > options.event > "UserPromptSubmit".
 * A throwing/empty render is a silent `{}` no-op. The caller exits 0 unconditionally.
 */

import { injectionEnvelope } from "./pyjson.ts";

const DEFAULT_EVENT = "UserPromptSubmit";

/**
 * The knobs `runInjectionHook` needs: the rendering callback plus the fallback
 * event, with seams (`stdin`/`write`) so tests can drive it without real IO.
 */
export type RunInjectionOptions = {
  /** Fallback event when stdin omits hook_event_name (the manifest's --event). */
  event?: string;
  /** Produce additionalContext; non-empty string injects, null/"" is a no-op. */
  render: (payload: Record<string, unknown>) => string | null;
  /** Stdin source. Defaults to Bun.stdin. Override in tests. */
  stdin?: { text(): Promise<string> };
  /** Sink for the JSON line. Defaults to console.log. Override in tests. */
  write?: (line: string) => void;
};

/** Read stdin, resolve the event, emit the Python-faithful envelope (or `{}`). */
export const runInjectionHook = async (options: RunInjectionOptions): Promise<void> => {
  const { event, render } = options;
  const stdin = options.stdin ?? Bun.stdin;
  const write = options.write ?? ((line: string) => console.log(line));

  let payload: Record<string, unknown> = {};
  try {
    const raw = (await stdin.text()) || "{}";
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = {};
  }

  let eventName = event && event.length > 0 ? event : DEFAULT_EVENT;
  const fromPayload = payload.hook_event_name;
  if (typeof fromPayload === "string" && fromPayload.length > 0) {
    eventName = fromPayload;
  }

  let text: string | null;
  try {
    text = render(payload);
  } catch {
    text = null;
  }

  if (text == null || text.length === 0) {
    write("{}");
    return;
  }
  write(injectionEnvelope(eventName, text));
};
