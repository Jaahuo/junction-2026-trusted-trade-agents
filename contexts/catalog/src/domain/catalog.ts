import type {
  FactsRequest,
  FactsResult,
  MatchState,
  ProductFacts,
  Quantity,
  SearchCandidate,
  SearchRequest,
  SoftConstraint,
  WholesalerCatalog,
} from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { isContradicted, matchHard } from "./match.ts";
import { type OrderQuantity, toOrderQuantity } from "./quantity.ts";

/** One product of the slim index: only the fields that search and facts need. */
export interface CatalogProduct {
  productId: string;
  gtin: string | null;
  name: string;
  /** Lower-case names in every language, for term matching. */
  searchText: string;
  category: string;
  salesUnit: string;
  allowedLotSize: number;
  perSalesUnit: Quantity | null;
  countryOfOrigin: string | null;
  deliveryReliability: number | null;
  co2PerKg: number | null;
  /** Nutritional claim codes, such as `FREE_FROM_LACTOSE`, and allergen facts, such as `CONTAINS:AE` or `FREE_FROM:AE`. */
  claims: ReadonlySet<string>;
  substitutes: readonly string[];
}

export const MAX_CANDIDATES = 20;

/** Unicode words are matched within one name, not as substrings of compounds. */
const wordsOf = (text: string): string[] =>
  text
    .normalize("NFC")
    .toLowerCase()
    .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];

export const parseTerms = (terms: readonly string[]): Result<string[][], "EMPTY_TERMS"> => {
  const parsed = terms.map(wordsOf).filter((words) => words.length > 0);
  return parsed.length === 0 ? err("EMPTY_TERMS") : ok(parsed);
};

const SOFT_VALUES = new Map<string, (product: CatalogProduct) => string | null>([
  ["countryOfOrigin", (product) => product.countryOfOrigin],
  ["category", (product) => product.category],
]);

export const isSupportedSoftAttribute = (attribute: string): boolean => SOFT_VALUES.has(attribute);

const milkWords = new Set(["milk", "maito"]);
// Plant-based products are named "gurt" or "Plantgurt", and a buyer asks for yogurt.
const yogurtWords = new Set(["yogurt", "yoghurt", "jogurtti", "gurt", "plantgurt"]);
const sameWord = (token: string, word: string): boolean =>
  token === word ||
  (milkWords.has(word) && milkWords.has(token)) ||
  (yogurtWords.has(word) && yogurtWords.has(token));

// A word counts if at least one occurrence is not part of "milk-free" or "free from milk".
const matchesTerm = (line: readonly string[], words: readonly string[]): boolean =>
  words.every((word, wordIndex) =>
    line.some(
      (token, index) =>
        sameWord(token, word) &&
        (line[index + 1] !== "free" || words[wordIndex + 1] === "free") &&
        !(line[index - 2] === "free" && line[index - 1] === "from"),
    ),
  );

// An explicit non-drink head in any translation qualifies the product, even if that
// translation does not contain the searched word or adjectives separate the words.
const secondaryMilkHeads = new Set([
  "chocolate",
  "chocolat",
  "suklaa",
  "maitosuklaa",
  "powder",
  "jauhe",
  "maitojauhe",
  "maitokerma",
  "milkshake",
  "pirtelö",
  "maitopirtelö",
]);
const headRelevance = (lines: readonly string[][], terms: readonly string[][]): number => {
  if (
    !lines.some((line) =>
      terms.some((term) => term.some((word) => milkWords.has(word)) && matchesTerm(line, term)),
    )
  )
    return 0;

  const secondaryHead = lines.some((line) =>
    line.some((word, index) => {
      if (secondaryMilkHeads.has(word)) return true;
      if (word !== "cream" && word !== "kerma") return false;
      // "Full cream milk" describes milk, whereas "milk cream" describes cream.
      return (
        !milkWords.has(line[index + 1] ?? "") && !(word === "cream" && line[index - 1] === "full")
      );
    }),
  );
  return secondaryHead ? -1 : 1;
};

