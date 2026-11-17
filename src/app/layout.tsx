import type { Metadata, Viewport } from "next";
import { Roboto } from "next/font/google";
import { connection } from "next/server";
import type { ReactNode } from "react";
import "./globals.css";

const roboto = Roboto({ subsets: ["latin"], variable: "--font-roboto", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Knowledge Sync for ServiceNow", template: "%s · Knowledge Sync" },
  description: "Keep Genesys Cloud Knowledge in step with your ServiceNow knowledge bases.",
  applicationName: "Knowledge Sync for ServiceNow",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#F9F8F5",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page renders per request so Next.js can stamp the proxy's CSP nonce on its scripts.
  await connection();
  return (
    <html lang="en" className={roboto.variable}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
