"""Scale recipes and compare them with user-supplied inventory."""

import json
from decimal import Decimal, DecimalException, localcontext


_UNITS = {
    "g": ("mass", Decimal("1")),
    "kg": ("mass", Decimal("1000")),
    "ml": ("volume", Decimal("1")),
    "l": ("volume", Decimal("1000")),
    "pcs": ("count", Decimal("1")),
}


def _number(value, field, *, positive=False):
    if not isinstance(value, Decimal) or not value.is_finite():
        raise ValueError(f"{field} must be a finite number")
    if value < 0 or (positive and value == 0):
        raise ValueError(f"{field} must be {'positive' if positive else 'nonnegative'}")
    return value


def _unit(value, field):
    if not isinstance(value, str) or value.strip().lower() not in _UNITS:
        raise ValueError(f"{field} must be a supported unit: g, kg, ml, l, or pcs")
    return value.strip().lower()


def _reject_constant(value):
    raise ValueError(f"invalid JSON number: {value}")


def _plan(data):
    if not isinstance(data, dict):
        raise ValueError("recipe must be an object")
    recipe_servings = _number(data.get("recipe_servings"), "recipe_servings", positive=True)
    target_servings = _number(data.get("target_servings"), "target_servings", positive=True)
    ingredients = data.get("ingredients")
    if not isinstance(ingredients, list):
        raise ValueError("ingredients must be an array")

    validated = []
    numbers = [recipe_servings, target_servings]
    for index, ingredient in enumerate(ingredients):
        label = f"ingredients[{index}]"
        if not isinstance(ingredient, dict):
            raise ValueError(f"{label} must be an object")
        name = ingredient.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"{label}.name must be a nonempty string")
        amount = _number(ingredient.get("amount"), f"{label}.amount")
        unit = _unit(ingredient.get("unit"), f"{label}.unit")
        stock = None
        stock_unit = unit
        if "stock_amount" in ingredient:
            stock = _number(ingredient["stock_amount"], f"{label}.stock_amount")
            stock_unit = _unit(ingredient.get("stock_unit", unit), f"{label}.stock_unit")
            if _UNITS[unit][0] != _UNITS[stock_unit][0]:
                raise ValueError(f"{label} has incompatible ingredient and stock units")
            numbers.append(stock)
        elif "stock_unit" in ingredient:
            raise ValueError(f"{label}.stock_unit requires stock_amount")
        numbers.append(amount)
        validated.append((name, amount, unit, stock, stock_unit))

    # Preserve input precision and provide extra digits for non-terminating ratios.
    precision = max(
        50,
        sum(len(number.as_tuple().digits) for number in numbers) + 20,
        max(number.adjusted() for number in numbers)
        - min(number.as_tuple().exponent for number in numbers) + 20,
    )
    with localcontext() as context:
        context.prec = precision
        factor = target_servings / recipe_servings
        grouped = {}
        for name, amount, unit, stock, stock_unit in validated:
            required = amount * target_servings / recipe_servings
            converted = None if stock is None else stock * _UNITS[stock_unit][1] / _UNITS[unit][1]
            key = name.strip().casefold()
            if key not in grouped:
                grouped[key] = {"name": name.strip(), "unit": unit, "required": required, "stock": converted}
                continue
            item = grouped[key]
            if _UNITS[unit][0] != _UNITS[item["unit"]][0]:
                raise ValueError(f"Repeated ingredient {name} has incompatible units")
            ratio = _UNITS[unit][1] / _UNITS[item["unit"]][1]
            item["required"] += required * ratio
            if converted is not None:
                total_stock = converted * ratio
                if item["stock"] is not None and item["stock"] != total_stock:
                    raise ValueError(f"Repeated ingredient {name} has conflicting stock totals; supply total stock once")
                item["stock"] = total_stock
        result = []
        for item in grouped.values():
            required, stock = item["required"], item["stock"]
            result.append({
                "name": item["name"],
                "unit": item["unit"],
                "required_amount": str(required),
                "stock_amount": None if stock is None else str(stock),
                "missing_amount": None if stock is None else str(max(Decimal(0), required - stock)),
            })
        return {
            "factor": str(factor),
            "ingredients": result,
            "notice": "Planning only: allergens, pack sizes, prices, and availability are not verified.",
        }


class Tools:
    def plan_recipe(self, recipe_json: str) -> str:
        """Plan a recipe from JSON with recipe_servings, target_servings, and ingredients.

        Each ingredient has name, amount, unit, and optional stock_amount and
        stock_unit. Units are g, kg, ml, l, or pcs. A missing stock_amount means
        inventory is unknown, so both stock_amount and missing_amount are null.
        If stock_unit is omitted, stock uses the ingredient unit.
        Repeated ingredient names are combined across compatible units before
        inventory subtraction. Supply total stock once, not per recipe component.
        """
        try:
            data = json.loads(recipe_json, parse_int=Decimal, parse_float=Decimal,
                              parse_constant=_reject_constant)
            return json.dumps(_plan(data))
        except (ValueError, TypeError, DecimalException, OverflowError, RecursionError) as exc:
            return json.dumps({"error": f"Invalid recipe: {exc}"})
