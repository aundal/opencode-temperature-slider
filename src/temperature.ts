import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Plugin, PluginModule } from "@opencode-ai/plugin"

export function stateFile(directory: string): string {
  return join(directory, ".opencode", "temperature.json")
}

export function readTemperature(directory: string, modelKey: string): number | undefined {
  try {
    if (!existsSync(stateFile(directory))) return undefined
    const parsed = JSON.parse(readFileSync(stateFile(directory), "utf8")) as {
      version?: number
      models?: Record<string, { temperature?: number }>
    }
    const value = Number(parsed?.models?.[modelKey]?.temperature)
    if (!Number.isFinite(value)) return undefined
    return Math.min(2, Math.max(0, value))
  } catch {
    return undefined
  }
}

const server: Plugin = async ({ directory }) => {
  return {
    "chat.params": async (input, output) => {
      if (!input.model.capabilities.temperature) return
      const modelKey = `${input.model.providerID}/${input.model.id}`
      const value = readTemperature(directory, modelKey)
      if (value !== undefined) output.temperature = value
    },
  }
}

export default {
  id: "temperature.slider",
  server,
} satisfies PluginModule & { id: string }