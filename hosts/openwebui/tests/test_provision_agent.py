import copy
import contextlib
import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import provision_agent as agent


class ProvisionAgentTests(unittest.TestCase):
    def provision(self, permission="False", existing=None, max_tokens="4096"):
        self.models = copy.deepcopy(existing or {})
        self.writes = []

        def request(path, payload=None, token=None, *, allow_missing=False):
            if path == "/api/v1/auths/signin":
                return {"token": "invented-session"}
            if path == "/api/models":
                return {"data": [{"id": agent.BASE_MODEL}]}
            if path.startswith("/api/v1/models/model?id="):
                return self.models.get(path.split("=", 1)[1])
            if path in ("/api/v1/models/create", "/api/v1/models/model/update"):
                self.models[payload["id"]] = {**self.models.get(payload["id"], {}), **copy.deepcopy(payload)}
            if payload is not None:
                self.writes.append((path, copy.deepcopy(payload)))
            return {}

        with patch.dict(os.environ, {
            "WEBUI_ADMIN_EMAIL": "operator@example.invalid", "WEBUI_ADMIN_PASSWORD": "invented-password",
            "OPENAI_API_BASE_URL": "https://inference.example.invalid/v1", "OPENAI_API_KEY": "invented-key",
            "AGENT_MODEL_ID": agent.BASE_MODEL, "OPENWEBUI_MAX_TOKENS": max_tokens,
            "VALIO_AIMO_RECIPE_PERMISSION": permission,
        }), patch.object(agent, "request", request), patch.object(agent, "configure_mcp", return_value=["server:mcp:trusted-trade"]), contextlib.redirect_stdout(io.StringIO()):
            agent.main()

    def test_recipe_permission_does_not_remove_arithmetic_or_buying(self):
        self.provision()
        for model_id in ("restaurant-buyer", "bakery-buyer"):
            model = self.models[model_id]
            self.assertIn("recipe_planner", model["meta"]["toolIds"])
            self.assertIn("server:mcp:trusted-trade", model["meta"]["toolIds"])
            self.assertNotIn("valio_recipes", model["meta"]["toolIds"])
            self.assertFalse(model["meta"]["builtinTools"]["time"])

    def test_refresh_updates_output_budget_without_removing_buyer_access(self):
        grant = {"principal_type": "user", "principal_id": "invented-chef", "permission": "read"}
        self.provision()
        previous = copy.deepcopy(self.models)
        previous["restaurant-buyer"]["access_grants"] = [grant]
        previous["restaurant-buyer"]["params"]["max_tokens"] = 768
        self.provision(existing=previous, max_tokens="8192")
        self.assertEqual(self.models["restaurant-buyer"]["params"]["max_tokens"], 8192)
        self.assertEqual(self.models["restaurant-buyer"]["access_grants"], [grant])

    def test_permission_enables_only_the_additional_recipe_source_tool(self):
        self.provision(permission="True")
        self.assertIn("valio_recipes", self.models["bakery-buyer"]["meta"]["toolIds"])
        self.assertIn("recipe_planner", self.models["bakery-buyer"]["meta"]["toolIds"])

    def test_invalid_output_budget_stops_before_model_changes(self):
        with self.assertRaises(ValueError):
            self.provision(max_tokens="0")
        self.assertEqual(self.models, {})


if __name__ == "__main__":
    unittest.main()
