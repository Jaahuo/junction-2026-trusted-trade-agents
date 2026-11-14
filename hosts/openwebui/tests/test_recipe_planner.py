import importlib.util
import json
from decimal import Decimal
from pathlib import Path
import unittest


_PATH = Path(__file__).resolve().parents[1] / "scripts" / "tools" / "recipe_planner.py"
_SPEC = importlib.util.spec_from_file_location("recipe_planner", _PATH)
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)


class RecipePlannerTests(unittest.TestCase):
    def setUp(self):
        self.tools = _MODULE.Tools()

    def plan(self, ingredients, recipe_servings=4, target_servings=60):
        return json.loads(self.tools.plan_recipe(json.dumps({
            "recipe_servings": recipe_servings,
            "target_servings": target_servings,
            "ingredients": ingredients,
        })))

    def test_scaling_and_compatible_inventory_conversion(self):
        result = self.plan([
            {"name": "Flour", "amount": 0.2, "unit": "KG",
             "stock_amount": 500, "stock_unit": "G"},
            {"name": "Milk", "amount": 100, "unit": "ml",
             "stock_amount": 1, "stock_unit": "L"},
        ])
        self.assertEqual(Decimal(result["factor"]), Decimal("15"))
        flour, milk = result["ingredients"]
        self.assertEqual(flour["unit"], "kg")
        self.assertEqual(Decimal(flour["required_amount"]), Decimal("3"))
        self.assertEqual(Decimal(flour["stock_amount"]), Decimal("0.5"))
        self.assertEqual(Decimal(flour["missing_amount"]), Decimal("2.5"))
        self.assertEqual(Decimal(milk["required_amount"]), Decimal("1500"))
        self.assertEqual(Decimal(milk["stock_amount"]), Decimal("1000"))
        self.assertEqual(Decimal(milk["missing_amount"]), Decimal("500"))
        self.assertIn("Planning only", result["notice"])

    def test_unknown_stock_is_not_zero(self):
        item = self.plan([{"name": "Eggs", "amount": 2, "unit": "pcs"}])["ingredients"][0]
        self.assertIsNone(item["stock_amount"])
        self.assertIsNone(item["missing_amount"])
        self.assertEqual(Decimal(item["required_amount"]), Decimal("30"))

    def test_excess_stock_clamps_shortage_and_defaults_unit(self):
        item = self.plan([{"name": "Eggs", "amount": 1, "unit": "pcs",
                           "stock_amount": 20}])["ingredients"][0]
        self.assertEqual(Decimal(item["stock_amount"]), Decimal("20"))
        self.assertEqual(Decimal(item["missing_amount"]), Decimal("0"))

    def test_mass_volume_mismatch_is_rejected(self):
        result = self.plan([{"name": "Flour", "amount": 1, "unit": "kg",
                             "stock_amount": 1, "stock_unit": "l"}])
        self.assertIn("error", result)

    def test_repeated_recipe_components_subtract_total_stock_only_once(self):
        result = self.plan([
            {"name": "Flour", "amount": 100, "unit": "g", "stock_amount": 100},
            {"name": " flour ", "amount": 0.2, "unit": "kg", "stock_amount": 0.1},
        ], recipe_servings=1, target_servings=2)
        item = result["ingredients"][0]
        self.assertEqual(Decimal(item["required_amount"]), Decimal("600"))
        self.assertEqual(Decimal(item["stock_amount"]), Decimal("100"))
        self.assertEqual(Decimal(item["missing_amount"]), Decimal("500"))

    def test_repeated_ingredient_with_conflicting_inventory_requires_clarification(self):
        result = self.plan([
            {"name": "Flour", "amount": 100, "unit": "g", "stock_amount": 100},
            {"name": "Flour", "amount": 200, "unit": "g", "stock_amount": 200},
        ])
        self.assertIn("error", result)

    def test_invalid_inputs_return_errors(self):
        invalid = [
            "{", "null", "[]", "{}", "NaN", "Infinity", "-Infinity",
            '{"recipe_servings":NaN,"target_servings":1,"ingredients":[]}',
            '{"recipe_servings":1,"target_servings":Infinity,"ingredients":[]}',
            '{"recipe_servings":true,"target_servings":1,"ingredients":[]}',
            '{"recipe_servings":0,"target_servings":1,"ingredients":[]}',
            '{"recipe_servings":1,"target_servings":-1,"ingredients":[]}',
            '{"recipe_servings":1,"target_servings":1,"ingredients":{}}',
            '{"recipe_servings":1,"target_servings":1,"ingredients":[null]}',
            '{"recipe_servings":1,"target_servings":1,"ingredients":[{"name":" ","amount":1,"unit":"g"}]}',
            '{"recipe_servings":1,"target_servings":1,"ingredients":[{"name":"x","amount":-1,"unit":"g"}]}',
            '{"recipe_servings":1,"target_servings":1,"ingredients":[{"name":"x","amount":false,"unit":"g"}]}',
            '{"recipe_servings":1,"target_servings":1,"ingredients":[{"name":"x","amount":1,"unit":"oz"}]}',
            '{"recipe_servings":1,"target_servings":1,"ingredients":[{"name":"x","amount":1,"unit":"g","stock_amount":-1}]}',
            '{"recipe_servings":1,"target_servings":1,"ingredients":[{"name":"x","amount":1,"unit":"g","stock_unit":"kg"}]}',
        ]
        for raw in invalid:
            with self.subTest(raw=raw):
                self.assertIn("error", json.loads(self.tools.plan_recipe(raw)))

    def test_quantities_are_decimal_strings(self):
        result = json.loads(self.tools.plan_recipe(
            '{"recipe_servings":4,"target_servings":60,"ingredients":'
            '[{"name":"Spice","amount":0.1,"unit":"g","stock_amount":0.2}]}'
        ))
        self.assertIsInstance(result["factor"], str)
        item = result["ingredients"][0]
        self.assertEqual(Decimal(item["required_amount"]), Decimal("1.5"))
        self.assertEqual(Decimal(item["missing_amount"]), Decimal("1.3"))
        for key in ("required_amount", "stock_amount", "missing_amount"):
            self.assertIsInstance(item[key], str)


if __name__ == "__main__":
    unittest.main()
