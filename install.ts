#!/usr/bin/env bun
import { main } from "./src/install/install"

if (import.meta.main) {
    process.exit(await main(Bun.argv.slice(2), import.meta.dir))
}
