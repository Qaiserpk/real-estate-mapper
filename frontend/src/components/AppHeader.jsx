import { Link, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../auth.jsx";

// One header for every page: role-aware navigation + account actions.
// `children` are optional page-specific controls (e.g. the map's base/language
// selectors) shown to the right of the nav.
export default function AppHeader({ children }) {
  const { user, logout, isAdmin } = useAuth();
  const nav = useNavigate();

  const signOut = () => {
    logout();
    nav("/login", { replace: true });
  };

  return (
    <header className="app-header">
      <Link to="/" className="app-brand">
        Property&nbsp;Map
      </Link>

      <nav className="app-nav">
        <NavLink to="/" end>
          Map
        </NavLink>
        {user && <NavLink to="/claims">My claims</NavLink>}
        {user && <NavLink to="/deals">My deals</NavLink>}
        {isAdmin && (
          <>
            <span className="nav-sep" aria-hidden />
            <NavLink to="/admin" end>
              Societies
            </NavLink>
            <NavLink to="/admin/claims">Claims</NavLink>
            <NavLink to="/admin/agreements">Agreements</NavLink>
          </>
        )}
      </nav>

      {children && <div className="app-extra">{children}</div>}

      <div className="app-user">
        {user ? (
          <>
            <span className="who" title={user.email}>
              {user.email}
              {user.is_superadmin && <em className="admin-badge">superadmin</em>}
            </span>
            <button className="app-signout" onClick={signOut}>
              Sign out
            </button>
          </>
        ) : (
          <Link to="/login" className="app-signin">
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}
