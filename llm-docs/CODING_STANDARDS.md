# TypeScript Coding Standards

How we write TypeScript here. Skim freely — every section stands alone. Target: the repo's source (`lib/`, `scripts/`,
`ripperdoc/`), which runs on a **pinned Bun** as native ESM.

---

## Tooling — decided, not re-litigated

The repo settles these for you. State them, don't argue them.

| Concern       | Tool / setting                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------- |
| Runtime       | Bun (pinned `1.3.14`), via `scripts/preemdeck-bun`. Native `.ts`, no build step.               |
| Module system | ESM only (`"type": "module"`). No CommonJS, no `require`.                                      |
| Format + lint | Biome — `bun run format` (write), `bun run lint` (check). CI enforces.                         |
| Tests         | `bun test` — `bun:test` API, files colocated as `*.test.ts`.                                   |
| Type-check    | `tsgo` (`@typescript/native-preview`, pinned) — `bun run typecheck` (`--noEmit`). CI enforces. |

**Biome formatting** (don't hand-format against it): 2-space indent, 120-column lines, double quotes, semicolons
as-needed (omitted where optional), trailing commas everywhere, `recommended` lint rules on.

**tsconfig is `strict`** plus extras that change how you write code:

- `noUncheckedIndexedAccess` — `arr[i]` is `T | undefined`. Guard or narrow before use; don't assume the index is there.
- `verbatimModuleSyntax` — type-only imports **must** say `import type`. The linter won't paper over it.
- `allowImportingTsExtensions` — relative imports carry the **`.ts`** extension (see
  [Modules & imports](#modules--imports)).
- `noFallthroughCasesInSwitch` — every `case` ends in `break`/`return`/`throw`.

---

## Naming

| Kind                    | Style                | Example                              |
| ----------------------- | -------------------- | ------------------------------------ |
| File / module           | `kebab-case`         | `os-notify.ts`, `render-dispatch.ts` |
| Test file               | `kebab-case.test.ts` | `args.test.ts`, `proc.test.ts`       |
| Function / method       | `camelCase` verb     | `parseAction`, `runCmd`              |
| Variable                | `camelCase` noun     | `costPrice`                          |
| Type / type-alias       | `PascalCase` noun    | `SpawnOptions`, `Action`             |
| Constant (module-level) | `UPPER_SNAKE` noun   | `DEFAULT_MARGIN_PERCENT`             |
| Test-seam object        | leading `_`          | `_internals`                         |

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

The **only** leading underscore we keep is the `_internals` test seam (see [Testing](#testing)). Filenames and private
helpers do **not** get a `_` prefix — privacy comes from module boundaries, not from a marker (see
[Modules & imports](#modules--imports)).

---

## Modules & imports

ESM, native, no bundler step. A few hard rules:

```ts
// 1. Relative imports ALWAYS carry the .ts extension (allowImportingTsExtensions).
import { runCmd } from "../lib/proc.ts";

// 2. Node stdlib ALWAYS uses the node: prefix.
import { parseArgs } from "node:util";
import { writeFile, rename } from "node:fs/promises";

// 3. Type-only imports say `import type` (verbatimModuleSyntax requires it).
import type { Action } from "../lib/args.ts";

// 4. Named imports only — never `import * as`.
import { notifyMacos } from "./os-notify.ts";
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
type SpawnOptions = {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
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
  type ParsedUrl = {
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
export const parseAction = (spec: string): Action => {
  const [name, arg = ""] = spec.split(":", 2);
  return { name, arg };
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
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
```

- **Throw, don't return Result types.** Errors propagate; control flow stays clean. Catch with `instanceof` to
  categorize.

  ```ts
  try {
    await launch(target);
  } catch (err) {
    if (err instanceof UsageError) return usage(err.message);
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
  if (typeof raw !== "object" || raw === null) throw new UsageError("expected a JSON object");
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.items)) throw new UsageError("`items` must be a list");
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
 * Transform an int into its labelled string form.
 * Mirrors the reference `transform()` byte-for-byte (see py-json parity notes).
 */
export const transform = (n: number): string => {
  if (n < 0) throw new UsageError(`${n} must be non-negative`);
  return `The input was ${n}`;
};
```

- **Inline comments explain WHY, not WHAT.** If a comment narrates mechanics, the code wants a better name instead.
- **No commented-out code.** Git remembers.
- **`TODO:` only if you actually plan to return.** Otherwise fix it now or file an issue.
- Module-header comments are welcome where a file's purpose or a non-obvious decision (e.g. reference parity) needs
  stating.

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
  throw new UsageError(`unknown category ${category}`);
};

// Prefer — data-driven, open to extension
const RATES = { standard: 0.03, premium: 0.05 } as const;
const getRate = (category: keyof typeof RATES): number => RATES[category];
```

---

## Testing

`bun:test`, files colocated next to source as `*.test.ts`.

```ts
import { describe, expect, spyOn, test } from "bun:test";
import { parseAction } from "./args.ts";

// Plain expect — describe groups, test names describe BEHAVIOR.
describe("parseAction", () => {
  test("splits name from arg on the first colon", () => {
    expect(parseAction("open:file.ts")).toEqual({ name: "open", arg: "file.ts" });
  });
});
```

**Make units testable by design — two seams, in order of preference:**

1. **Dependency injection (default).** Accept collaborators as optional params with defaults; the test passes fakes. No
   global state, fully hermetic.

   ```ts
   export const diffFile = (path: string, deps = { run: runCmd }) => deps.run(["diff", path]);

   test("invokes diff with the path", async () => {
     const run = spyOn({ run: async () => 0 }, "run");
     await diffFile("a.ts", { run });
     expect(run).toHaveBeenCalledWith(["diff", "a.ts"]);
   });
   ```

2. **`_internals` seam object (fallback).** When DI is awkward — module-level singletons, side-effecting imports —
   export an `_internals` object holding the overridable functions, and have the module call through it. Tests mutate it
   and **restore in `afterEach`** (one shared `bun test` process; leaks bleed across files).
   ```ts
   export const _internals = { launch, readFile };
   // module code calls _internals.launch(...), never launch directly
   ```

Other conventions:

- **Test names describe behavior** (`splits name from arg on the first colon`), not implementation.
- **Golden-value tests** for parity-critical code — hardcode the expected reference output and assert byte equality (see
  the `py-json` suite).
- **Bump the timeout** for genuinely slow cases: `test("spawns a subprocess", async () => { ... }, 10_000)`.
- Don't mock the unit under test — only its collaborators.

---

## Quick checklist

```
Tooling    ── Biome-formatted (2sp/120/double-quote/no-semi); strict tsconfig; bun test
Naming     ── kebab-case files; camelCase fns; PascalCase types; UPPER_SNAKE consts
Imports    ── .ts extension always; node: prefix; `import type`; named only; facade index.ts
Types      ── `type` not `interface`; `unknown` not `any`; union literals not enums; lenient-in/strict-out
Functions  ── arrows everywhere; stepdown order; small + single-responsibility; deps injected
Errors     ── custom Error subclasses w/ .name; throw not Result; validate external input only
Async      ── async/await; Bun.spawn/file/which; node:fs/promises; no *Sync
CLI        ── shebang; main(): Promise<number>; process.exit only under import.meta.main
Comments   ── JSDoc on all public exports; WHY not WHAT; no zombie code
Tests      ── bun:test; colocated *.test.ts; DI-first then _internals; restore in afterEach
```
