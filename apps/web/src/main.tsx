import "./main.css";
import { PageHeader, Toaster } from "@app/ui";
import { brand } from "@app/ui/brand";
import type { Screen } from "@app/web-kit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Link, matchRoute, Route, Switch, useLocation, useRouter, useSearch } from "wouter";
import { Home } from "./home.tsx";

const modules = import.meta.glob<{ screen: Screen }>(
  ["../../../contexts/*/src/ui/index.tsx", "!../../../contexts/notes/src/ui/index.tsx"],
  { eager: true },
);
const screens = Object.values(modules)
  .map((module) => module.screen)
  .toSorted((a, b) => a.title.localeCompare(b.title));

function App() {
  const [location] = useLocation();
  const router = useRouter();
  const search = useSearch();
  const isHome = matchRoute(router.parser, "/", location)[0];
  const activeScreen = screens.find((item) => matchRoute(router.parser, item.path, location)[0]);
  const orderId =
    activeScreen?.path === "/approvals" ? new URLSearchParams(search).get("order") : null;

  useEffect(() => {
    const page = isHome
      ? "Home"
      : orderId !== null
        ? `Approval ${orderId}`
        : (activeScreen?.title ?? "Not found");
    document.title = `${page} | ${brand.name}`;
  }, [isHome, orderId, activeScreen]);
  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface">
        <nav className="mx-auto flex max-w-4xl items-center gap-1 whitespace-nowrap px-6 py-3">
          <span className="mr-2 inline-flex items-center gap-2 font-semibold tracking-tight">
            <span className="inline-flex bg-primary p-2">
              <img src={brand.logo} alt="" width="56" height="19" />
            </span>
            {brand.name}
          </span>
          <Link
            href="/"
            className={(active) =>
              active
                ? "rounded-md bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary"
                : "rounded-md px-3 py-1.5 text-sm text-muted hover:text-foreground"
            }
          >
            Home
          </Link>
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
          <Route path="/" component={Home} />
          {screens.map((screen) => (
            <Route key={screen.path} path={screen.path} component={screen.Component} />
          ))}
          <Route>
            <PageHeader title="Not found" description="This page does not exist." />
            <Link href="/" className="text-primary">
              Back to home
            </Link>
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
