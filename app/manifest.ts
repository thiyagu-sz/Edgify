import type { MetadataRoute } from "next";

/**
 * PWA manifest. The icons are the prototype's own brand mark on the landing background
 * (`edgify-logo-assets/`, generated from docs/reference/edgify-prototype.html) — mark only,
 * because the `edgify` wordmark is unreadable at launcher sizes.
 *
 * Both icons keep all artwork inside the central 40%-radius circle, so `maskable` is safe:
 * Android can apply its own shape mask without clipping the mark.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Edgify",
    short_name: "Edgify",
    description: "Academic study workspace — Quick Notes and Knowledge Graph.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
