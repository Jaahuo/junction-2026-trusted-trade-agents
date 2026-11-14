"""Read public Valio Aimo recipe data without a search or scraping account."""

from datetime import datetime, timezone
from html.parser import HTMLParser
import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ORIGIN = "https://www.valioaimo.fi"
COLLECTIONS = {
    "restaurant": ORIGIN + "/reseptiryhmat/ammattikeittioreseptit/",
    "hotel": ORIGIN + "/reseptiryhmat/ammattikeittioreseptit/",
    "bakery": ORIGIN + "/reseptiryhmat/leipomoreseptit/",
}
MAX_BYTES = 2 * 1024 * 1024


def _require_permission():
    if os.environ.get("VALIO_AIMO_RECIPE_PERMISSION", "").lower() != "true":
        raise ValueError("Valio Aimo recipe reads are paused until permission for this agent use is confirmed. See https://www.valioaimo.fi/kayttoehdot/. Do not bypass this pause with another scraper.")


def _validate_url(url):
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.netloc != "www.valioaimo.fi" or parts.query or parts.fragment:
        raise ValueError("Use a public https://www.valioaimo.fi recipe URL without query parameters or fragments")
    if url not in COLLECTIONS.values() and not re.fullmatch(r"/reseptit/[a-z0-9-]+/?", parts.path):
        raise ValueError("Only Valio Aimo recipe pages and the configured recipe collections are allowed")
    return url


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _download(url):
    opener = build_opener(_NoRedirect())
    for attempt in range(4):
        _validate_url(url)
        try:
            with opener.open(Request(url, headers={"User-Agent": "TradeAgentRecipeReader/1.0", "Accept": "text/html"}), timeout=20) as response:
                if response.headers.get_content_type() != "text/html":
                    raise ValueError("Recipe source did not return HTML")
                body = response.read(MAX_BYTES + 1)
                if len(body) > MAX_BYTES:
                    raise ValueError("Recipe source exceeds the 2 MiB read limit")
                return body.decode(response.headers.get_content_charset() or "utf-8"), url
        except HTTPError as error:
            if error.code not in (301, 302, 303, 307, 308):
                raise
            destination = error.headers.get("Location")
            error.close()
            if not destination:
                raise ValueError("Recipe redirect has no destination") from None
            url = urljoin(url, destination)
    raise ValueError("Recipe source has too many redirects")


class _RecipeHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
        self.links = []
        self.script = None
        self.link = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and attrs.get("type", "").lower() == "application/ld+json":
            self.script = []
        if tag == "a":
            self.link = [attrs.get("href", ""), []]
        if tag == "img" and self.link is not None and attrs.get("alt"):
            self.link[1].append(attrs["alt"])

    def handle_data(self, data):
        if self.script is not None:
            self.script.append(data)
        if self.link is not None:
            self.link[1].append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.script is not None:
            self.scripts.append("".join(self.script))
            self.script = None
        if tag == "a" and self.link is not None:
            self.links.append((self.link[0], " ".join(" ".join(self.link[1]).split())))
            self.link = None


def _find_recipe(value):
    if isinstance(value, list):
        for item in value:
            recipe = _find_recipe(item)
            if recipe is not None:
                return recipe
    elif isinstance(value, dict):
        kinds = value.get("@type", [])
        kinds = [kinds] if isinstance(kinds, str) else kinds
        if isinstance(kinds, list) and any(kind in ("Recipe", "https://schema.org/Recipe") for kind in kinds):
            return value
        return _find_recipe(value.get("@graph"))
    return None


def _extract_recipe(html, url):
    parser = _RecipeHTML()
    parser.feed(html)
    for script in parser.scripts:
        try:
            recipe = _find_recipe(json.loads(script))
        except ValueError:
            continue
        if recipe is None:
            continue
        ingredients = recipe.get("recipeIngredient")
        if not recipe.get("name") or not isinstance(ingredients, list) or not ingredients or not all(isinstance(line, str) for line in ingredients):
            raise ValueError("Structured recipe lacks a title or ingredient list")
        return {
            "title": recipe["name"],
            "yield_text": recipe.get("recipeYield"),
            "ingredient_lines": ingredients,
            "instructions": recipe.get("recipeInstructions"),
            "source_url": url,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "notice": "Public recipe reference, not a supplier offer. Preserve original units and confirm ambiguous yield before scaling. Dietary claims do not verify product allergens.",
        }
    raise ValueError("No structured Recipe data found. Do not infer missing ingredients or yield")


class Tools:
    def list_valio_recipes(self, kitchen_type: str = "restaurant") -> str:
        """List linked Valio Aimo professional recipes. kitchen_type is restaurant, hotel, or bakery. This reads the collection's initial page, not its whole catalog. Read a chosen recipe with read_valio_recipe."""
        try:
            _require_permission()
            if kitchen_type not in COLLECTIONS:
                raise ValueError("kitchen_type must be restaurant, hotel, or bakery")
            html, source = _download(COLLECTIONS[kitchen_type])
            parser = _RecipeHTML()
            parser.feed(html)
            recipes = {}
            for href, title in parser.links:
                url = urljoin(ORIGIN, href)
                try:
                    _validate_url(url)
                except ValueError:
                    continue
                if urlsplit(url).path.startswith("/reseptit/"):
                    recipes.setdefault(url, title)
            if not recipes:
                raise ValueError("No recipe links found on the collection page")
            return json.dumps({"source_url": source, "recipes": [{"title": title, "url": url} for url, title in recipes.items()], "coverage": "Initial collection page only; not an exhaustive recipe search."}, ensure_ascii=False)
        except (OSError, ValueError, TypeError, URLError, RecursionError) as error:
            return json.dumps({"error": str(error)}, ensure_ascii=False)

    def read_valio_recipe(self, url: str) -> str:
        """Read a public Valio Aimo recipe URL from its structured HTML data. Returns original yield text, ingredient quantities, instructions and source URL. Do not use a markdown mirror, invent units, or treat this as verified allergens, live stock or price."""
        try:
            _require_permission()
            _validate_url(url)
            if not urlsplit(url).path.startswith("/reseptit/"):
                raise ValueError("Choose a recipe page, not a recipe collection")
            html, source = _download(url)
            return json.dumps(_extract_recipe(html, source), ensure_ascii=False)
        except (OSError, ValueError, TypeError, URLError, RecursionError) as error:
            return json.dumps({"error": str(error)}, ensure_ascii=False)
