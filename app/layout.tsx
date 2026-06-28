import type { Metadata } from "next";
import { ServiceWorkerRegistrar } from "@/components/service-worker-registrar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Medal Forge",
  description: "Generate medal and metal plate models from SVG files.",
  manifest: "/manifest.webmanifest",
  applicationName: "Medal Forge",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Medal Forge",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
