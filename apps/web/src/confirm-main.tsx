import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource-variable/archivo/wght.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmPage } from "./pages/PortalConfirm";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfirmPage />
  </StrictMode>,
);
