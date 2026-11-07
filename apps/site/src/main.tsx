import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Monitor } from "./monitor/Monitor";
import { Wallet } from "./wallet/Wallet";
import { Docs } from "./docs/Docs";
import "./styles.css";

// Four flat pages, so the route is the path itself; add a router if a page with nested routes appears.
const PAGES: Record<string, typeof App> = { "/monitor": Monitor, "/wallet": Wallet, "/docs": Docs };
const Page = PAGES[location.pathname.replace(/\/+$/, "")] ?? App;

createRoot(document.getElementById("root")!).render(<StrictMode><Page /></StrictMode>);
