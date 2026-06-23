/**
 * idea_linux.ts — JetBrains IDE detection for the idea toolbox (Linux), not
 * implemented yet.
 *
 * Stub module: mirrors the macOS surface (inIdea, resolveExecPath,
 * resolveLogDir), but every entry point throws NotImplementedError for now.
 * Port of core/idea_linux.py.
 */

import { NotImplementedError } from "./_errors.ts";

/** True when this terminal was launched by a JetBrains IDE — unimplemented on Linux. */
export function inIdea(): boolean {
  throw new NotImplementedError("inIdea is not implemented for Linux yet");
}

/** Absolute path to the JetBrains IDE binary this process is running inside — unimplemented on Linux. */
export function resolveExecPath(): string {
  throw new NotImplementedError("resolveExecPath is not implemented for Linux yet");
}

/** Log dir of the IDE this process is running inside — unimplemented on Linux. */
export function resolveLogDir(): string {
  throw new NotImplementedError("resolveLogDir is not implemented for Linux yet");
}
