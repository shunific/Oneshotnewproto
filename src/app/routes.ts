import { createBrowserRouter } from 'react-router';
import { RootWrapper } from './RootWrapper';
import { HomePage } from './pages/HomePage';
import { LiveMonitor } from './pages/LiveMonitor';
import { NotFound } from './pages/NotFound';
import { ResetPassword } from './pages/ResetPassword';
import { Legal } from './pages/Legal';

export const router = createBrowserRouter([
  {
    Component: RootWrapper,
    children: [
      { path: '/', Component: HomePage },
      { path: '/legal', Component: Legal },
      { path: '/monitor', Component: LiveMonitor },
      { path: '/reset-password', Component: ResetPassword },
      { path: '*', Component: NotFound },
    ],
  },
]);