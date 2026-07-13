import { Outlet } from "react-router-dom";
import AppHeader from "./AppHeader.jsx";

// Shared shell for content pages (claims, deals, admin): unified header + a
// scrolling main area with consistent background.
export default function AppLayout() {
  return (
    <div className="shell">
      <AppHeader />
      <main className="shell-main">
        <Outlet />
      </main>
    </div>
  );
}
