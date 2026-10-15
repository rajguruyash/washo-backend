/** The facts every policy page states. One place, so the pages never disagree with each other. */
export const LEGAL = {
  name: 'WASHO',
  site: 'washo.online',
  updated: '15 October 2026',
  email: 'contact.washo@gmail.com',
  phones: ['8668890147', '9172792929'],
  place: 'Kharadi, Pune, Maharashtra, India',
  deletionDays: 30,
} as const;

export const POLICY_LINKS = [
  { to: '/privacy', label: 'Privacy Policy' },
  { to: '/terms', label: 'Terms of Service' },
  { to: '/refund-policy', label: 'Cancellation & Refunds' },
  { to: '/delete-account', label: 'Delete your account' },
] as const;
