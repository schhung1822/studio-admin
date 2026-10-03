import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "@shopify/polaris/build/esm/styles.css";
import "./globals.css";
import { AppShell } from "./_components/AppShell";

const inter = Inter({ subsets: ["latin", "vietnamese"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Studio Edit",
  description: "Bộ công cụ xử lý video: tách phụ đề, cắt video…",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="vi" className={inter.variable}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
