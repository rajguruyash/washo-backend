import { useAuth } from '../state/auth';

/** True for a customer who signed in with their email and has not given a verified mobile number yet: they cannot pay until they have. */
export const useNeedsPhone = (): boolean => {
  const { user } = useAuth();
  return Boolean(user) && user!.role === 'customer' && !user!.phone;
};
