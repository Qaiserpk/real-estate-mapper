import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth.jsx";

export default function AdminLayout() {
  const loc = useLocation();
  const nav = useNavigate();
  const { user, logout } = useAuth();

  function signOut() {
    logout();
    nav("/login", { replace: true });
  }

  return (
    <div className="admin">
      <header className="admin-topbar">
        <div className="brand">
          <Link to="/admin">Property Map — Admin</Link>
        </div>
        <nav>
          <Link to="/admin">Societies</Link>
          <Link to="/">View map ↗</Link>
        </nav>
        <div className="admin-user">
          {user && (
            <>
              <span className="admin-who">
                {user.email}
                {user.is_superadmin && <em className="admin-badge">superadmin</em>}
              </span>
              <button className="admin-signout" onClick={signOut}>
                Sign out
              </button>
            </>
          )}
        </div>
      </header>
      <main className="admin-main" key={loc.pathname}>
        <Outlet />
      </main>
    </div>
  );
}
