import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { migrateStorage } from "@miden-sdk/react";
import "./index.css";
import App from "./App.tsx";

// The Miden client keeps its state in IndexedDB, and the layout changes
// between SDK versions. A database left behind by an older SDK stops the new
// client from starting ("Miden client is not ready"). Clear it once whenever
// the SDK version changes; the client rebuilds it from the network on the next
// load. App data in localStorage (labels, history) is not touched.
const MIDEN_STORAGE_VERSION = "0.17.3";

async function start() {
  try {
    const cleared = await migrateStorage({ version: MIDEN_STORAGE_VERSION });
    if (cleared) return; // the page reloads itself
  } catch {
    /* never block the app on this */
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

start();
