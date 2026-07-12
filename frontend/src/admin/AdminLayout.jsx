import { Link, Outlet, useLocation } from "react-router-dom";

export default function AdminLayout() {
  const loc = useLocation();
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
        <span className="admin-warn">⚠ Auth not wired yet — dev-only</span>
      </header>
      <main className="admin-main" key={loc.pathname}>
        <Outlet />
      </main>
    </div>
  );
}
