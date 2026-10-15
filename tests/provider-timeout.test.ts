import { describe, expect, it } from "bun:test"
import {
  applyProviderRequestTimeout,
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
  resolveProviderRequestTimeout,
} from "../index"

type AnyObj = Record<string, any>

/** Minimal provider editor mirroring the plugin API: list() → { provider, models }, update(id, fn). */
function fakeEditor(providers: AnyObj[]) {
  const updates: AnyObj[] = []
  return {
    updates,
    editor: {
      list: () => providers,
      update: (providerID: string, update: (info: AnyObj) => void) => {
        const record = providers.find((entry) => entry.provider?.id === providerID)
        if (!record) return
        updates.push(record.provider)
        update(record.provider)
      },
    },
  }
}

function providerList(first: AnyObj | undefined, second: AnyObj | undefined): AnyObj[] {
  return [
    {
      provider: { id: "zai", name: "Z.AI", ...(first ? { settings: first } : {}) },
      models: [{ id: "glm-5", settings: { timeout: 123, baseURL: "https://model.example" } }],
    },
    {
      provider: {
        id: "openai",
        name: "OpenAI",
        ...(second ? { settings: second } : {}),
      },
      models: [],
    },
  ]
}

describe("provider request timeout", () => {
  it("defaults to 5 minutes and falls back to it for missing/invalid options", () => {
    expect(DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS).toBe(300_000)
    for (const raw of [undefined, null, 0, -1, -300_000, Number.NaN, Number.POSITIVE_INFINITY, "300000", true, {}, []]) {
      expect(resolveProviderRequestTimeout(raw)).toBe(DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS)
    }
  })

  it("honors false (disable) and explicit valid overrides", () => {
    expect(resolveProviderRequestTimeout(false)).toBe(false)
    expect(resolveProviderRequestTimeout(60_000)).toBe(60_000)
    expect(resolveProviderRequestTimeout(1234.5)).toBe(1234.5)
  })

  it("applies the default to every listed provider and preserves other settings", () => {
    const list = providerList({ baseURL: "https://api.z.ai/api/paas/v4" }, { apiKey: "sk-fake", baseURL: "https://api.openai.com/v1" })
    const { editor, updates } = fakeEditor(list)

    expect(applyProviderRequestTimeout(editor, DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS)).toBe(2)
    expect(updates).toHaveLength(2)
    expect(list[0].provider.settings).toEqual({ baseURL: "https://api.z.ai/api/paas/v4", timeout: 300_000 })
    expect(list[1].provider.settings).toEqual({ apiKey: "sk-fake", baseURL: "https://api.openai.com/v1", timeout: 300_000 })
    // Model-specific settings and other provider fields are untouched.
    expect(list[0].models[0].settings).toEqual({ timeout: 123, baseURL: "https://model.example" })
    expect(list[0].provider.name).toBe("Z.AI")
    expect(list[1].provider.name).toBe("OpenAI")
  })

  it("applies an explicit override, replacing a different existing timeout", () => {
    const list = providerList({ timeout: 999, baseURL: "https://x.example" }, { timeout: 1 })
    const { editor } = fakeEditor(list)

    expect(applyProviderRequestTimeout(editor, 60_000)).toBe(2)
    expect(list[0].provider.settings).toEqual({ timeout: 60_000, baseURL: "https://x.example" })
    expect(list[1].provider.settings).toEqual({ timeout: 60_000 })
  })

  it("is idempotent: a second apply with the same value is a no-op", () => {
    const list = providerList(undefined, undefined)
    const { editor, updates } = fakeEditor(list)

    expect(applyProviderRequestTimeout(editor, DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS)).toBe(2)
    expect(applyProviderRequestTimeout(editor, DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS)).toBe(0)
    expect(updates).toHaveLength(2)
    expect(list[0].provider.settings).toEqual({ timeout: 300_000 })
    expect(list[1].provider.settings).toEqual({ timeout: 300_000 })
  })

  it("skips records without a usable provider id", () => {
    const list = [
      { provider: { name: "no id", settings: undefined }, models: [] },
      { provider: { id: "zai", settings: undefined }, models: [] },
    ]
    const { editor, updates } = fakeEditor(list as AnyObj[])

    expect(applyProviderRequestTimeout(editor, DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS)).toBe(1)
    expect(updates).toHaveLength(1)
    expect(list[1].provider.settings).toEqual({ timeout: 300_000 })
  })
})
