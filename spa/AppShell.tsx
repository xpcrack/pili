import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { MainPageSessionProvider } from '@/components/MainPageSessionProvider';
import { AppRouter } from '@/spa/AppRouter';

export function AppShell() {
  return (
    <AppErrorBoundary fallbackTitle="Pili 页面出错了">
      <MainPageSessionProvider>
        <AppRouter />
      </MainPageSessionProvider>
    </AppErrorBoundary>
  );
}
