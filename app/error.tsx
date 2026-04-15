'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

export default function Error({
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
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold text-zinc-100">页面出了点问题</h2>
        <p className="max-w-md text-sm text-zinc-400">
          应用遇到了一个意外错误。你可以重试一次，通常开发环境下刷新就能恢复。
        </p>
      </div>
      <Button onClick={() => unstable_retry()} className="bg-blue-600 text-white hover:bg-blue-700">
        重新加载
      </Button>
    </div>
  );
}
