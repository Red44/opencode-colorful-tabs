import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { applyModelLimits, loadModelLimits, parseModelLimits } from "../index"

const luna = { context: 1_050_000, input: 922_000, output: 128_000 }
const registry = (limit: Record<string, unknown>) => ({
  openai: { models: { "gpt-6-luna": { limit } } },
})

describe("startup model-limit refresh", () => {
  let cacheHome = ""
  let previousCacheHome: string | undefined
  let previousFetch: typeof fetch

  beforeEach(() => {
    cacheHome = mkdtempSync(path.join(tmpdir(), "colored-tabs-model-limits-"))
    previousCacheHome = process.env.XDG_CACHE_HOME
    process.env.XDG_CACHE_HOME = cacheHome
    previousFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = previousFetch
    if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previousCacheHome
    rmSync(cacheHome, { recursive: true, force: true })
  })

  it("parses and applies the official GPT-6 Luna limits over stale catalog metadata", () => {
    const limits = parseModelLimits(registry(luna))
    expect(limits.get("openai/gpt-6-luna")).toEqual(luna)

    const models = [
      { providerID: "openai", id: "gpt-6-luna", limit: { context: 400_000, input: 272_000, output: 128_000 } },
      { providerID: "openai", id: "gpt-4o", limit: { context: 128_000, input: 111_616, output: 16_384 } },
    ]
    const editor = {
      list: () => models,
      update: (providerID: string, modelID: string, update: (model: (typeof models)[number]) => void) => {
        const model = models.find((entry) => entry.providerID === providerID && entry.id === modelID)
        if (model) update(model)
      },
    }

    expect(applyModelLimits(editor, limits)).toBe(1)
    expect(models[0].limit).toEqual(luna)
    expect(models[1].limit).toEqual({ context: 128_000, input: 111_616, output: 16_384 })
  })

  it("preserves catalog values when a model or individual stats are absent", () => {
    const limits = parseModelLimits({
      openai: {
        models: {
          "gpt-6-luna": { limit: { context: 1_050_000, output: 128_000 } }, // input absent
          "gpt-no-stats": { name: "No published limits" },
        },
      },
    })
    expect(limits.get("openai/gpt-6-luna")).toEqual({ context: 1_050_000, output: 128_000 })
    expect(limits.has("openai/gpt-no-stats")).toBe(false)

    const models = [
      { providerID: "openai", id: "gpt-6-luna", limit: { context: 400_000, input: 272_000, output: 128_000 } },
      { providerID: "openai", id: "gpt-no-stats", limit: { context: 256_000, input: 200_000, output: 32_000 } },
    ]
    const editor = {
      list: () => models,
      update: (providerID: string, modelID: string, update: (model: (typeof models)[number]) => void) => {
        const model = models.find((entry) => entry.providerID === providerID && entry.id === modelID)
        if (model) update(model)
      },
    }

    expect(applyModelLimits(editor, limits)).toBe(1)
    expect(models[0].limit).toEqual({ context: 1_050_000, input: 272_000, output: 128_000 })
    expect(models[1].limit).toEqual({ context: 256_000, input: 200_000, output: 32_000 })
  })

  it("uses fresh registry stats, then preserves them through partial and failed refreshes", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify(registry(luna)), { status: 200 })
    expect((await loadModelLimits(false))?.get("openai/gpt-6-luna")).toEqual(luna)

    globalThis.fetch = async () => new Response(JSON.stringify(registry({ context: 1_100_000 })), { status: 200 })
    expect((await loadModelLimits(false))?.get("openai/gpt-6-luna")).toEqual({
      context: 1_100_000,
      input: 922_000,
      output: 128_000,
    })

    globalThis.fetch = async () => { throw new Error("network unavailable") }
    expect((await loadModelLimits(false))?.get("openai/gpt-6-luna")).toEqual({
      context: 1_100_000,
      input: 922_000,
      output: 128_000,
    })
  })

  it("leaves models untouched when there are no stats and no last-known cache", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ openai: { models: { "gpt-6-luna": { name: "Luna" } } } }), { status: 200 })
    expect(await loadModelLimits(false)).toBeNull()

    globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 })
    expect(await loadModelLimits(false)).toBeNull()
  })
})
