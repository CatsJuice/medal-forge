# Third-Party Notices

Medal Forge is licensed under the MIT License. Some optional runtime features load
third-party components with their own licenses.

## Presentation MOV export

The ProRes MOV presentation export lazy-loads FFmpeg WebAssembly core assets
through a same-origin proxy backed by the pinned public npm CDN URL:

`https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/`

The `@ffmpeg/core` package is licensed as GPL-2.0-or-later. It is not committed
to this repository; it is fetched only when the MOV presentation export is used.
