import { expect, test } from "bun:test";
import { err, ok } from "@app/kernel";
import { httpViewPages } from "./view-pages.ts";

const pages = (answer: () => Response) => {
  const urls: string[] = [];
  const fetcher = Object.assign(
    async (input: RequestInfo | URL) => {
      urls.push(new Request(input).url);
      return answer();
    },
    { preconnect: fetch.preconnect },
  );
  return { views: httpViewPages(() => "http://views.test", fetcher), urls };
};

test("html returns the body of GET /views/<view>", async () => {
  const { views, urls } = pages(() => new Response("<html>card</html>"));
  expect(await views.html("approval-card")).toEqual(ok("<html>card</html>"));
  expect(urls).toEqual(["http://views.test/views/approval-card"]);
});

test("a missing view gives NOT_FOUND", async () => {
  const { views } = pages(() => new Response("missing", { status: 404 }));
  expect(await views.html("order-timeline")).toEqual(err("NOT_FOUND"));
});

test("another failure gives UPSTREAM_FAILED", async () => {
  const { views } = pages(() => new Response("boom", { status: 500 }));
  expect(await views.html("order-timeline")).toEqual(err("UPSTREAM_FAILED"));
});
