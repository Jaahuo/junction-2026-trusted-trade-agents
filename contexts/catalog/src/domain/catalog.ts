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
import { toOrderQuantity } from "./quantity.ts";

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
  /** Nutritional claim codes, for example `FREE_FROM_LACTOSE`. */
  claims: ReadonlySet<string>;
  substitutes: readonly string[];
}

const MAX_CANDIDATES = 20;

/** Each term as its lower-case words. A request with no word in any term is refused. */
export const parseTerms = (terms: readonly string[]): Result<string[][], "EMPTY_TERMS"> => {
  const parsed = terms
    .map((term) =>
      term
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word !== ""),
    )
    .filter((words) => words.length > 0);
  return parsed.length === 0 ? err("EMPTY_TERMS") : ok(parsed);
};

const SOFT_VALUES = new Map<string, (product: CatalogProduct) => string | null>([
  ["countryOfOrigin", (product) => product.countryOfOrigin],
  ["category", (product) => product.category],
]);

const softMatches = (product: CatalogProduct, soft: readonly SoftConstraint[]): number =>
  soft.filter(
    ({ attribute, prefer }) =>
      SOFT_VALUES.get(attribute)?.(product)?.toLowerCase() === prefer.toLowerCase(),
  ).length;

const count = (match: Record<string, MatchState>, state: MatchState): number =>
  Object.values(match).filter((value) => value === state).length;

interface Ranked {
  product: CatalogProduct;
  match: Record<string, MatchState>;
  confirmed: number;
  soft: number;
  terms: number;
}

const byRank = (a: Ranked, b: Ranked): number =>
  b.confirmed - a.confirmed ||
  b.soft - a.soft ||
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

/** A catalog over the slim index. `searchCatalog` expects the merged constraints and returns at most 20 candidates. */
export const createCatalog = (products: readonly CatalogProduct[]): WholesalerCatalog => {
  const byId = new Map(products.map((product) => [product.productId, product]));
  return {
    searchCatalog: (request: SearchRequest): SearchCandidate[] => {
      const terms = parseTerms(request.terms);
      if (!terms.ok) return [];
      const ranked: Ranked[] = [];
      for (const product of products) {
        const matched = terms.value.filter((words) =>
          words.every((word) => product.searchText.includes(word)),
        ).length;
        if (matched === 0) continue;
        const match = matchHard(product.claims, request.hard);
        if (isContradicted(match)) continue;
        ranked.push({
          product,
          match,
          confirmed: count(match, "confirmed"),
          soft: softMatches(product, request.soft),
          terms: matched,
        });
      }
      return ranked
        .toSorted(byRank)
        .slice(0, MAX_CANDIDATES)
        .map(({ product, match }) => {
          const { orderQuantity, equals } = toOrderQuantity(request.quantity, product);
          return {
            productId: product.productId,
            gtin: product.gtin,
            name: product.name,
            category: product.category,
            match,
            orderQuantity,
            equals,
            deliveryReliability: product.deliveryReliability,
            co2PerKg: product.co2PerKg,
            substitutes: [...product.substitutes],
          };
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
