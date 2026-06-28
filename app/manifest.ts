import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Medal Forge",
    short_name: "Medal Forge",
    description: "Generate medal and metal plate models from SVG files.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f5f6f7",
    theme_color: "#f5f6f7",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
