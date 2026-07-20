import { describe, expect, it } from "bun:test"

describe("Codex overlay config", () => {
    it("automatically reviews approvals without disabling the workspace sandbox", async () => {
        const source = await Bun.file(new URL("./config.toml", import.meta.url)).text()
        const config = Bun.TOML.parse(source)

        expect(config).toMatchObject({
            approval_policy: "on-request",
            approvals_reviewer: "auto_review",
            sandbox_mode: "workspace-write",
            sandbox_workspace_write: { network_access: true }
        })
    })
})
