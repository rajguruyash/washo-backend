import type { AdminAccessInfo, AdminRole } from './types';

/** May this admin look at (view) or change (manage) an area of the console? The areas and who has them come from the database; the server checks again on every request. */
export const canDo = (a: AdminAccessInfo | null | undefined, area: string, level: 'view' | 'manage' = 'view'): boolean => {
  const have = a?.areas[area];
  return have === 'manage' || (have === 'view' && level === 'view');
};

export const ROLE_LABEL: Record<AdminRole, string> = {
  super_admin: 'Super admin',
  operations: 'Operations',
  finance: 'Finance',
  marketing: 'Marketing',
  support: 'Support',
};

/** What each role is for, in plain words (the real permissions are in the database). */
export const ROLE_ABOUT: Record<Exclude<AdminRole, 'super_admin'>, { can: string; cannot: string }> = {
  operations: { can: 'Washes, memberships, customers, specialists, services and prices, campaigns, crowd limits. Can export customers and washes.', cannot: 'Refunds, settings, admin accounts.' },
  finance: { can: 'Payments, refunds (small ones), the history, and exports of payments and refunds.', cannot: 'Change customers, services or campaigns; switch anyone off.' },
  marketing: { can: 'Campaigns (the free-wash offers).', cannot: 'Payments, customer details, exports.' },
  support: { can: 'Look up customers and washes, answer complaints, export complaints.', cannot: 'Refunds, changing anything else.' },
};

/** The extra things a person needs to know before they act: some areas are read-only for their role. */
export const isReadOnly = (a: AdminAccessInfo | null | undefined, area: string) => canDo(a, area, 'view') && !canDo(a, area, 'manage');
