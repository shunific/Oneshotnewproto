
  import { createRoot } from "react-dom/client";
  import App from "./app/App.tsx";
  import "./styles/index.css";

  // 🟢 Fix system-wide typing loss bug after clicking save/submit buttons in Electron/Chromium
  if (typeof window !== "undefined") {
    // 1. Ensure any clicked input/textarea always receives focus cleanly
    document.addEventListener(
      "pointerdown",
      (e) => {
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) {
          setTimeout(() => {
            if (document.activeElement !== el) {
              el.focus();
            }
          }, 0);
        }
      },
      true
    );

    // 2. When clicking any button (especially save, update, confirm), prevent dead focus lock
    document.addEventListener(
      "click",
      (e) => {
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) {
          el.focus();
        }
        const btn = el?.closest("button");
        if (btn) {
          setTimeout(() => {
            if (document.activeElement === btn) {
              btn.blur();
            }
            window.focus();
          }, 50);
        }
      },
      true
    );

    // 3. When a form is submitted or enter is pressed, ensure window focus remains active
    document.addEventListener(
      "submit",
      () => {
        setTimeout(() => {
          window.focus();
        }, 50);
      },
      true
    );
  }

  createRoot(document.getElementById("root")!).render(<App />);
  