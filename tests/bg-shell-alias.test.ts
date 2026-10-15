import { describe, expect, it } from "bun:test"
import { createBgShellAlias } from "../index"

/**
 * Mocked alias wrapper tests only — no commands are executed here. The mock
 * stands in for the built-in `shell` executor; live behavior (permissions,
 * job notification) is owned by the host and validated there.
 */
describe("opencode_bg_shell alias wrapper", () => {
  const outputSchema = {
    type: "object",
    properties: {
      output: { type: "string" },
      shellID: { type: "string" },
      status: { type: "string", enum: ["running", "completed"] },
    },
  }

  it("fails closed when the built-in shell executor is not exposed", () => {
    expect(createBgShellAlias(undefined)).toBeUndefined()
    expect(createBgShellAlias({} as never)).toBeUndefined()
    expect(createBgShellAlias({ execute: "not-a-function" } as never)).toBeUndefined()
    expect(createBgShellAlias({ execute: async () => ({}) })).toBeUndefined()
  })

  it("registers as opencode.bg_shell with command/workdir/timeout and the built-in output schema", () => {
    const alias = createBgShellAlias({ execute: async () => ({}), output: outputSchema })!
    expect(alias.name).toBe("bg_shell")
    expect(alias.options).toEqual({ namespace: "opencode", codemode: true })
    expect(alias.output).toBe(outputSchema)
    expect(Object.keys(alias.input.properties).sort()).toEqual(["command", "timeout", "workdir"])
    expect(alias.input.required).toEqual(["command"])
    expect(alias.input.properties.background).toBeUndefined()
  })

  it("forces background: true and forwards command/workdir/timeout plus context", async () => {
    const calls: Array<{ input: unknown; context: unknown }> = []
    const result = {
      output: { output: "moved to background", shellID: "sh_1", status: "running", truncated: false },
      content: "moved to background",
      metadata: {},
    }
    const context = { sessionID: "ses_target", progress: async () => {} }
    const alias = createBgShellAlias({
      execute: async (input, ctx) => {
        calls.push({ input, context: ctx })
        return result
      },
      output: outputSchema,
    })!

    const returned = await alias.execute({ command: "sleep 5", workdir: "/tmp/x", timeout: 1000 }, context)
    expect(calls).toHaveLength(1)
    expect(calls[0].input).toEqual({ command: "sleep 5", workdir: "/tmp/x", timeout: 1000, background: true })
    expect(calls[0].context).toBe(context)
    expect(returned).toBe(result)
  })

  it("preserves built-in errors for normal host permission/error handling", async () => {
    const alias = createBgShellAlias({
      execute: async () => {
        throw new Error("permission denied")
      },
      output: outputSchema,
    })!
    await expect(alias.execute({ command: "true" }, {})).rejects.toThrow("permission denied")
  })
})
