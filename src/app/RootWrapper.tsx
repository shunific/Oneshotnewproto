import { Toaster } from 'sonner';
import { Outlet } from 'react-router';
import { AppProvider } from './context/AppContext';

export function RootWrapper() {
  return (
    <AppProvider>
      <Toaster position="top-right" richColors closeButton />
      <Outlet />
    </AppProvider>
  );
}
