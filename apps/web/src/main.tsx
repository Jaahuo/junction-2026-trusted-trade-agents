import "./main.css";
import { PageHeader, Toaster } from "@app/ui";
import { brand } from "@app/ui/brand";
import type { Screen } from "@app/web-kit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Link, matchRoute, Route, Switch, useLocation, useRouter } from "wouter";
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
  const isHome = matchRoute(router.parser, "/", location)[0];
  const activeScreen = screens.find((item) => matchRoute(router.parser, item.path, location)[0]);

  useEffect(() => {
    const page = isHome ? "Home" : (activeScreen?.title ?? "Not found");
    document.title = `${page} | ${brand.name}`;
  }, [isHome, activeScreen]);
  return (
    <div className="min-h-screen">
      <header className="bg-primary text-primary-foreground">
        <nav className="mx-auto flex max-w-4xl items-center gap-1 whitespace-nowrap px-6 py-3">
          <span className="mr-2 inline-flex p-2">
            <img src={brand.logo} alt={brand.name} width="56" height="19" />
          </span>
          <Link
            href="/"
            className={(active) =>
              active
                ? "rounded-md bg-primary-foreground/15 px-3 py-1.5 text-sm font-medium"
                : "rounded-md px-3 py-1.5 text-sm text-primary-foreground/80 hover:text-primary-foreground"
            }
          >
            Home
          </Link>
          {screens.map((screen) => (
            <Link
              key={screen.path}
              href={screen.href ?? screen.path}
              className={(active) =>
                active
                  ? "rounded-md bg-primary-foreground/15 px-3 py-1.5 text-sm font-medium"
                  : "rounded-md px-3 py-1.5 text-sm text-primary-foreground/80 hover:text-primary-foreground"
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
