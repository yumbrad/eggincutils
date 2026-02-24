import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Egg Inc Utils",
  description: "Unified Egg, Inc. utility suite",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
