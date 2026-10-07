import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'framer-motion';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import './index.css';
import { Atmosphere } from './components/brand/Atmosphere';
import { SiteLoader } from './components/SiteLoader';
import { ToastProvider } from './components/ui/Toast';
import { ApiError } from './lib/http';
import { captureSource } from './lib/source';
import { router } from './router';
import { AuthProvider } from './state/auth';

captureSource();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: true,
      // Don't retry things the server has definitively refused.
      retry: (count, err) => !(err instanceof ApiError && ((err.status >= 400 && err.status < 500) || err.code === 'backend_not_ready')) && count < 2,
    },
  },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <AuthProvider>
          <ToastProvider>
            <Atmosphere />
            <RouterProvider router={router} />
            <SiteLoader />
          </ToastProvider>
        </AuthProvider>
      </MotionConfig>
    </QueryClientProvider>
  </StrictMode>,
);
