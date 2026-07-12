import { createContext, useContext, useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { api, getToken, setToken } from "./api";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email, password) {
    const data = await api.login(email, password);
    setToken(data.access_token);
    setUser(data.user);
    return data.user;
  }

  async function register(body) {
    const data = await api.register(body);
    setToken(data.access_token);
    setUser(data.user);
    return data.user;
  }

  function logout() {
    setToken(null);
    setUser(null);
  }

  const isAdmin =
    !!user &&
    (user.is_superadmin ||
      (user.memberships || []).some((m) => m.role === "admin"));

  const value = { user, loading, login, register, logout, isAdmin };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function RequireAdmin({ children }) {
  const { user, loading, isAdmin } = useAuth();
  const loc = useLocation();

  if (loading) return <div className="auth-splash">Loading…</div>;
  if (!user)
    return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (!isAdmin)
    return (
      <div className="auth-splash">
        <div className="auth-denied">
          <h2>Not authorized</h2>
          <p>
            Your account (<b>{user.email}</b>) doesn’t have admin access to this
            area.
          </p>
        </div>
      </div>
    );
  return children;
}
