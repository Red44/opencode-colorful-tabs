import { describe, expect, it } from "bun:test"
import { createBgShellAlias } from "../index"

/**
 * Mocked alias wrapper tests only — no commands are executed here. The mock
 * stands in for the built-in `shell` executor; live behavior (permissions,
 * job notification) is owned by the host and validated there.
 */
describe("opencode_bg_shell alias wrapper", () => {
  it("fails closed when the built-in shell executor is not exposed", () => {
    expect(createBgShellAlias(undefined)).toBeUndefined()
    expect(createBgShellAlias({} as never)).toBeUndefined()
    expect(createBgShellAlias({ execute: "not-a-function" } as never)).toBeUndefined()
  })

  it("registers as opencode.bg_shell with command/workdir/timeout only", () => {
    const alias = createBgShellAlias({ execute: async () => ({}) })!
    expect(alias.name).toBe("bg_shell")
    expect(alias.options).toEqual({ namespace: "opencode", codemode: true })
    expect(Object.keys(alias.input.properties).sort()).toEqual(["command", "timeout", "workdir"])
    expect(alias.input.required).toEqual(["command"])
    expect(alias.input.properties.background).toBeUndefined()
  })

  it("forces background: true and forwards command/workdir/timeout plus context", async () => {
    const calls: Array<{ input: unknown; context: unknown }> = []
    const result = { output: "moved to background", shellID: "sh_1", status: "running" }
    const context = { sessionID: "ses_target", progress: async () => {} }
    const alias = createBgShellAlias({
      execute: async (input, ctx) => {
        calls.push({ input, context: ctx })
        return result
      },
    })!

    const returned = await alias.execute({ command: "sleep 5", workdir: "/tmp/x", timeout: 1000 }, context)
    expect(calls).toHaveLength(1)
    expect(calls[0].input).toEqual({ command: "sleep 5", workdir: "/tmp/x", timeout: 1000, background: true })
    expect(calls[0].context).toBe(context)
    expect(returned).toBe(result)
  })

  it("reports built-in failures as content instead of throwing", async () => {
    const alias = createBgShellAlias({
      execute: async () => {
        throw new Error("permission denied")
      },
    })!
    const returned = await alias.execute({ command: "true" }, {})
    expect(returned).toEqual({ content: "bg_shell failed: permission denied" })
  })
})
