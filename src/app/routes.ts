import { createBrowserRouter, Navigate } from 'react-router';
import { RootWrapper } from './RootWrapper';
import { Layout } from './layout';
import { AdminLayout } from './adminLayout';
import { OfflineLogin } from './pages/OfflineLogin';
import { HomePage } from './pages/HomePage';
import { LiveMonitor } from './pages/LiveMonitor';
// Staff pages
import { OverviewDashboard } from './pages/OverviewDashboard';
import { Tables } from './pages/Tables';
import { Reservations } from './pages/Reservations';
import { Queue } from './pages/Queue';
import { ActivityLog } from './pages/ActivityLog';
import { PromoCodesPage } from './pages/PromoCodes';
import { SettingsPage } from './pages/Settings';
import { SessionHistory } from './pages/SessionHistory';
import { LostAndFound } from './pages/LostAndFound';
import { Watchlist } from './pages/Watchlist';
// Admin pages
import { AdminDashboard } from './pages/AdminDashboard';
import { AdminUsers } from './pages/AdminUsers';
import { AdminTableManagement } from './pages/AdminTableManagement';
import { AdminAnnouncements } from './pages/AdminAnnouncements';
import { AdminEvents } from './pages/AdminEvents';
import { Analytics } from './pages/Analytics';
import { FeedbackPage } from './pages/Feedback';
import { AdminInventory } from './pages/AdminInventory';
import { AdminSiteSettings } from './pages/AdminSiteSettings';
import AdminPolicyRatesEditor from './pages/AdminPolicyRatesEditor';
import { NotFound } from './pages/NotFound';

export const router = createBrowserRouter([
  {
    Component: RootWrapper,
    children: [
      // 1. Force the root path to be the Offline Login
      { path: '/', Component: OfflineLogin },
      { path: '/home', Component: HomePage },
      { path: '/customer', Component: HomePage },
      { path: '/about', Component: HomePage },
      { path: '/feedback', Component: HomePage },
      { path: '/monitor', Component: LiveMonitor },
      
      // 2. Staff Portal
      {
        path: '/staff',
        Component: Layout,
        children: [
          { index: true, Component: OverviewDashboard },
          { path: 'tables', Component: Tables },
          { path: 'reservations', Component: Reservations },
          { path: 'queue', Component: Queue },
          { path: 'activity', Component: ActivityLog },
          { path: 'promo-codes', Component: PromoCodesPage },
          { path: 'history', Component: SessionHistory },
          { path: 'lost-found', Component: LostAndFound },
          { path: 'watchlist', Component: Watchlist },
          { path: 'feedback', Component: FeedbackPage }, // 🟢 NEW: Added Feedback to Staff Routes
          { path: 'settings', Component: SettingsPage },
        ],
      },
      
      // 3. Admin Portal
      {
        path: '/admin',
        Component: AdminLayout,
        children: [
          { index: true, Component: AdminDashboard },
          { path: 'users', Component: AdminUsers },
          { path: 'tables', Component: AdminTableManagement },
          { path: 'inventory', Component: AdminInventory },
          { path: 'policy-rates', Component: AdminPolicyRatesEditor },
          { path: 'rates', Component: AdminPolicyRatesEditor },
          { path: 'reservation-terms', Component: AdminPolicyRatesEditor },
          { path: 'announcements', Component: AdminAnnouncements },
          { path: 'events', Component: AdminEvents },
          { path: 'analytics', Component: Analytics },
          { path: 'activity', Component: ActivityLog },
          { path: 'feedback', Component: FeedbackPage },
          { path: 'site-settings', Component: AdminSiteSettings },
          { path: 'settings', Component: SettingsPage },
        ],
      },
      { path: '*', Component: NotFound },
    ],
  },
]);