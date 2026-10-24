/**
 * The code of every page that is not part of the first download, in one place. The router loads a page from here the first time it is visited, and warm.ts loads them early (when the browser is idle
 * and when a link is hovered or touched), so a click finds the page's code already there. Both call the same `import()`, so the browser fetches each file once.
 */
export const pages = {
  services: () => import('../pages/Services'),
  offer: () => import('../pages/Offer'),
  privacy: () => import('../pages/legal/Privacy'),
  terms: () => import('../pages/legal/Terms'),
  refunds: () => import('../pages/legal/Refunds'),
  deleteAccount: () => import('../pages/legal/DeleteAccount'),
  dashboard: () => import('../pages/app/Dashboard'),
  welcome: () => import('../pages/app/Welcome'),
  membership: () => import('../pages/app/Membership'),
  membershipNew: () => import('../pages/app/MembershipWizard'),
  requestDetail: () => import('../pages/app/RequestDetail'),
  membershipDetail: () => import('../pages/app/MembershipDetail'),
  book: () => import('../pages/app/BookWizard'),
  claim: () => import('../pages/app/ClaimWizard'),
  bookings: () => import('../pages/app/Bookings'),
  bookingDetail: () => import('../pages/app/BookingDetail'),
  vehicles: () => import('../pages/app/Vehicles'),
  account: () => import('../pages/app/Account'),
  help: () => import('../pages/app/Help'),
  helpTicket: () => import('../pages/app/HelpTicket'),
  workerHome: () => import('../pages/worker/WorkerHome'),
  workerWash: () => import('../pages/worker/WorkerWash'),
  admin: () => import('../pages/admin/Admin'),
} as const;

export type PageName = keyof typeof pages;

/** Which pages a path needs (the first matching line). */
const ROUTES: [RegExp, PageName][] = [
  [/^\/services\/?$/, 'services'],
  [/^\/(navratri|free-wash)\/?$/, 'offer'],
  [/^\/privacy(-policy)?\/?$/, 'privacy'],
  [/^\/terms\/?$/, 'terms'],
  [/^\/refund-policy\/?$/, 'refunds'],
  [/^\/delete-account\/?$/, 'deleteAccount'],
  [/^\/app\/?$/, 'dashboard'],
  [/^\/app\/welcome\/?$/, 'welcome'],
  [/^\/app\/membership\/?$/, 'membership'],
  [/^\/app\/membership\/new\/?$/, 'membershipNew'],
  [/^\/app\/membership\/requests\/[^/]+\/?$/, 'requestDetail'],
  [/^\/app\/membership\/[^/]+\/?$/, 'membershipDetail'],
  [/^\/app\/book\/?$/, 'book'],
  [/^\/app\/claim\/?$/, 'claim'],
  [/^\/app\/bookings\/?$/, 'bookings'],
  [/^\/app\/bookings\/[^/]+\/?$/, 'bookingDetail'],
  [/^\/app\/vehicles\/?$/, 'vehicles'],
  [/^\/app\/account\/?$/, 'account'],
  [/^\/app\/help\/?$/, 'help'],
  [/^\/app\/help\/[^/]+\/?$/, 'helpTicket'],
  [/^\/worker\/?$/, 'workerHome'],
  [/^\/worker\/washes\/[^/]+\/?$/, 'workerWash'],
  [/^\/admin\/?$/, 'admin'],
];

export const pageFor = (path: string): PageName | undefined => ROUTES.find(([re]) => re.test(path))?.[1];

const started = new Set<PageName>();

/** Starts loading a page's code (once). A failure is ignored: the click that needs the page will try again and show the error then. */
export function preloadPage(name: PageName): void {
  if (started.has(name)) return;
  started.add(name);
  pages[name]().catch(() => started.delete(name));
}

export function preloadPath(path: string): void {
  const name = pageFor(path);
  if (name) preloadPage(name);
}
