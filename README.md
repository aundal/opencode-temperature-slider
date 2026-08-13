# opencode-temperature-slider

A spring-loaded temperature slider for the OpenCode TUI. Drag it to change the
LLM temperature per request — no restart needed.

![slider](https://img.shields.io/badge/opencode-1.18%2B-blue)

## What it does

A small slider appears next to the prompt input (session and home screens):

- **Hold left of center** — temperature decreases by `0.1` every 500 ms.
- **Hold right of center** — temperature increases by `0.1` every 500 ms.
- **Drag** — the thumb follows the mouse and the direction flips when you cross
  the center.
- **Release** — the thumb springs back to the center like a real spring.

The current value is shown next to the slider (one decimal).

## How it works

The plugin has two parts:

| File                          | Type           | Loaded via      |
| ----------------------------- | -------------- | --------------- |
| `src/temperature.ts`          | server plugin  | `opencode.json` |
| `src/temperature-slider.tsx`  | TUI plugin     | `tui.json`      |

The TUI writes the temperature to a shared state file in the current project:

```
<project>/.opencode/temperature.json
```

The server plugin hooks `chat.params` and reads that file on every request, so
the temperature applies immediately — no server restart, no config reload.

The temperature range is `0.0` to `2.0`. When the file is missing, the model
default is used.

## Install

Copy the two plugin files into your OpenCode config:

```powershell
# Windows
Copy-Item src\temperature.ts      "$env:USERPROFILE\.config\opencode\plugins\temperature.ts"
Copy-Item src\temperature-slider.tsx "$env:USERPROFILE\.config\opencode\plugins\temperature-slider.tsx"
```

```bash
# macOS / Linux
cp src/temperature.ts ~/.config/opencode/plugins/temperature.ts
cp src/temperature-slider.tsx ~/.config/opencode/plugins/temperature-slider.tsx
```

The server plugin is auto-discovered. The TUI plugin must be listed in
`~/.config/opencode/tui.json`:

```json
{
  "plugins": [
    "./plugins/temperature-slider.tsx"
  ]
}
```

Restart OpenCode. The slider appears next to the prompt.

## Usage

- Drag the slider left or right and hold to change the temperature in `0.1`
  steps every 500 ms.
- The value is saved per project in `.opencode/temperature.json`.
- Run `/temp-reset` to clear the override and return to the model default.

## Requirements

- OpenCode 1.18+
- A terminal with mouse support (the TUI must be started with mouse enabled)

## License

MIT