/**
 * fs.ts — tiny filesystem helper shared by the mirror builder and the overlay copier.
 */

import { readdirSync } from "node:fs"
import { join } from "node:path"

/** Recursively collect every regular file under `root` (absolute paths). */
export function walkFiles(root: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const full = join(root, entry.name)
        if (entry.isDirectory()) {
            out.push(...walkFiles(full))
        } else if (entry.isFile()) {
            out.push(full)
        }
    }
    return out
}
