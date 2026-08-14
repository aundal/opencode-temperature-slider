/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, onCleanup } from "solid-js"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { extend } from "@opentui/solid"
import type { RenderableConstructor } from "@opentui/solid"
import { SliderRenderable } from "@opentui/core"
import type { TuiCommand, TuiPluginApi, TuiPluginModule, TuiSlotPlugin } from "@opencode-ai/plugin/tui"

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    slider: RenderableConstructor
  }
}

extend({ slider: SliderRenderable as unknown as RenderableConstructor })

const PLUGIN_ID = "temperature-slider"
const KV_KEY = "temperature_slider_value"
const MIN = 0
const MAX = 2
const CENTER = 1
const STEP = 0.1
const TICK_MS = 500
const TRACK_WIDTH = 6
const THUMB_CELLS = 2
const VIEWPORT_SIZE = 1
const SPRING_FRAME_MS = 16
const DEFAULT_TEMPERATURE = 0.7

type TemperatureState = {
  version: number
  models: Record<string, { temperature: number }>
}

let activeModelKey: string | undefined

function stateFile(directory: string): string {
  return join(directory, ".opencode", "temperature.json")
}

function kvKey(modelKey: string): string {
  return `${KV_KEY}:${modelKey}`
}

function clamp(value: number): number {
  return Math.min(MAX, Math.max(MIN, value))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function readState(directory: string): TemperatureState | undefined {
  try {
    if (!existsSync(stateFile(directory))) return undefined
    const parsed = JSON.parse(readFileSync(stateFile(directory), "utf8")) as TemperatureState
    if (!parsed || typeof parsed !== "object" || !parsed.models) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function readModelValue(directory: string, modelKey: string): number | undefined {
  const state = readState(directory)
  const value = state?.models?.[modelKey]?.temperature
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return clamp(value)
}

function writeState(api: TuiPluginApi, modelKey: string, value: number): void {
  try {
    const directory = api.state.path.directory
    if (directory) {
      const file = stateFile(directory)
      mkdirSync(dirname(file), { recursive: true })
      const state = readState(directory) ?? { version: 1, models: {} }
      state.models[modelKey] = { temperature: value }
      writeFileSync(file, JSON.stringify(state, null, 2))
    }
  } catch {
    // keep KV state even if the file write fails
  }
  api.kv.set(kvKey(modelKey), value)
}

function clearState(api: TuiPluginApi, modelKey: string): void {
  try {
    const directory = api.state.path.directory
    if (directory) {
      const file = stateFile(directory)
      const state = readState(directory)
      if (state) {
        delete state.models[modelKey]
        if (Object.keys(state.models).length === 0) {
          rmSync(file, { force: true })
        } else {
          writeFileSync(file, JSON.stringify(state, null, 2))
        }
      }
    }
  } catch {
    // ignore
  }
  api.kv.set(kvKey(modelKey), undefined)
}

function loadModelValue(api: TuiPluginApi, modelKey: string): number {
  const stored = api.kv.get<number>(kvKey(modelKey))
  if (typeof stored === "number" && Number.isFinite(stored)) return clamp(stored)
  const file = readModelValue(api.state.path.directory, modelKey)
  if (file !== undefined) return file
  return DEFAULT_TEMPERATURE
}

function resolveModelKey(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  if (route.name === "session") {
    const sessionID = (route.params as { sessionID?: string }).sessionID
    if (!sessionID) return undefined
    const messages = api.state.session.messages(sessionID)
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role === "user" && message.model?.modelID) {
        return `${message.model.providerID}/${message.model.modelID}`
      }
      if (message.role === "assistant" && message.modelID) {
        return `${message.providerID}/${message.modelID}`
      }
    }
    return undefined
  }
  const config = api.state.config
  const agentName = config.default_agent ?? "build"
  const model = config.agent?.[agentName]?.model ?? config.model
  return typeof model === "string" && model.includes("/") ? model : undefined
}

function modelSupportsTemperature(api: TuiPluginApi, modelKey: string): boolean {
  const [providerID, modelID] = modelKey.split("/")
  const provider = api.state.provider.find((p) => p.id === providerID)
  const model = provider?.models?.[modelID]
  return model ? model.capabilities.temperature !== false : true
}

function configTemperature(api: TuiPluginApi): number | undefined {
  const config = api.state.config
  const agentName = config.default_agent ?? "build"
  const value = config.agent?.[agentName]?.temperature
  return typeof value === "number" && Number.isFinite(value) ? clamp(value) : undefined
}

function SpringTempControl(props: { api: TuiPluginApi }) {
  const api = props.api
  const [modelKey, setModelKey] = createSignal<string | undefined>(undefined)
  const [disabled, setDisabled] = createSignal(true)
  const [temp, setTemp] = createSignal(DEFAULT_TEMPERATURE)
  const [visual, setVisual] = createSignal(CENTER)
  let direction = 1
  let tickTimer: ReturnType<typeof setInterval> | undefined
  let springTimer: ReturnType<typeof setInterval> | undefined

  onCleanup(() => {
    if (tickTimer) clearInterval(tickTimer)
    if (springTimer) clearInterval(springTimer)
  })

  createEffect(() => {
    const key = resolveModelKey(api)
    activeModelKey = key
    setModelKey(key)
  })

  createEffect(() => {
    const key = modelKey()
    if (!key) {
      setDisabled(true)
      return
    }
    const supports = modelSupportsTemperature(api, key)
    setDisabled(!supports)
    if (!supports) return
    setTemp(loadModelValue(api, key))
    setVisual(CENTER)
    const configValue = configTemperature(api)
    if (configValue !== undefined && api.kv.get<number>(kvKey(key)) === undefined && readModelValue(api.state.path.directory, key) === undefined) {
      setTemp(configValue)
    }
  })

  const tick = (dir: number) => {
    const key = modelKey()
    if (!key) return
    const next = clamp(round2(temp() + dir * STEP))
    setTemp(next)
    writeState(api, key, next)
  }

  const startRepeat = (dir: number) => {
    direction = dir
    if (springTimer) {
      clearInterval(springTimer)
      springTimer = undefined
    }
    if (tickTimer) clearInterval(tickTimer)
    tick(dir)
    tickTimer = setInterval(() => tick(dir), TICK_MS)
  }

  const stopRepeat = () => {
    if (tickTimer) {
      clearInterval(tickTimer)
      tickTimer = undefined
    }
    if (springTimer) clearInterval(springTimer)
    springTimer = setInterval(() => {
      const next = visual() + (CENTER - visual()) * 0.25
      if (Math.abs(next - CENTER) < 0.02) {
        clearInterval(springTimer)
        springTimer = undefined
        setVisual(CENTER)
      } else {
        setVisual(next)
      }
    }, SPRING_FRAME_MS)
  }

  const muted = () => api.theme.current.textMuted
  const accent = () => api.theme.current.primary

  let pressed = false

  const ref = (el: SliderRenderable) => {
    if (!el) return
    el.onMouseDown = (event: any) => {
      if (disabled()) return
      event?.stopPropagation?.()
      event?.preventDefault?.()
      pressed = true
      startRepeat(event.x < el.x + el.width / 2 ? -1 : 1)
    }
    el.onMouseDrag = (event: any) => {
      if (disabled()) return
      event?.stopPropagation?.()
      if (!pressed) return
      const maxPos = TRACK_WIDTH - THUMB_CELLS
      const pos = Math.min(maxPos, Math.max(0, event.x - el.x))
      setVisual((pos / maxPos) * MAX)
      const dir = pos / maxPos < 0.5 ? -1 : 1
      if (dir !== direction) startRepeat(dir)
    }
    const release = () => {
      if (!pressed) return
      pressed = false
      stopRepeat()
    }
    el.onMouseUp = release
    ;(el as any).onMouseLeave = release
    ;(el as any).onMouseOut = release
  }

  return (
    <box flexDirection="row" gap={1} alignItems="center" marginLeft={1}>
      <slider
        ref={ref as any}
        orientation="horizontal"
        min={MIN}
        max={MAX}
        value={disabled() ? CENTER : visual()}
        viewPortSize={VIEWPORT_SIZE}
        width={TRACK_WIDTH}
        height={1}
        backgroundColor={muted()}
        foregroundColor={disabled() ? muted() : accent()}
      />
      <text fg={disabled() ? muted() : accent()}>{disabled() ? "--" : temp().toFixed(1)}</text>
    </box>
  )
}

function createSpringSlot(api: TuiPluginApi): TuiSlotPlugin {
  return {
    order: 9999,
    slots: {
      session_prompt_right: () => <SpringTempControl api={api} />,
      home_prompt_right: () => <SpringTempControl api={api} />,
    },
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  async tui(api, options) {
    if (options?.enabled === false) return

    api.slots.register(createSpringSlot(api))

    api.command.register((): TuiCommand[] => {
      return [
        {
          title: "Temperature: Reset to model default",
          value: "temperature.reset",
          description: "Clear the temperature override for the current model so the model default applies again.",
          category: "Temperature",
          suggested: false,
          slash: {
            name: "temp-reset",
          },
          onSelect() {
            const modelKey = activeModelKey
            if (!modelKey) {
              api.ui.toast({ variant: "info", message: "No model selected" })
              return
            }
            clearState(api, modelKey)
            api.ui.toast({ variant: "info", message: `Temperature override cleared for ${modelKey}` })
          },
        },
      ]
    })
  },
}

export default plugin