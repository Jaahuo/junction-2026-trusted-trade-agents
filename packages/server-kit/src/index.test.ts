import { afterEach, expect, test } from "bun:test";
import { publicBaseUrl, selfBaseUrl } from "./index.ts";

const names = ["INTERNAL_BASE_URL", "PUBLIC_BASE_URL", "PORT"] as const;
const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of names) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
const setEnv = (values: Partial<Record<(typeof names)[number], string>>) => {
  for (const name of names) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

test("selfBaseUrl uses INTERNAL_BASE_URL, else 127.0.0.1 and PORT; publicBaseUrl falls back to selfBaseUrl", () => {
  setEnv({ INTERNAL_BASE_URL: "http://api.internal:8080/", PORT: "4100" });
  expect(selfBaseUrl()).toBe("http://api.internal:8080");
  setEnv({ PORT: "4100" });
  expect(selfBaseUrl()).toBe("http://127.0.0.1:4100");
  expect(publicBaseUrl()).toBe("http://127.0.0.1:4100");
  setEnv({ PORT: "4100", PUBLIC_BASE_URL: "https://demo.example.test" });
  expect(publicBaseUrl()).toBe("https://demo.example.test");
});

test("selfBaseUrl throws when neither INTERNAL_BASE_URL nor PORT is set", () => {
  setEnv({});
  expect(() => selfBaseUrl()).toThrow("Set PORT or INTERNAL_BASE_URL.");
});
