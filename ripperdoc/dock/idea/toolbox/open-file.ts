#!/usr/bin/env bun
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { defineCommand, effect, execute } from "cmdore"
import { assertIdea } from "./assert-idea.ts"
import { launch, setPreview } from "./core"
import { boolean, integer } from "./core/coercers.ts"

export type OpenOptions = {
  line?: number
  column?: number | null
  wait?: boolean
  preview?: boolean
}

export const open = async (file: string, options?: OpenOptions): Promise<string | null> => {
  const { line = 1, column = null, wait = false, preview = false } = options ?? {}
  const target = path.resolve(file)
  const args = ["--line", String(line)]
  if (column !== null) {
    args.push("--column", String(column))
  }
  args.push(target)
  await effect(() => launch(args, { wait }))
  if (preview) {
    await effect(() => setPreview(target))
  }
  return wait ? await fs.readFile(file, { encoding: "utf8" }) : null
}

const command = defineCommand({
  name: "open-file",
  description: "Open a file in the running JetBrains IDE.",
  arguments: [{ name: "path", description: "file to open", required: true }],
  options: [
    { name: "line", arity: 1, hint: "n", description: "1-based caret line", coerce: integer },
    { name: "column", arity: 1, hint: "n", description: "1-based caret column", coerce: integer },
    { name: "wait", arity: 0, description: "block until the tab closes, then print the file back", coerce: boolean },
    { name: "preview", arity: 0, description: "flip the editor to the rendered preview", coerce: boolean },
  ],
  run: async ({ path: file, line, column, wait, preview }) => {
    assertIdea()
    const contents = await open(file, { line, column, wait, preview })
    if (contents !== null) {
      process.stdout.write(contents)
    }
  },
})

if (import.meta.main) {
  process.exit(await execute(command, { metadata: command }))
}
