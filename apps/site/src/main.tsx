import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Monitor } from "./monitor/Monitor";
import { Wallet } from "./wallet/Wallet";
import "./styles.css";

// Three flat pages, so the route is the path itself; add a router if a page with nested routes appears.
const PAGES: Record<string, typeof App> = { "/monitor": Monitor, "/wallet": Wallet };
const Page = PAGES[location.pathname.replace(/\/+$/, "")] ?? App;

createRoot(document.getElementById("root")!).render(<StrictMode><Page /></StrictMode>);
