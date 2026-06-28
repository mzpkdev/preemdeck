import { readFileSync } from "node:fs"

type Row = { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown } }

const read = (path: string): string => {
    try {
        return readFileSync(path, "utf8")
    } catch {
        return ""
    }
}

const parse = (line: string): Row | null => {
    try {
        return JSON.parse(line)
    } catch {
        return null
    }
}

const promptText = (row: Row | null): string | null => {
    if (row?.type !== "user" || row.isMeta || row.isSidechain) return null
    const content = row.message?.content
    return typeof content === "string" ? content : null
}

// TODO: Claude-only — Codex/Gemini transcripts use a different schema, so throttle
// there fails open (injects every turn) until per-host readers are added.
export const throttle = (payload: Record<string, unknown>, every: number): boolean => {
    const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : ""
    const prompt = typeof payload.prompt === "string" ? payload.prompt : ""
    const prompts = read(transcriptPath)
        .split("\n")
        .map((line) => promptText(parse(line)))
        .filter((text): text is string => text !== null)
    const last = prompts.at(-1)
    const written = last !== undefined && (!prompt || last.trim() === prompt.trim())
    const index = written ? prompts.length : prompts.length + 1
    return (index - 1) % Math.max(1, every) === 0
}
