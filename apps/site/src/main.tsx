import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Monitor } from "./monitor/Monitor";
import "./styles.css";

// ponytail: two pages, so the route is the path itself; add a router if a third page with nested routes appears.
const Page = location.pathname.replace(/\/+$/, "") === "/monitor" ? Monitor : App;

createRoot(document.getElementById("root")!).render(<StrictMode><Page /></StrictMode>);
