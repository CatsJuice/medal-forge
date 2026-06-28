# Medal Forge

A focused Next.js prototype for turning uploaded SVG files into simple 3D medal, badge, and metal plate models.

## What works now

- Upload or paste an SVG design.
- Preview direct SVG layer extrusion.
- Save works locally in IndexedDB and load saved works from the sidebar.
- Export the current work as JSON, including the original SVG source.
- Select shapes from the layer list with Cmd/Ctrl-click multi-select, Shift-click range select, Cmd/Ctrl+A select all, and Esc clear.
- Adjust per-shape thickness, bevel, material, color, precision, visibility, and front/back height offset.
- Reset selected colors back to the original SVG color.
- Export GLB and USDZ models and copy a React/Three code snippet.
- Export transparent presentation animations as GIF or ProRes MOV. MOV export
  lazy-loads FFmpeg WebAssembly core from a pinned public CDN; see
  `THIRD_PARTY_NOTICES.md`.

## Run

```bash
npm install
npm run dev
```
