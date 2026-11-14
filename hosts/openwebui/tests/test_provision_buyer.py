import contextlib
import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import provision_buyer as buyer


class BuyerAccessTests(unittest.TestCase):
    def run_setup(self, role="user"):
        self.tool_grants = []
        self.permissions = {"chat": {"delete": False, "call": False, "stt": False, "tts": False},
                            "features": {"web_search": False}, "workspace": {"tools": True}}
        grant = {"principal_type": "user", "principal_id": "chef-id", "permission": "read"}

        def request(path, payload=None, token=None, **kwargs):
            if path == "/api/v1/auths/signin":
                return {"token": "invented-session", "id": "operator-id"}
            if path.startswith("/api/v1/users/?"):
                return {"users": [{"id": "chef-id", "email": "chef@example.invalid", "role": role}]}
            if path == "/api/v1/users/default/permissions":
                if payload:
                    self.permissions = payload
                return self.permissions
            if path.startswith("/api/v1/models/model?id="):
                return {"access_grants": [grant]}
            if path == "/api/v1/tools/id/recipe_planner":
                return {"access_grants": self.tool_grants}
            if path == "/api/v1/tools/id/recipe_planner/access/update":
                self.tool_grants = payload["access_grants"]
                return {"access_grants": self.tool_grants}
            return {}

        with patch.object(buyer, "request", request), patch.object(buyer, "configure_agent"), patch.object(sys, "stdin", io.StringIO('{"email":"chef@example.invalid","password":"invented"}')), patch.dict(os.environ, {
            "WEBUI_ADMIN_EMAIL": "operator@example.invalid", "WEBUI_ADMIN_PASSWORD": "invented",
            "VALIO_AIMO_RECIPE_PERMISSION": "False", "MCP_SERVER_URL": "",
        }), contextlib.redirect_stdout(io.StringIO()):
            buyer.main()

    def test_existing_buyer_receives_arithmetic_access_and_keeps_voice(self):
        self.run_setup()
        self.assertEqual(self.tool_grants, [{"principal_type": "user", "principal_id": "chef-id", "permission": "read"}])
        for feature in ("call", "stt", "tts"):
            self.assertTrue(self.permissions["chat"][feature])
        self.assertTrue(self.permissions["features"]["web_search"])
        self.assertFalse(self.permissions["workspace"]["tools"])

    def test_existing_operator_is_not_demoted(self):
        with self.assertRaisesRegex(RuntimeError, "non-admin"):
            self.run_setup(role="admin")
        self.assertTrue(self.permissions["workspace"]["tools"])
        self.assertEqual(self.tool_grants, [])


if __name__ == "__main__":
    unittest.main()
