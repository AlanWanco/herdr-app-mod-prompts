# Prompts — a brief

Build a Herdr app mod (`mods/prompts/main.js`, `mod.json`, `place: none`) that shows what the person
asked each agent, with the time, read from the agent's own session log.

## What it builds

- A panel-sized view (works at 380 px, and as a dialog) for one agent at a time.
- Data: `~/.omp/agent/sessions/<folder>/<session>.jsonl` — lines with `"type":"message"` and
  `"message":{"role":"user"}`; the folder name is the agent's `cwd` with every non-alphanumeric run
  turned into `-` (match with a normalized comparison, longest match wins).
- Local reads: PowerShell `Get-Content | Where-Object` (the sandbox `fs.readFile` and the `hc()` helper
  both hang or refuse big files; `sh` is not on herdr's PATH on Windows). Remote reads: one
  `sh -c 'tail -c N "$1" | grep -F '"role":"user"' | tail -n 400'` with `{ on: machine }`.
- Cache: merge each read into `cache/prompts/data/<agent>__<session>.json`, dedupe by
  `timestamp|length|first 48 chars`, cap 4,000. `更早` multiplies the remote tail by four.
- Order: pins (read from `data/agents/store.json` — its `pins` value is a JSON *string*) first, then
  working, blocked, done, idle.

## What you see

Header (title, count, refresh), one agent chip plus `N 个 agent` / `收起` (a vertical list of
`space · tab`, tab shown only when the space has several or the tab is named), numbered session chips,
the folder path, then rows: `HH:mm #n`, the text (clipped at 220 characters), and on click the full
text plus thumbnails and file/link chips. Hovering a row shows `复制`.

## Built from

`gpui-kit` (`div`, `image`), `gpui-base` (`v_flex`, `h_flex`, `Textarea`, `TextView`, `Editor`),
`herdr` (`agents`, `panes`, `spaces`, `focused`, `exec`, `readTextFile`, `theme`, `layout`, `run`).

## Watch out

- Rows that scroll horizontally (`overflow_x_scrollbar`) grow to fill a column unless given a height;
  the first version pushed every other row out of the panel.
- A cancelled task leaves `busy` true after a hot reload: treat it as stale after a few seconds.
- `image()` resolves against `~/.config/herdr-app`; pictures from the clipboard are copied under
  `cache/prompts/` first, measured with `System.Drawing` (or PNG/GIF/WebP headers) so they are not
  stretched.
- Clipboard images are WebP in omp; GDI+ cannot read them. Convert with ffmpeg before `SetImage`.

## Done when

`herdr-app check mods/prompts` passes; switching agents in Herdr switches the list within a second;
a 64 MB session still shows its latest messages and `更早` grows the list; the cache file grows and
survives a restart.