const addSoftMatches = (
  product: CatalogProduct,
  soft: readonly SoftConstraint[],
  match: Record<string, MatchState>,
): number => {
  let matched = 0;
  for (const { attribute, prefer } of soft) {
    if (SOFT_VALUES.get(attribute)?.(product)?.toLowerCase() !== prefer.toLowerCase()) continue;
    match[`soft:${attribute}:${encodeURIComponent(prefer.toLowerCase())}`] = "confirmed";
    matched++;
  }
  return matched;
};

const count = (match: Record<string, MatchState>, state: MatchState): number =>
  Object.values(match).filter((value) => value === state).length;

interface Ranked {
  product: CatalogProduct;
  match: Record<string, MatchState>;
  confirmed: number;
  soft: number;
  head: number;
  quantity: OrderQuantity;
  terms: number;
}

const byRank = (a: Ranked, b: Ranked): number =>
  b.confirmed - a.confirmed ||
  b.soft - a.soft ||
  b.head - a.head ||
  Number(b.quantity.orderQuantity !== null) - Number(a.quantity.orderQuantity !== null) ||
  b.terms - a.terms ||
  (b.product.deliveryReliability ?? -1) - (a.product.deliveryReliability ?? -1) ||
  a.product.productId.localeCompare(b.product.productId);

const facts = (product: CatalogProduct, match: Record<string, MatchState>): ProductFacts => ({
  productId: product.productId,
  gtin: product.gtin,
  name: product.name,
  category: product.category,
  salesUnit: product.salesUnit,
  allowedLotSize: product.allowedLotSize,
  perSalesUnit: product.perSalesUnit,
  countryOfOrigin: product.countryOfOrigin,
  deliveryReliability: product.deliveryReliability,
  co2PerKg: product.co2PerKg,
  match,
  substitutes: [...product.substitutes],
});

/** A catalog over the slim index. `searchCatalog` expects the merged constraints and returns at most `limit` candidates, 20 by default. */
export const createCatalog = (products: readonly CatalogProduct[]): WholesalerCatalog => {
  const byId = new Map(products.map((product) => [product.productId, product]));
  const indexed = products.map((product) => ({
    product,
    lines: product.searchText.split(/\r?\n/).map(wordsOf),
  }));
  return {
    searchCatalog: (request: SearchRequest, limit = MAX_CANDIDATES): SearchCandidate[] => {
      const terms = parseTerms(request.terms);
      if (!terms.ok) return [];
      const ranked: Ranked[] = [];
      for (const { product, lines } of indexed) {
        const matched = terms.value.filter((words) =>
          lines.some((line) => matchesTerm(line, words)),
        ).length;
        if (matched === 0) continue;
        const match = matchHard(product.claims, request.hard);
        if (isContradicted(match)) continue;
        const confirmed = count(match, "confirmed");
        const soft = addSoftMatches(product, request.soft, match);
        ranked.push({
          product,
          match,
          confirmed,
          soft,
          head: headRelevance(lines, terms.value),
          quantity: toOrderQuantity(request.quantity, product),
          terms: matched,
        });
      }
      return ranked
        .toSorted(byRank)
        .slice(0, limit)
        .map(({ product, match, quantity }) => {
          const candidate: SearchCandidate = {
            productId: product.productId,
            gtin: product.gtin,
            name: product.name,
            category: product.category,
            match,
            orderQuantity: quantity.orderQuantity,
            equals: quantity.equals,
            deliveryReliability: product.deliveryReliability,
            co2PerKg: product.co2PerKg,
            substitutes: [...product.substitutes],
          };
          if (quantity.quantityReason !== undefined)
            candidate.quantityReason = quantity.quantityReason;
          return candidate;
        });
    },
    facts: (request: FactsRequest): FactsResult => {
      const found: ProductFacts[] = [];
      const unknown: string[] = [];
      for (const productId of request.productIds) {
        const product = byId.get(productId);
        if (product === undefined) unknown.push(productId);
        else found.push(facts(product, matchHard(product.claims, request.hard)));
      }
      return { products: found, unknown };
    },
    getSubstitutes: (productId: string): readonly string[] =>
      byId.get(productId)?.substitutes ?? [],
  };
};
