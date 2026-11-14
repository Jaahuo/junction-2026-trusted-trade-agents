import { expect, test } from "bun:test";
import { intlLocale, lang, pick, resolveLang, setLang } from "./locale.ts";

test("language resolves from the tool input, then the host locale, then English", () => {
  expect(resolveLang("fi", "en-US", "en")).toBe("fi");
  expect(resolveLang(undefined, "fi-FI", "en")).toBe("fi");
  expect(resolveLang(null, undefined, "en-GB")).toBe("en");
  expect(resolveLang()).toBe("en");
});

test("fi-FI and fi give Finnish; an unsupported language gives English", () => {
  expect(resolveLang("fi-FI")).toBe("fi");
  expect(resolveLang("FI_fi")).toBe("fi");
  expect(resolveLang("sv-FI")).toBe("en");
  expect(resolveLang("")).toBe("en");
});

test("an unsupported first candidate falls through to the next", () => {
  expect(resolveLang("sv", "fi-FI")).toBe("fi");
});

test("setLang switches pick and the Intl locale", () => {
  const byLang = { en: "Approve", fi: "Hyväksy" };
  setLang("fi");
  expect(lang()).toBe("fi");
  expect(pick(byLang)).toBe("Hyväksy");
  expect(intlLocale()).toBe("fi-FI");
  setLang("en");
  expect(pick(byLang)).toBe("Approve");
  expect(intlLocale()).toBe("en-GB");
});
