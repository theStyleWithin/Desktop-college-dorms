import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { startScrollNear } from "./lib/scrollNear";
import { applyScrollSize } from "./lib/scrollSize";

startScrollNear();
applyScrollSize();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
