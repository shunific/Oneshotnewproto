import { Toaster } from 'sonner';
import { Outlet } from 'react-router';
import { AppProvider, useAppContext } from './context/AppContext';

function ThemedToaster() {
  const { theme } = useAppContext();
  return <Toaster position="top-right" theme={theme} closeButton />;
}

export function RootWrapper() {
  return (
    <AppProvider>
      <ThemedToaster />
      <Outlet />
    </AppProvider>
  );
}
