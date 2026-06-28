const FFMPEG_CORE_BASE_URL =
  "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm";

const FFMPEG_CORE_FILES = {
  "ffmpeg-core.js": "text/javascript; charset=utf-8",
  "ffmpeg-core.wasm": "application/wasm",
} as const;

interface FfmpegCoreRouteContext {
  params: Promise<{
    file: string;
  }>;
}

export async function GET(_request: Request, { params }: FfmpegCoreRouteContext) {
  const { file } = await params;
  const contentType =
    FFMPEG_CORE_FILES[file as keyof typeof FFMPEG_CORE_FILES];

  if (!contentType) {
    return new Response("Not found", {
      status: 404,
    });
  }

  const upstreamResponse = await fetch(`${FFMPEG_CORE_BASE_URL}/${file}`, {
    cache: "no-store",
  });

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    return new Response("Unable to load FFmpeg core", {
      status: 502,
    });
  }

  return new Response(upstreamResponse.body, {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": contentType,
    },
  });
}
