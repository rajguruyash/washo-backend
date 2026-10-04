import { createBrowserRouter } from 'react-router-dom';
import { AppLayout } from './layouts/AppLayout';
import { PublicLayout } from './layouts/PublicLayout';
import { StaffLayout } from './layouts/StaffLayout';
import Landing from './pages/Landing';
import Login from './pages/Login';
import NotFound from './pages/NotFound';

const page = (loader: () => Promise<{ default: React.ComponentType }>) => ({
  lazy: async () => ({ Component: (await loader()).default }),
});

export const router = createBrowserRouter([
  {
    element: <PublicLayout />,
    children: [
      { index: true, element: <Landing /> },
      { path: 'services', ...page(() => import('./pages/Services')) },
      { path: '*', element: <NotFound /> },
    ],
  },
  { path: 'login', element: <Login /> },
  {
    path: 'app',
    element: <AppLayout />,
    children: [
      { index: true, ...page(() => import('./pages/app/Dashboard')) },
      { path: 'welcome', ...page(() => import('./pages/app/Welcome')) },
      { path: 'membership', ...page(() => import('./pages/app/Membership')) },
      { path: 'membership/new', ...page(() => import('./pages/app/MembershipWizard')) },
      { path: 'membership/requests/:id', ...page(() => import('./pages/app/RequestDetail')) },
      { path: 'membership/:id', ...page(() => import('./pages/app/MembershipDetail')) },
      { path: 'book', ...page(() => import('./pages/app/BookWizard')) },
      { path: 'bookings', ...page(() => import('./pages/app/Bookings')) },
      { path: 'bookings/:id', ...page(() => import('./pages/app/BookingDetail')) },
      { path: 'vehicles', ...page(() => import('./pages/app/Vehicles')) },
      { path: 'account', ...page(() => import('./pages/app/Account')) },
      { path: '*', element: <NotFound /> },
    ],
  },
  {
    path: 'worker',
    element: <StaffLayout role="worker" title="Specialist" />,
    children: [
      { index: true, ...page(() => import('./pages/worker/WorkerHome')) },
      { path: 'washes/:id', ...page(() => import('./pages/worker/WorkerWash')) },
    ],
  },
  { path: 'admin', ...page(() => import('./pages/admin/Admin')) },
]);
