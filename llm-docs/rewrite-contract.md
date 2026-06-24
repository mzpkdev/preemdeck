# Python → Bun/TypeScript Rewrite Contract (Phase 0)

The frozen interface every porting fixer imports. Implement against THESE signatures so ports don't diverge. Phase 0
added scaffold + `lib/` only; it deleted no `.py` and changed no invocation strings.

## Rule 0 — additive only (binding on every later phase until the flip phase)

- **Do NOT delete any `.py`.** The repo must still run on Python; `uv run pytest -q` must stay green (currently **475
  passed**).
- **Do NOT change any hook / plugin / SKILL invocation string.** Manifests still call the `.py` scripts.
- **Do NOT flip `boot.sh`'s `python3 install.py` handoff** — a later phase owns that.
- **Do NOT touch wire** (`ripperdoc/wetware/wire/server`, FastAPI) — it stays Python; uv/.venv/root-pyproject survive
  for it.
- Ports are validated against the **pinned Bun** below — not host bun. Target **macOS + Linux only** (Windows already
  removed).

## Pinned Bun runtime

- **`BUN_VERSION = 1.3.14`** (constant near the top of `boot.sh`). Bump deliberately; revalidate ports on bump.
- Fetched by `boot.sh` → `~/.preemdeck/.runtime/bin/bun` (model A "ship-the-runtime"). `.runtime/` is git-ignored.
- Asset slugs: Bun names ARM **`aarch64`** (not `arm64`) and uses **`x64`**; linux musl (Alpine / `ldd … musl`) takes
  the `-musl` asset. SHA256 verified against the release `SHASUMS256.txt` before unzip.

| Target          | Asset                        | SHA256                                                             |
| --------------- | ---------------------------- | ------------------------------------------------------------------ |
| darwin arm64    | `bun-darwin-aarch64.zip`     | `d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620` |
| darwin x64      | `bun-darwin-x64.zip`         | `4183df3374623e5bab315c547cfa0974533cd457d86b73b639f7a87974cd6633` |
| linux x64       | `bun-linux-x64.zip`          | `951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f` |
| linux x64 musl  | `bun-linux-x64-musl.zip`     | `14bd9aedeebf1dba67e8def9531c89bc989ecfdf1de42e5bfcaf1b8cd9294719` |
| linux aarch64   | `bun-linux-aarch64.zip`      | `a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b` |
| linux aarch64 m | `bun-linux-aarch64-musl.zip` | `b98e0ad3625c5c00d1d5b5ff55605c7adddbfae151861e68ade57b2d3b8703bb` |

Download base: `https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/`. Unsupported arch/OS → clear stderr note,
non-fatal (fetch is best-effort; install handoff still runs). The existing uv bootstrap block is untouched.

## The `preemdeck-bun` shim

