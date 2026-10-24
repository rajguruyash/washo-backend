import { createBrowserRouter } from 'react-router-dom';
import { AppLayout } from './layouts/AppLayout';
import { RootLayout } from './layouts/RootLayout';
import { PublicLayout } from './layouts/PublicLayout';
import { StaffLayout } from './layouts/StaffLayout';
import Landing from './pages/Landing';
import Login from './pages/Login';
import NotFound from './pages/NotFound';
import { type PageName, pages } from './lib/pages';

// A page's code is fetched the first time it is needed (or earlier: lib/warm.ts), by the same call from lib/pages.ts.
const page = (name: PageName) => ({
  lazy: async () => ({ Component: (await pages[name]()).default }),
});

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      {
        element: <PublicLayout />,
        children: [
          { index: true, element: <Landing /> },
          { path: 'services', ...page('services') },
          { path: 'navratri', ...page('offer') },
          { path: 'free-wash', ...page('offer') },
          { path: 'privacy', ...page('privacy') },
          { path: 'privacy-policy', ...page('privacy') },
          { path: 'terms', ...page('terms') },
          { path: 'refund-policy', ...page('refunds') },
          { path: 'delete-account', ...page('deleteAccount') },
          { path: '*', element: <NotFound /> },
        ],
      },
      { path: 'login', element: <Login /> },
      {
        path: 'app',
        element: <AppLayout />,
        children: [
          { index: true, ...page('dashboard') },
          { path: 'welcome', ...page('welcome') },
          { path: 'membership', ...page('membership') },
          { path: 'membership/new', ...page('membershipNew') },
          { path: 'membership/requests/:id', ...page('requestDetail') },
          { path: 'membership/:id', ...page('membershipDetail') },
          { path: 'book', ...page('book') },
          { path: 'claim', ...page('claim') },
          { path: 'bookings', ...page('bookings') },
          { path: 'bookings/:id', ...page('bookingDetail') },
          { path: 'vehicles', ...page('vehicles') },
          { path: 'account', ...page('account') },
          { path: 'help', ...page('help') },
          { path: 'help/:id', ...page('helpTicket') },
          { path: '*', element: <NotFound /> },
        ],
      },
      {
        path: 'worker',
        element: <StaffLayout role="worker" title="Specialist" />,
        children: [
          { index: true, ...page('workerHome') },
          { path: 'washes/:id', ...page('workerWash') },
        ],
      },
      { path: 'admin', ...page('admin') },
    ],
  },
]);
