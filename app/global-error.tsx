'use client';

import { useEffect } from 'react';
import './globals.css';
import { Button } from '@/components/ui/button';

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="zh-CN" className="h-full dark">
      <body className="flex min-h-full items-center justify-center bg-zinc-950 px-6 text-zinc-100">
        <main className="flex max-w-md flex-col items-center gap-4 text-center">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold">应用暂时不可用</h1>
            <p className="text-sm text-zinc-400">
              根布局发生了未捕获错误。点击下面按钮尝试重新恢复页面。
            </p>
          </div>
          <Button onClick={() => unstable_retry()} className="bg-blue-600 text-white hover:bg-blue-700">
            再试一次
          </Button>
        </main>
      </body>
    </html>
  );
}
