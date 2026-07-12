import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "leaflet/dist/leaflet.css";
import "./styles.css";

import MapView from "./pages/MapView.jsx";
import AdminLayout from "./admin/AdminLayout.jsx";
import SocietiesPage from "./admin/SocietiesPage.jsx";
import SocietyDetailPage from "./admin/SocietyDetailPage.jsx";
import GeoreferencePage from "./admin/GeoreferencePage.jsx";
import ExtractPage from "./admin/ExtractPage.jsx";

const router = createBrowserRouter([
  { path: "/", element: <MapView /> },
  {
    path: "/admin",
    element: <AdminLayout />,
    children: [
      { index: true, element: <SocietiesPage /> },
      { path: "societies/:id", element: <SocietyDetailPage /> },
      { path: "maps/:mapId/georeference", element: <GeoreferencePage /> },
      { path: "maps/:mapId/extract", element: <ExtractPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
