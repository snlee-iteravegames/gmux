---
title: theme.jsonc
description: Reference for ~/.config/gmux/theme.jsonc — terminal color palette.
tableOfContents:
  maxHeadingLevel: 3
---

<!-- Generated from apps/gmux-web/src/settings-schema.ts — edit the schema, then run pnpm generate. -->

:::note
This page is generated from the [validation schema](https://github.com/gmuxapp/gmux/blob/main/apps/gmux-web/src/settings-schema.ts).
:::

`~/.config/gmux/theme.jsonc` (or `$XDG_CONFIG_HOME/gmux/theme.jsonc`)

Terminal color palette. All fields are optional CSS color strings.
Omitted colors use the built-in defaults shown below.

This file is drop-in compatible with [Windows Terminal themes](https://github.com/mbadolato/iTerm2-Color-Schemes/tree/master/windowsterminal):
`purple`/`brightPurple` are mapped to `magenta`/`brightMagenta`, and the `name` field is ignored.

## Example

```jsonc
{
  "background": "#282a36",
  "foreground": "#f8f8f2",
  "cursor": "#f8f8f2",
  "selectionBackground": "#44475a",
  "black": "#21222c",
  "red": "#ff5555",
  "green": "#50fa7b",
  "yellow": "#f1fa8c",
  "blue": "#bd93f9",
  "purple": "#ff79c6",   // mapped to magenta
  "cyan": "#8be9fd",
  "white": "#f8f8f2"
}
```

## Fields

### `foreground`

Default text color.

- **Default:** `#d8dee9`

### `background`

Terminal background color.

- **Default:** `#080b0f`

### `cursor`

Cursor color.

- **Default:** `#d8dee9`

### `cursorAccent`

Cursor accent color (text under block cursor).

- **Default:** `#080b0f`

### `selectionBackground`

Selection highlight color.

- **Default:** `#3a4655cc`

### `selectionForeground`

Text color inside selection.


### `selectionInactiveBackground`

Selection color when terminal is not focused.


### `black`

ANSI black.

- **Default:** `#0c1117`

### `red`

ANSI red.

- **Default:** `#bf616a`

### `green`

ANSI green.

- **Default:** `#a3be8c`

### `yellow`

ANSI yellow.

- **Default:** `#ebcb8b`

### `blue`

ANSI blue.

- **Default:** `#81a1c1`

### `magenta`

ANSI magenta.

- **Default:** `#b48ead`

### `cyan`

ANSI cyan.

- **Default:** `#88c0d0`

### `white`

ANSI white.

- **Default:** `#e5e9f0`

### `brightBlack`

ANSI bright black.

- **Default:** `#4c566a`

### `brightRed`

ANSI bright red.

- **Default:** `#d08770`

### `brightGreen`

ANSI bright green.

- **Default:** `#a3be8c`

### `brightYellow`

ANSI bright yellow.

- **Default:** `#ebcb8b`

### `brightBlue`

ANSI bright blue.

- **Default:** `#5e81ac`

### `brightMagenta`

ANSI bright magenta.

- **Default:** `#b48ead`

### `brightCyan`

ANSI bright cyan.

- **Default:** `#8fbcbb`

### `brightWhite`

ANSI bright white.

- **Default:** `#eceff4`

### `purple`

Alias for `magenta` (Windows Terminal compat).


### `brightPurple`

Alias for `brightMagenta` (Windows Terminal compat).


### `name`

Theme name (ignored, present in Windows Terminal theme files).

