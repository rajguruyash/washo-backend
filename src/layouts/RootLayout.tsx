import { Outlet } from 'react-router-dom';
import { NavProgress } from '../components/NavProgress';

/** Around every page of the site: what has to be there whichever layout a page uses. */
export function RootLayout() {
  return (
    <>
      <NavProgress />
      <Outlet />
    </>
  );
}
