import type { Metadata } from "next";
import "./globals.css";
import ThemeSwitcher from "./theme-switcher";

export const metadata: Metadata = {
  title: "Egg Inc Utils",
  description: "Unified Egg, Inc. utility suite",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('eggincutils-theme');document.documentElement.dataset.theme=(t==='light'?'light':'dark');}catch(_e){document.documentElement.dataset.theme='dark';}",
          }}
        />
      </head>
      <body>
        {children}
        <ThemeSwitcher />
      </body>
    </html>
  );
}
