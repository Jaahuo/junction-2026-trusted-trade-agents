import "./main.css";
import { EmptyState, Toaster } from "@app/ui";
import { brand } from "@app/ui/brand";
import type { Screen } from "@app/web-kit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Link, Redirect, Route, Switch } from "wouter";

const modules = import.meta.glob<{ screen: Screen }>("../../../contexts/*/src/ui/index.tsx", {
  eager: true,
});
const screens = Object.values(modules)
  .map((module) => module.screen)
  .toSorted((a, b) => a.title.localeCompare(b.title));

function App() {
  const [home] = screens;
  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface">
        <nav className="mx-auto flex max-w-4xl flex-wrap items-center gap-1 px-6 py-3">
          <span className="mr-4 inline-flex items-center gap-2 font-semibold tracking-tight">
            <span className="inline-flex bg-primary p-2">
              <img src={brand.logo} alt="" width="56" height="19" />
            </span>
            {brand.name}
          </span>
          {screens.map((screen) => (
            <Link
              key={screen.path}
              href={screen.path}
              className={(active) =>
                active
                  ? "rounded-md bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary"
                  : "rounded-md px-3 py-1.5 text-sm text-muted hover:text-foreground"
              }
            >
              {screen.title}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-8">
        <Switch>
          {screens.map((screen) => (
            <Route key={screen.path} path={screen.path} component={screen.Component} />
          ))}
          <Route>
            {home ? <Redirect to={home.path} /> : <EmptyState title="No screens yet" />}
          </Route>
        </Switch>
      </main>
      <Toaster position="bottom-right" richColors />
    </div>
  );
}

const root = document.querySelector("#root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}
