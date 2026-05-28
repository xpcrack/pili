import { MainPageSessionProvider } from '@/components/MainPageSessionProvider';
import { AppRouter } from '@/spa/AppRouter';

export function AppShell() {
  return (
    <MainPageSessionProvider>
      <AppRouter />
    </MainPageSessionProvider>
  );
}
