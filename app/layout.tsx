import type { Metadata } from "next";
import "./globals.css";

import { MainPageSessionProvider } from '@/components/MainPageSessionProvider';

export const metadata: Metadata = {
  title: "Web3玩家动态看板",
  description: "追踪 Web3 玩家的 Twitter、Telegram 和链上动态",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased dark">
      <body className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
        <MainPageSessionProvider>{children}</MainPageSessionProvider>
      </body>
    </html>
  );
}
