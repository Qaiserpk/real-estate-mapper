import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

export default function LoginPage() {
  const { login, register } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const dest = loc.state?.from || "/admin";

  const [mode, setMode] = useState("login"); // login | register
  const [form, setForm] = useState({
    email: "",
    password: "",
    full_name: "",
    phone: "",
  });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (mode === "login") {
        await login(form.email, form.password);
      } else {
        await register({
          email: form.email,
          password: form.password,
          full_name: form.full_name || null,
          phone: form.phone || null,
        });
      }
      nav(dest, { replace: true });
    } catch (e) {
      setErr(e.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>Property Map</h1>
        <div className="auth-tabs">
          <button
            type="button"
            className={mode === "login" ? "on" : ""}
            onClick={() => setMode("login")}
          >
            Sign in
          </button>
          <button
            type="button"
            className={mode === "register" ? "on" : ""}
            onClick={() => setMode("register")}
          >
            Create account
          </button>
        </div>

        <label>
          Email
          <input
            type="email"
            value={form.email}
            onChange={set("email")}
            required
            autoFocus
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={form.password}
            onChange={set("password")}
            required
            minLength={mode === "register" ? 8 : undefined}
          />
        </label>

        {mode === "register" && (
          <>
            <label>
              Full name
              <input value={form.full_name} onChange={set("full_name")} />
            </label>
            <label>
              Phone
              <input value={form.phone} onChange={set("phone")} />
            </label>
          </>
        )}

        {err && <div className="auth-err">{err}</div>}

        <button className="auth-submit" disabled={busy}>
          {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
        </button>

        <div className="auth-foot">
          <Link to="/">← Back to map</Link>
        </div>
      </form>
    </div>
  );
}
