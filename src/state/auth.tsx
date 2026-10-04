import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { ApiError, onUnauthenticated, post } from '../lib/http';
import { fetchMe, keys, useMe } from '../lib/queries';
import type { User } from '../lib/types';

interface AuthValue {
  user: User | null;
  loading: boolean;
  /** Set when the session could not be loaded for a reason other than "not signed in" (e.g. the profile lookup failed). */
  error: ApiError | null;
  /** Refetch the session after sign-in. Rejects with the server's message if the profile cannot be loaded. */
  refresh: () => Promise<User>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useMe();

  // If any request learns the session is gone, forget the user everywhere.
  useEffect(
    () =>
      onUnauthenticated(() => {
        qc.setQueryData(keys.me, null);
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' && q.queryKey[0] !== 'catalog' });
      }),
    [qc]
  );

  const refresh = useCallback(async () => {
    return qc.fetchQuery({ queryKey: keys.me, queryFn: fetchMe, staleTime: 0 });
  }, [qc]);

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout');
    } finally {
      qc.clear();
      qc.setQueryData(keys.me, null);
    }
  }, [qc]);

  const value = useMemo<AuthValue>(
    () => ({
      user: me.data ?? null,
      loading: me.isLoading,
      error: me.error instanceof ApiError && me.error.status !== 401 ? me.error : me.error && !(me.error instanceof ApiError) ? new ApiError(0, 'network', "We couldn't reach WASHO. Check your connection and try again.") : null,
      refresh,
      logout,
    }),
    [me.data, me.isLoading, me.error, refresh, logout]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
