# TypeScript Coding Standards

How we write TypeScript here. Skim freely — every section stands alone. Target: the repo's source (`source/common/`,
`devscripts/`, `source/ripperdoc/`), which runs on a **pinned Bun** as native ESM.

---

## Tooling — decided, not re-litigated

The repo settles these for you. State them, don't argue them.

| Concern       | Tool / setting                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------- |
| Runtime       | Bun (pinned `1.3.14`), via `preemdeck-runtime`. Native `.ts`, no build step.                   |
| Module system | ESM only (`"type": "module"`). No CommonJS, no `require`.                                      |
| Format + lint | Biome — `bun run format` (write), `bun run lint` (check). CI enforces.                         |
| Tests         | `bun test` — `bun:test` API, files colocated as `*.spec.ts`.                                   |
| Type-check    | `tsgo` (`@typescript/native-preview`, pinned) — `bun run typecheck` (`--noEmit`). CI enforces. |

**Biome formatting** (don't hand-format against it): 2-space indent, 120-column lines, double quotes, semicolons
as-needed (omitted where optional), trailing commas everywhere, `recommended` lint rules on.

**tsconfig is `strict`** plus extras that change how you write code:

- `noUncheckedIndexedAccess` — `arr[i]` is `T | undefined`. Guard or narrow before use; don't assume the index is there.
- `verbatimModuleSyntax` — type-only imports **must** say `import type`. The linter won't paper over it.
- `noFallthroughCasesInSwitch` — every `case` ends in `break`/`return`/`throw`.

---

## Naming

| Kind                    | Style                | Example                                |
| ----------------------- | -------------------- | -------------------------------------- |
| File / module           | `kebab-case`         | `os-notify.ts`, `render-dispatch.ts`   |
| Test file               | `kebab-case.spec.ts` | `process.spec.ts`, `open-file.spec.ts` |
| Function / method       | `camelCase` verb     | `reap`, `runCmd`                       |
| Variable                | `camelCase` noun     | `costPrice`                            |
| Type / type-alias       | `PascalCase` noun    | `Reaped`, `Level`                      |
| Constant (module-level) | `UPPER_SNAKE` noun   | `DEFAULT_MARGIN_PERCENT`               |

Names explain themselves — no truncation gymnastics, no magic numbers.

```ts
// Avoid
const DEF_MARG_PERC = 50;
return cost * (1 + 50 / 100);

// Prefer
const DEFAULT_MARGIN_PERCENT = 50;
return cost * (1 + DEFAULT_MARGIN_PERCENT / 100);
```

Stay consistent with verbs — `getName` and `getCostPrice`, not `getName` and `fetchCostPrice`.

**No leading underscores.** Filenames and private helpers do **not** get a `_` prefix — privacy comes from module
boundaries, not from a marker (see [Modules & imports](#modules--imports)).

---

## Modules & imports

ESM, native, no bundler step. A few hard rules:

```ts
// 1. Relative imports are extensionless — Bun + bundler resolution add `.ts`.
import { runCmd } from "../source/common/process";

// 2. Node stdlib ALWAYS uses the node: prefix.
import { parseArgs } from "node:util";
import { writeFile, rename } from "node:fs/promises";

// 3. Type-only imports say `import type` (verbatimModuleSyntax requires it).
import type { Reaped } from "../source/common/process";
```

Group imports by origin, blank-line-separated: **stdlib (`node:`/`bun`) → external deps → local (`./`, `../`)**.

**Privacy = the public facade, not a filename marker.** A directory with internals exposes a curated `index.ts` that
re-exports its public API; everything else is internal and not imported across the boundary.

```
toolbox/core/
├── index.ts        # public API — the only entry other dirs import from
├── launch.ts       # internal — reached only via index.ts within core/
└── reap.ts         # internal
```

No barrel files for their own sake — an `index.ts` exists to _mark a boundary_, not to re-export a flat directory.

---

## Types

**Use `type` for everything** — object shapes, unions, function signatures, aliases. We don't use `interface`. One
construct, uniform mental model.

```ts
// Object shapes
type Reaped = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

// Union literals instead of enums
type Level = "info" | "warning" | "error";

// Function signatures
type Spawn = (argv: string[]) => Bun.Subprocess;

// Aliases for readable signatures
type Coordinate = [number, number];
```

Other rules:

- **`unknown`, never `any`.** Parse into `unknown`, then narrow. `any` is a hole in the type system; if you truly need
  an escape hatch, comment why.
- **`| null` vs `?`** — use `?` for "the caller may omit this"; use `| null` when _absence is a real, distinct state_
  the value can hold and you want it explicit.
  ```ts
  type Endpoint = {
    host: string | null; // genuinely may have no host — explicit
    port?: number; // optional input, defaulted downstream
  };
  ```
- **Union literals over `enum`.** They erase cleanly, narrow well, and need no runtime object.
- **`as const`** for fixed literal tuples/option tables, so they type as their narrow literal form.
- **Lenient inputs, strict outputs.** Accept `Iterable`/`ReadonlyArray`/`Record` in parameters; return concrete
  `Array`/`Record`/the exact shape. Don't make callers over-specify; don't make them guess what you hand back.

---

## Functions: arrows, shape, size

**Arrow functions, uniformly** — `const fn = (...) => ...`, including top-level exports.

```ts
export const splitOnce = (spec: string): [string, string] => {
  const [name, arg = ""] = spec.split(":", 2);
  return [name, arg];
};

items.map((item) => item.id);
const run = deps.run ?? runCmd;
```

**Newspaper / stepdown order still holds.** Put the public entry point on top, helpers below — an arrow's body resolves
its references at _call_ time, so `main` can reference a `helper` defined further down. The one rule: don't _invoke_ at
module-evaluation time before the const is assigned. CLI entry points fire from the `import.meta.main` guard at the very
bottom of the file, so the order is always safe.

```ts
export const calculateSalePrice = (car: Car): number =>
  // top: public intent
  priceBeforeTax(car) * taxesFactor(car);

const priceBeforeTax = (car: Car): number =>
  // one level down
  car.costPrice * (1 + DEFAULT_MARGIN_PERCENT / 100);

const taxesFactor = (car: Car): number => {
  // one level down
  const taxes = DEFAULT_TAX + (car.imported ? DEFAULT_IMPORT_TAX : 0);
  return 1 + taxes / 100;
};
```

**A `never`-returning arrow (`throw`/`process.exit`) needs `=> never` on the binding's _type_, not inline on the
lambda** — write `const die: (m: string) => never = (m) => {…}`, not `const die = (m): never => {…}`. Only the typed
binding drives call-site control-flow analysis; the inline form leaves callers seeing phantom fall-through (spurious
`used before assigned` / `lacks return`). A `function` declaration doesn't have this, so a blind `function`→arrow swap
can regress it — `bun run typecheck` catches it; Biome and `bun test` don't.

- Aim for **under 20 lines**, ideal under 5. **One level of abstraction per function.**
- **Dependency injection via an options/deps object** — collaborators come in as parameters (with defaults), not as hard
  imports. This is what makes units testable without module mocking (see [Testing](#testing)).
  ```ts
  export const diffFile = (path: string, deps = { run: runCmd }): Promise<number> => deps.run(["diff", path]);
  ```

### Shrink long conditionals

Extract predicates or name the condition:

```ts
// Avoid
if (oil > 3 && fuel > 5 && rightDoor === "closed" && leftDoor === "closed") { ... }

// Prefer — named booleans / extracted predicates
const levelsOk = oil > 3 && fuel > 5
const doorsClosed = rightDoor === "closed" && leftDoor === "closed"
if (levelsOk && doorsClosed) { ... }
```

---

## Errors & boundaries

**Custom `Error` subclasses for domain errors**, each setting `.name` so callers and logs can identify them precisely.

```ts
export class ModesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModesError";
  }
}
```

- **Throw, don't return Result types.** Errors propagate; control flow stays clean. Catch with `instanceof` to
  categorize.

  ```ts
  try {
    await launch(target);
  } catch (err) {
    if (err instanceof ModesError) return warn(err.message);
    throw err; // not ours — let it fly
  }
  ```

- **Catch the specific thing.** Never a bare `catch` that swallows everything. If you intentionally swallow (best-effort
  work), say why in a comment.

- **Validate at boundaries** — external input only: CLI args, env, files, network, parsed JSON. Trust internal calls; a
  wrong internal call is a _bug_ to fix, not a runtime branch.

  Manual type guards are the norm — no schema library by default. Reach for `zod`/`valibot` **only** when a boundary is
  genuinely complex or deeply nested; for the common flat cases, guards are lighter and add no dependency.

  ```ts
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) throw new ModesError("expected a JSON object");
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.items)) throw new ModesError("`items` must be a list");
  ```

---

## Async & the Bun runtime

- **`async`/`await` only** — no raw `.then()` chains.
- **Prefer Bun's native APIs** over reaching for Node equivalents where Bun has one: | Need | Use | | ---------------- |
  ----------------------------------- | | Spawn a process | `Bun.spawn(...)` | | Read a file | `Bun.file(path).text()` /
  `.json()` | | Resolve on PATH | `Bun.which("git")` | | CLI args / stdin | `Bun.argv` / `Bun.stdin` |
- For filesystem writes and mutations, **`node:fs/promises`** (`writeFile`, `rename`, `readdir`) layered on top is fine.
- **No synchronous I/O** in normal paths (`*Sync` calls) — async throughout.

---

## CLI entry points

Scripts that run directly follow one shape — testable, with the exit code owned by the caller.

```ts
#!/usr/bin/env bun
// `main` returns a number; it does NOT call process.exit itself.
export const main = async (argv: string[]): Promise<number> => {
  const action = parseArgs(argv);
  if (!action) return 1;
  await run(action);
  return 0;
};

// Only the bottom guard touches the process — and it's the only call at eval time.
if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
```

- `main` returns the exit code; the `import.meta.main` guard is the single place that calls `process.exit`. This keeps
  `main` unit-testable (assert the returned code, no process teardown).
- Shebang `#!/usr/bin/env bun` on every executable script.

---

## Comments & docs

**JSDoc on every public (exported) function and type.** Hover docs everywhere is the bar — even short ones earn their
keep. Prose blocks with embedded examples; we don't use `@param`/`@returns` tag soup.

```ts
/**
 * Transform a non-negative int into its labelled string form.
 */
export const transform = (n: number): string => {
  if (n < 0) throw new ModesError(`${n} must be non-negative`);
  return `The input was ${n}`;
};
```

- **Inline comments explain WHY, not WHAT.** If a comment narrates mechanics, the code wants a better name instead.
- **No commented-out code.** Git remembers.
- **`TODO:` only if you actually plan to return.** Otherwise fix it now or file an issue.
- Module-header comments are welcome where a file's purpose or a non-obvious decision (e.g. why a timeout kills _and_
  awaits the child) needs stating.

---

## Design principles, on one screen

Language-agnostic, still load-bearing:

- **Single responsibility.** One module/function, one reason to change. Don't fold notification-sending into a parser.
- **Validate at the edges, trust the core.** Guard external input once at the boundary; internal calls are trusted.
- **Lenient in, strict out.** Accept the widest reasonable input type; return the most concrete, predictable shape.
- **Depend on abstractions.** Take the injected `deps`/options shape (`{ run }`), not a hard-wired concrete import — the
  same seam that powers DI powers testability.
- **Extend by adding, not by branching.** A growing `if/else`/`switch` ladder over a "kind" field is a smell; prefer a
  lookup table of behaviors or small per-case functions.

```ts
// Avoid — the ladder grows with every new category
const getRate = (category: string): number => {
  if (category === "standard") return 0.03;
  if (category === "premium") return 0.05;
  throw new ModesError(`unknown category ${category}`);
};

// Prefer — data-driven, open to extension
const RATES = { standard: 0.03, premium: 0.05 } as const;
const getRate = (category: keyof typeof RATES): number => RATES[category];
```

---

## Testing

`bun:test`, files colocated next to source as `*.spec.ts`.

One top-level `describe("<subject>")`; nest `context("when …")` for situations and `it("…")` for behavior. Titles are
lowercase and describe behavior, not implementation. Alias `context` to `describe` once at module top so the nesting
reads as prose. Use `it.each([...] as [...][])` for argument matrices. Never bare `test()`.

```ts
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { splitOnce } from "./split-once.ts";

const context = describe;

describe("splitOnce", () => {
  context("when the input has a colon", () => {
    it("splits name from arg on the first colon only", () => {
      expect(splitOnce("open:a:b")).toEqual(["open", "a:b"]);
    });
  });

  context("when the input has no colon", () => {
    it("returns the whole string as the name and an empty arg", () => {
      expect(splitOnce("open")).toEqual(["open", ""]);
    });
  });

  it.each([
    ["open:file.ts", ["open", "file.ts"]],
    ["a:", ["a", ""]],
  ] as [string, [string, string]][])("splits %p into %p", (input, expected) => {
    expect(splitOnce(input)).toEqual(expected);
  });
});
```

**Make units testable by design — two seams, in order of preference:**

1. **Dependency injection (default).** Accept collaborators as optional params with defaults; the test passes fakes. No
   global state, fully hermetic.

   ```ts
   export const diffFile = (path: string, deps = { run: runCmd }) => deps.run(["diff", path]);

   it("invokes diff with the path", async () => {
     const run = spyOn({ run: async () => 0 }, "run");
     await diffFile("a.ts", { run });
     expect(run).toHaveBeenCalledWith(["diff", "a.ts"]);
   });
   ```

2. **`spyOn` for native / module-level calls (fallback).** When a unit reaches a global or imported function that can't
   be passed in as a `dep` — `Bun.spawn`, an imported `writeFile`, the install/trash/uninstall side-effects — `spyOn`
   the collaborator and supply a mock implementation. **Restore in `afterEach`** (one shared `bun test` process; leaks
   bleed across files).
   ```ts
   const spawn = spyOn(Bun, "spawn").mockImplementation(
     () => ({ exited: Promise.resolve(0), stdout: "", stderr: "" }) as unknown as Bun.Subprocess,
   );
   afterEach(() => spawn.mockRestore());
   ```

Other conventions:

- **Test names describe behavior** (`splits name from arg on the first colon`), not implementation.
- **Golden-value tests** for deterministic generated output (e.g. generated Groovy scripts, rendered ASCII panels) —
  hardcode the expected string and assert byte equality (see `preview.spec.ts` and `render-dispatch.spec.ts`).
- **Bump the timeout** for genuinely slow cases: `it("spawns a subprocess", async () => { ... }, 10_000)`.
- Don't mock the unit under test — only its collaborators.

---

## Quick checklist

```
Tooling    ── Biome-formatted (2sp/120/double-quote/no-semi); strict tsconfig; bun test
Naming     ── kebab-case files; camelCase fns; PascalCase types; UPPER_SNAKE consts
Imports    ── extensionless relative imports; node: prefix; `import type`; facade index.ts
Types      ── `type` not `interface`; `unknown` not `any`; union literals not enums; lenient-in/strict-out
Functions  ── arrows everywhere; stepdown order; small + single-responsibility; deps injected
Errors     ── custom Error subclasses w/ .name; throw not Result; validate external input only
Async      ── async/await; Bun.spawn/file/which; node:fs/promises; no *Sync
CLI        ── shebang; main(): Promise<number>; process.exit only under import.meta.main
Comments   ── JSDoc on all public exports; WHY not WHAT; no zombie code
Tests      ── bun:test; colocated *.spec.ts; DI-first; spyOn for native/module seams; restore in afterEach
```
