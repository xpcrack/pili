import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoRoot = import.meta.dirname;

export default defineConfig(({ command }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@': repoRoot,
    },
  },
  // 客户端代码里有 process.env.* 读取（lib/activitiesApi.ts 等），prod 构建时被
  // 静态替换、dev 模式没有 Node 的 process 全局 → "process is not defined"。
  // 仅 dev（serve）注入空对象兜底（功能开关走 undefined 回退分支）；build 不受影响。
  ...(command === 'serve' ? { define: { 'process.env': '({})' } as Record<string, string> } : {}),
  server: {
    host: '127.0.0.1',
    port: 3005,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 3005,
    strictPort: true,
  },
  build: {
    outDir: path.join(repoRoot, 'dist/client'),
    emptyOutDir: true,
  },
}));