- Path in the repo: `scripts/preemdeck-bun` (POSIX sh, executable).
- **Hooks/plugins/skills invoke it by its installed absolute path:** **`$HOME/.preemdeck/scripts/preemdeck-bun`** (the
  `~/.preemdeck` root every host's plugin copy nests under — same resolution `find_config` uses).
- Resolution: shipped runtime (`$HOME/.preemdeck/.runtime/bin/bun`) if executable → else host `bun` on PATH → else
  stderr error + exit 1.
- Invocation form: `"$HOME/.preemdeck/scripts/preemdeck-bun" "$PLUGIN_ROOT/scripts/<name>.ts" <args…>`.

## JS scaffold (do not edit `package.json`/`tsconfig.json` while porting — deps are pre-seeded)

- `package.json`: `"type":"module"`, `"name":"preemdeck"`, scripts `test`=`bun test`, `format`=`biome format --write .`,
  `lint`=`biome check .`. devDeps: `@biomejs/biome` (resolved **2.5.1**), `@types/bun`. `bun.lock` committed.
- `tsconfig.json`: `moduleResolution:"bundler"`, `types:["bun"]`, `strict`, `noUncheckedIndexedAccess`, `noEmit`,
  `allowImportingTsExtensions`, `verbatimModuleSyntax`.
- `biome.json`: 2-space, lineWidth 120, double quotes, semicolons always, trailing commas all. **Biome formats
  `.ts`/`.json`; ruff + mdformat (via uv) stay for `.py`/`.md`.**
- Everything else is **Bun built-in** — no new deps: `node:util` `parseArgs`, `Bun.spawn`, `Bun.file`/`Bun.write`,
  `node:fs/promises`, `bun:test`. Import sibling modules **with the `.ts` extension** (e.g. `from "./hook.ts"`).

## `lib/` — exact exports (THE contract)

### `lib/hook.ts` — injection-hook envelope (matches `inject_mode.py` / `inject_hook.py` byte-for-byte)

```ts
type HookPayload = Record<string, unknown>;
interface RunHookOptions {
  event?: string;                                   // --event fallback; default "UserPromptSubmit"
  render: (payload: HookPayload) => string | null;  // non-empty string => inject; null/"" => no-op
  stdin?: { text(): Promise<string> };              // DI for tests; default Bun.stdin
  write?: (line: string) => void;                   // DI for tests; default console.log
}
function runHook(options: RunHookOptions): Promise<void>;
```

- stdin → `JSON.parse` (empty/invalid/array/non-object → `{}`). Event precedence: **payload.hook_event_name (non-empty
  string) > `event` > "UserPromptSubmit"**.
- Emit, when `render` returns a non-empty string (compact `JSON.stringify`, byte-identical to Python `json.dumps`):
  `{"hookSpecificOutput":{"hookEventName":<event>,"additionalContext":<text>}}` — else emit `{}`. A throwing `render` is
  a no-op.
- Caller always `process.exit(0)` after it resolves (the host never blocks on a context hook).

### `lib/proc.ts` — spawn that ACTUALLY kills on timeout (resolves the install fixer's open question)

```ts
interface SpawnOptions {
  timeoutMs?: number;                       // omit/0 = no timeout
  cwd?: string;
  env?: Record<string, string | undefined>; // merged over process.env
  stdin?: string;
  killSignal?: NodeJS.Signals | number;     // default "SIGTERM"
}
interface SpawnResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; }
function spawn(cmd: string[], options?: SpawnOptions): Promise<SpawnResult>;
```

- On timeout: `child.kill(killSignal)` **then `await child.exited`** → child is reaped, not leaked; resolves
  `timedOut:true`. Never throws on non-zero exit (read `.exitCode`); throws only on empty argv. (Proven: `sleep 5` +
  200ms timeout returns in \<2s, exitCode≠0.)

### `lib/json-store.ts` — atomic `preemdeck.json` read/write (matches `set_mode.py`)

```ts
function readJson<T = unknown>(path: string, fallback?: T): Promise<T>;   // missing/invalid → fallback (default {})
function writeJson(path: string, data: unknown): Promise<void>;           // atomic
```

- `writeJson` serializes `JSON.stringify(data, null, 2) + "\n"`, writes `<path>.tmp`, then `rename` over the target —
  2-space indent + trailing newline, byte-identical to `set_mode.py`.

### `lib/text.ts` — html escape + forgiving URL parse

```ts
function htmlEscape(s: string): string;   // == Python html.escape(quote=True)
interface ParsedUrl { scheme: string; hostname: string | null; port: number | null; raw: string; }
function parseUrl(url: string): ParsedUrl; // never throws
```

- `htmlEscape`: `&`→`&amp;` (first), `<`→`&lt;`, `>`→`&gt;`, `"`→`&quot;`, `'`→`&#x27;`.
- `parseUrl`: wraps `new URL()`; on no host / parse failure returns `{scheme:"", hostname:null, port:null, raw:url}` —
  callers fall back to `raw` (preserves `urlsplit`'s "no host → return input"). `scheme` has no trailing colon,
  lowercased. Validators reject when `scheme` ∉ {"http","https"}.

### `lib/args.ts` — the CLI argument convention (`node:util` `parseArgs`; argparse-parity)

```ts
class UsageError extends Error {}
function usageError(prog: string, message: string): never;                              // "prog: msg\n" + exit 2
function parseOrExit<T>(prog: string, config: T): ReturnType<typeof parseArgs<T>>;       // parseArgs throw → exit 2
function parseIntArg(prog: string, name: string, raw: string): number;                  // argparse type=int; bad → exit 2
type Action = { name: string; arg: string | null };
type ActionSpec = Record<string, { needsArg: boolean }>;
function parseAction(value: string): Action;                                            // split on FIRST "=" only
function validateActions(prog: string, raw: string[] | undefined, spec: ActionSpec): Action[]; // whitelist; bad → exit 2
```

- Convention: positionals via `allowPositionals:true` → `result.positionals`; boolean flags `{type:"boolean"}`; int via
  `{type:"string"}` + `parseIntArg`; repeatable `--action` via `{type:"string", multiple:true}` → `validateActions`.
  **Usage errors exit 2** (argparse). NOTE: the int helper is `parseIntArg` (not `parseInt` — avoids shadowing the
  global).

## `bun test` mock patterns (copy these — established in the `*.test.ts`)

- **A — dependency injection** (`hook.test.ts`): pass fakes (`stdin`/`write`) into the unit; no global patching.
  Preferred.
- **B — `spyOn` a global** (`hook.test.ts`): `const spy = spyOn(console, "log").mockImplementation(() => {})`; always
  `spy.mockRestore()` in `finally`.
- **C — `mock.module`** (`hook.test.ts`): `mock.module("./dep.ts", () => ({ … }))` to stub a whole import; must run
  before the consumer imports it.
- **D — real subprocess + timing** (`proc.test.ts`): drive a real child, assert wall-clock (`performance.now()`) to
  prove a kill landed.
- **E — tmp fixture** (`json-store.test.ts`): `mkdtemp` in `beforeEach`, `rm(dir,{recursive,force})` in `afterEach`;
  real FS over mocking `fs`.
- **F — `spyOn(process,"exit")`** (`args.test.ts`): replace `exit` with a thrown sentinel + spy `process.stderr.write`
  to assert exit codes without killing the runner. THE pattern for CLI exit-code tests.

## Verify (Phase 0, real output)

- `bun install` → ok, `bun.lock` written, Biome 2.5.1 + `@types/bun` installed.
- `bun test lib/` → **39 pass / 0 fail** (66 expects). `tsc --noEmit` → 0 errors. `biome check lib/ scripts/` → clean.
- boot.sh fetch in scratch `HOME=$(mktemp -d)` → darwin-aarch64 asset downloaded, **SHA256 verified**, unzipped to
  `~/.preemdeck/.runtime/bin/bun`, `bun --version` → `1.3.14`; 2nd call is idempotent (skips).
- `uv run pytest -q` → **475 passed** (Python untouched).
