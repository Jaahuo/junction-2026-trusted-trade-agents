import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1] / "scripts" / "tools" / "valio_recipes.py"
SPEC = importlib.util.spec_from_file_location("valio_recipes", PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ValioRecipeTests(unittest.TestCase):
    def setUp(self):
        permission = patch.dict(MODULE.os.environ, {"VALIO_AIMO_RECIPE_PERMISSION": "true"})
        permission.start()
        self.addCleanup(permission.stop)

    def test_missing_permission_blocks_all_recipe_requests_before_network_access(self):
        with patch.dict(MODULE.os.environ, {"VALIO_AIMO_RECIPE_PERMISSION": "False"}), patch.object(MODULE, "_download") as download:
            tools = MODULE.Tools()
            for response in (tools.list_valio_recipes("bakery"), tools.read_valio_recipe("https://www.valioaimo.fi/reseptit/test/")):
                self.assertIn("permission", json.loads(response)["error"])
            download.assert_not_called()

    def test_reads_graph_recipe_and_preserves_decimal_comma_and_ambiguous_yield(self):
        data = {"@graph": [{"@type": "WebPage"}, {
            "@type": ["Recipe"], "name": "Test bread",
            "recipeYield": "4, 4 annosta", "recipeIngredient": ["0,230 kg jauhoja"],
            "recipeInstructions": [{"@type": "HowToStep", "text": "Bake."}],
        }]}
        html = '<script type="application/ld+json">not json</script><script type="application/ld+json">' + json.dumps(data) + '</script>'
        result = MODULE._extract_recipe(html, "https://www.valioaimo.fi/reseptit/test/")
        self.assertEqual(result["ingredient_lines"], ["0,230 kg jauhoja"])
        self.assertEqual(result["yield_text"], "4, 4 annosta")
        self.assertEqual(result["instructions"][0]["text"], "Bake.")

    def test_missing_recipe_does_not_invent_ingredients_from_page_text(self):
        with self.assertRaises(ValueError):
            MODULE._extract_recipe("<h1>Soup</h1><p>Try some milk</p>", "https://www.valioaimo.fi/reseptit/test/")

    def test_recipe_without_yield_stays_unknown(self):
        data = {"@type": "Recipe", "name": "Bread", "recipeIngredient": ["1 kg flour"]}
        result = MODULE._extract_recipe('<script type="application/ld+json">' + json.dumps(data) + '</script>', "https://www.valioaimo.fi/reseptit/test/")
        self.assertIsNone(result["yield_text"])

    def test_rejects_private_and_external_urls_before_network_access(self):
        bad_urls = [
            "http://127.0.0.1:8080/reseptit/test/",
            "https://www.valioaimo.fi.evil.example/reseptit/test/",
            "https://www.valioaimo.fi@127.0.0.1/reseptit/test/",
            "https://www.valioaimo.fi:443/reseptit/test/",
            "https://www.valioaimo.fi/reseptit/../admin/",
            "https://www.valioaimo.fi/reseptit/test/?token=private",
        ]
        with patch.object(MODULE, "_download") as download:
            for url in bad_urls:
                with self.subTest(url=url):
                    self.assertIn("error", json.loads(MODULE.Tools().read_valio_recipe(url)))
            download.assert_not_called()

    def test_redirect_to_private_network_is_not_followed(self):
        from urllib.error import HTTPError
        error = HTTPError("https://www.valioaimo.fi/reseptit/test/", 302, "Redirect", {"Location": "http://127.0.0.1/admin"}, None)
        with patch.object(MODULE, "build_opener") as create:
            opener = create.return_value
            opener.open.side_effect = error
            with self.assertRaises(ValueError):
                MODULE._download("https://www.valioaimo.fi/reseptit/test/")
            self.assertEqual(opener.open.call_count, 1)

    def test_bakery_collection_deduplicates_recipe_links_and_excludes_external_links(self):
        html = '<a href="/reseptit/bread/">Bread</a><a href="/reseptit/bread/">Again</a><a href="https://evil.example/reseptit/bread/">Other</a>'
        with patch.object(MODULE, "_download", return_value=(html, MODULE.COLLECTIONS["bakery"])) as download:
            result = json.loads(MODULE.Tools().list_valio_recipes("bakery"))
        self.assertEqual(result["recipes"], [{"title": "Bread", "url": "https://www.valioaimo.fi/reseptit/bread/"}])
        self.assertEqual(download.call_args.args[0], MODULE.COLLECTIONS["bakery"])


if __name__ == "__main__":
    unittest.main()
