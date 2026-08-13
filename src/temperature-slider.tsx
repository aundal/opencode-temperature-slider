/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup } from "solid-js"
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

function stateFile(directory: string): string {
  return join(directory, ".opencode", "temperature.json")
}

function clamp(value: number): number {
  return Math.min(MAX, Math.max(MIN, value))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function readFileValue(directory: string): number | undefined {
  try {
    if (!existsSync(stateFile(directory))) return undefined
    const parsed = JSON.parse(readFileSync(stateFile(directory), "utf8"))
    const value = Number(parsed?.temperature)
    if (!Number.isFinite(value)) return undefined
    return clamp(value)
  } catch {
    return undefined
  }
}

function writeState(api: TuiPluginApi, value: number): void {
  try {
    const directory = api.state.path.directory
    if (!directory) return
    const file = stateFile(directory)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ temperature: value }, null, 2))
  } catch {
    // keep KV state even if the file write fails
  }
  api.kv.set(KV_KEY, value)
}

function initialValue(api: TuiPluginApi): number {
  const stored = api.kv.get(KV_KEY)
  if (typeof stored === "number" && Number.isFinite(stored)) return clamp(stored)
  const file = readFileValue(api.state.path.directory)
  if (file !== undefined) return file
  return DEFAULT_TEMPERATURE
}

async function configTemperature(api: TuiPluginApi): Promise<number | undefined> {
  try {
    const directory = api.state.path.directory
    if (!directory) return undefined
    const config = (await api.client.config.get(
      { directory },
      { throwOnError: true, responseStyle: "data" },
    )) as { agent?: Record<string, { temperature?: number }>; default_agent?: string }
    const agentName = config.default_agent ?? "build"
    const value = config?.agent?.[agentName]?.temperature
    return typeof value === "number" && Number.isFinite(value) ? clamp(value) : undefined
  } catch {
    return undefined
  }
}

function SpringTempControl(props: { api: TuiPluginApi }) {
  const api = props.api
  const [temp, setTemp] = createSignal(initialValue(api))
  const [visual, setVisual] = createSignal(CENTER)
  let direction = 1
  let tickTimer: ReturnType<typeof setInterval> | undefined
  let springTimer: ReturnType<typeof setInterval> | undefined

  onCleanup(() => {
    if (tickTimer) clearInterval(tickTimer)
    if (springTimer) clearInterval(springTimer)
  })

  void configTemperature(api).then((value) => {
    if (value === undefined) return
    if (typeof api.kv.get(KV_KEY) === "number") return
    if (readFileValue(api.state.path.directory) !== undefined) return
    setTemp(value)
  })

  const tick = (dir: number) => {
    const next = clamp(round2(temp() + dir * STEP))
    setTemp(next)
    writeState(api, next)
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
      event?.stopPropagation?.()
      event?.preventDefault?.()
      pressed = true
      startRepeat(event.x < el.x + el.width / 2 ? -1 : 1)
    }
    el.onMouseDrag = (event: any) => {
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
  }

  return (
    <box flexDirection="row" gap={1} alignItems="center" marginLeft={1}>
      <slider
        ref={ref as any}
        orientation="horizontal"
        min={MIN}
        max={MAX}
        value={visual()}
        viewPortSize={VIEWPORT_SIZE}
        width={TRACK_WIDTH}
        height={1}
        backgroundColor={muted()}
        foregroundColor={accent()}
      />
      <text fg={accent()}>{temp().toFixed(1)}</text>
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
          description: "Clear the temperature override so the model default applies again.",
          category: "Temperature",
          suggested: false,
          slash: {
            name: "temp-reset",
          },
          onSelect() {
            try {
              const directory = api.state.path.directory
              if (directory) rmSync(stateFile(directory), { force: true })
            } catch {
              // ignore
            }
            api.kv.set(KV_KEY, undefined)
            api.ui.toast({ variant: "info", message: "Temperature override cleared" })
          },
        },
      ]
    })
  },
}

export default plugin
