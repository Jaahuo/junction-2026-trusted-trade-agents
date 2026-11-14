import base64
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request

from provision_mcp import configure as configure_mcp
from provision_speech import configure as configure_speech

BASE = os.environ.get("WEBUI_BASE_URL", "http://127.0.0.1:8080").rstrip("/")
FILES = Path(os.environ.get("COMPANION_FILES", Path(__file__).resolve().parents[1]))
BASE_MODEL = "nemotron-3.5-super-vl"
SKILLS = FILES.parents[1] / "skills" / "trusted-trade-ordering"


def system_prompt(persona):
    references = "\n\n".join(
        f"# Ordering reference: {path.name}\n\n{path.read_text()}"
        for path in (SKILLS / "SKILL.md", SKILLS / "reason-codes.md")
    )
    return references + "\n\n" + (FILES / "agent" / f"{persona}.md").read_text() + "\n\n" + (FILES / "agent" / "purchasing.md").read_text()


def request(path, payload=None, token=None, *, allow_missing=False, timeout=60):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = None if payload is None else json.dumps(payload).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(BASE + path, data=body, headers=headers), timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if allow_missing and error.code == 404:
            return None
        raise RuntimeError(f"Open WebUI returned HTTP {error.code} for {path}") from None


def main():
    login = request("/api/v1/auths/signin", {
        "email": os.environ["WEBUI_ADMIN_EMAIL"],
        "password": os.environ["WEBUI_ADMIN_PASSWORD"],
    })
    token = login["token"]
    base_model = os.environ.get("AGENT_MODEL_ID") or BASE_MODEL
    if base_model != BASE_MODEL:
        raise ValueError(f"This host requires {BASE_MODEL}; got {base_model}.")
    max_tokens = int(os.environ.get("OPENWEBUI_MAX_TOKENS", "16384"))
    if max_tokens <= 0:
        raise ValueError("OPENWEBUI_MAX_TOKENS must be positive.")
    endpoint = os.environ.get("OPENAI_API_BASE_URL", "").strip()
    key = os.environ.get("OPENAI_API_KEY", "")
    if not endpoint or not key:
        raise ValueError("Set OPENAI_API_BASE_URL and OPENAI_API_KEY for Nemotron inference.")
    request("/openai/config/update", {
        "ENABLE_OPENAI_API": True,
        "OPENAI_API_BASE_URLS": [endpoint],
        "OPENAI_API_KEYS": [key],
        "OPENAI_API_CONFIGS": {},
    }, token)
    available = request("/api/models", token=token)["data"]
    if base_model not in {model["id"] for model in available}:
        raise RuntimeError(f"{base_model} is unavailable. Check the endpoint and inference key.")
    purchasing_tools = configure_mcp(request, token)

    tasks = request("/api/v1/tasks/config", token=token)
    tasks.update({
        "ENABLE_TITLE_GENERATION": False,
        "ENABLE_FOLLOW_UP_GENERATION": False,
        "ENABLE_TAGS_GENERATION": False,
    })
    request("/api/v1/tasks/config/update", tasks, token)
    configure_speech(request, token)

    request("/api/v1/retrieval/config/update", {"web": {
        "ENABLE_WEB_SEARCH": True,
        "WEB_SEARCH_ENGINE": "duckduckgo",
        "DDGS_BACKEND": "auto",
        "WEB_SEARCH_RESULT_COUNT": 3,
        "WEB_FETCH_MAX_CONTENT_LENGTH": 6000,
        "BYPASS_WEB_SEARCH_EMBEDDING_AND_RETRIEVAL": True,
        "BYPASS_WEB_SEARCH_WEB_LOADER": True,
    }}, token)

    for tool_id, name, description in (
        ("recipe_planner", "Recipe Planner", "Scale recipe portions and subtract confirmed stock without guessing inventory."),
        ("valio_recipes", "Valio Aimo Recipes", "Browse professional and bakery recipes and read structured ingredient data from Valio Aimo."),
    ):
        tool = {
            "id": tool_id,
            "name": name,
            "content": (FILES / "scripts" / "tools" / f"{tool_id}.py").read_text(),
            "meta": {"description": description},
        }
        existing = request(f"/api/v1/tools/id/{tool_id}", token=token, allow_missing=True)
        path = f"/api/v1/tools/id/{tool_id}/update" if existing else "/api/v1/tools/create"
        if existing is None:
            tool["access_grants"] = []
        request(path, tool, token)

    disabled_categories = (
        "time", "user_input", "files", "knowledge", "chats", "subagents", "memory",
        "image_generation", "code_interpreter", "notes", "channels", "skills", "tools",
        "tasks", "automations", "calendar", "notifications",
    )
    scenarios = json.loads((FILES / "agent" / "purchase-scenarios.json").read_text())
    recipes_enabled = os.environ.get("VALIO_AIMO_RECIPE_PERMISSION", "").lower() == "true"
    for model_id, name, persona in (
        ("restaurant-buyer", "Acme Kitchens", "restaurant"),
        ("bakery-buyer", "Acme Bakery", "bakery"),
    ):
        system = system_prompt(persona)
        if not recipes_enabled:
            system += "\nValio Aimo recipe research is disabled pending permission. Do not fetch recipe URLs or bypass this restriction through web tools. Recipe arithmetic on user-supplied ingredients remains available. The separate wholesaler purchasing API remains available."
        model = {
            "id": model_id,
            "base_model_id": base_model,
            "name": name,
            "params": {
                "system": system,
                "function_calling": "native",
                "temperature": 0.2,
                "max_tokens": max_tokens,
            },
            "meta": {
                "profile_image_url": "data:image/png;base64," + base64.b64encode(
                    (FILES / "agent" / f"{persona}.png").read_bytes()
                ).decode("ascii"),
                "description": f"{'Restaurant & hotel purchasing' if persona == 'restaurant' else 'Bakery purchasing'} · Finland\nPlan ingredients. Buy through the wholesaler MCP within your mandate.\n[Photographs via Wikimedia Commons](/static/acme/credits.html)",
                "capabilities": {
                    "web_search": True, "builtin_tools": True, "citations": True,
                    "vision": False, "file_upload": False, "terminal": False,
                    "code_interpreter": False, "image_generation": False, "memory": False,
                },
                "builtinTools": {**dict.fromkeys(disabled_categories, False), "web_search": True},
                "defaultFeatureIds": [],
                "toolIds": purchasing_tools + ["recipe_planner"] + (["valio_recipes"] if recipes_enabled else []),
                "skillIds": [],
                "suggestion_prompts": scenarios[persona],
            },
        }
        existing = request(f"/api/v1/models/model?id={model_id}", token=token, allow_missing=True)
        path = "/api/v1/models/model/update" if existing else "/api/v1/models/create"
        if existing is None:
            model["access_grants"] = []
        request(path, model, token)
        print(f"Configured {name} on {base_model}: purchasing suggestions, web research and guarded recipe tools.")

    for model_id in (base_model,):
        existing = request(f"/api/v1/models/model?id={model_id}", token=token, allow_missing=True)
        model = {
            "id": model_id,
            "base_model_id": None,
            "name": existing["name"] if existing else model_id,
            "params": existing["params"] if existing else {},
            "meta": {**(existing["meta"] if existing else {}), "hidden": True},
        }
        if existing is None:
            model["access_grants"] = []
        request("/api/v1/models/model/update" if existing else "/api/v1/models/create", model, token)

    defaults = request("/api/v1/configs/models", token=token)
    defaults.update({
        "DEFAULT_MODELS": "restaurant-buyer",
        "DEFAULT_PINNED_MODELS": "restaurant-buyer,bakery-buyer",
        "MODEL_ORDER_LIST": ["restaurant-buyer", "bakery-buyer"],
    })
    request("/api/v1/configs/models", defaults, token)
    previous = request("/api/v1/models/model?id=buyer-agent", token=token, allow_missing=True)
    if previous:
        request("/api/v1/models/model/update", {
            "id": "buyer-agent",
            "base_model_id": previous.get("base_model_id"),
            "name": previous["name"],
            "params": previous["params"],
            "meta": {**previous["meta"], "hidden": True},
            "is_active": False,
        }, token)
    print("Acme Kitchens is the default; both Acme models are pinned. The inference base and legacy Buyer agent are hidden.")
    print("Managed presets are private on first creation. Approval authority remains with the purchasing server.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, KeyError, ValueError, RuntimeError) as error:
        print(f"Agent setup failed: {error}", file=sys.stderr)
        sys.exit(1)
