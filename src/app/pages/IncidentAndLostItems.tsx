import { NavLink, useLocation } from 'react-router';
import { LostAndFound } from './LostAndFound';
import { Watchlist } from './Watchlist';

export function IncidentAndLostItems() {
  const showWatchlist = useLocation().pathname.endsWith('/watchlist');
  return (
    <div className="space-y-4">
      <nav aria-label="Incident & Lost Items" className="flex gap-2">
        {[
          { to: '/staff/lost-found', label: 'Lost & Found' },
          { to: '/staff/watchlist', label: 'Security Watchlist' },
        ].map(tab => (
          <NavLink key={tab.to} to={tab.to} className={({ isActive }) =>
            `rounded-lg border px-3 py-2 text-xs font-semibold ${isActive
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
              : 'border-neutral-800 text-neutral-400 hover:text-neutral-200'}`
          }>{tab.label}</NavLink>
        ))}
      </nav>
      {showWatchlist ? <Watchlist /> : <LostAndFound />}
    </div>
  );
}
