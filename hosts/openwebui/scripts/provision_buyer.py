import base64
import json
import os
import sys
import urllib.parse

from provision_agent import BASE_MODEL, FILES, main as configure_agent, request
from provision_mcp import grant_buyer


def main():
    account = json.load(sys.stdin)
    email = account["email"].strip().lower()
    profile_image = "data:image/png;base64," + base64.b64encode(
        (FILES / "agent" / "chef.png").read_bytes()
    ).decode("ascii")
    configure_agent()
    login = request("/api/v1/auths/signin", {
        "email": os.environ["WEBUI_ADMIN_EMAIL"],
        "password": os.environ["WEBUI_ADMIN_PASSWORD"],
    })
    token = login["token"]
    users = request("/api/v1/users/?" + urllib.parse.urlencode({"query": email}), token=token)["users"]
    buyer = next((user for user in users if user["email"].lower() == email), None)
    if buyer and buyer["role"] != "user":
        raise RuntimeError("The buyer must be a non-admin user. Existing operator accounts are not changed.")

    permissions = request("/api/v1/users/default/permissions", token=token)
    for flags in permissions.values():
        for flag in flags:
            flags[flag] = False
    permissions["chat"]["delete"] = True
    permissions["chat"]["call"] = True
    permissions["chat"]["stt"] = True
    permissions["chat"]["tts"] = True
    permissions["features"]["web_search"] = True
    request("/api/v1/users/default/permissions", permissions, token)

    interface = request("/api/v1/configs/namespace/ui", token=token)
    visibility = interface.get("ui.visibility") or {}
    for control in (
        "chat.capture", "chat.compare", "chat.attach_webpage", "chat.attach_files",
        "chat.attach_notes", "chat.attach_knowledge", "chat.reference_chats",
        "chat.status", "chat.model_command", "chat.settings_command", "chat.usage",
        "chat.merge", "chat.code_preview", "chat.fork", "chat.artifacts",
        "chat.archive", "chat.tags", "models.set_default", "models.pin",
    ):
        visibility[control] = False
    request("/api/v1/configs/interface/visibility", {"visibility": visibility}, token)

    if buyer is None:
        buyer = request("/api/v1/auths/add", {
            "email": email,
            "name": "Chef",
            "password": account["password"],
            "role": "user",
            "profile_image_url": profile_image,
        }, token)
        print(f"Created non-admin buyer {email}.")
    else:
        request(f"/api/v1/users/{buyer['id']}/update", {
            "role": "user",
            "profile_image_url": profile_image,
        }, token)
        print(f"Keeping existing password for non-admin buyer {email}.")

    grant = {"principal_type": "user", "principal_id": buyer["id"], "permission": "read"}
    base_model = os.environ.get("AGENT_MODEL_ID") or BASE_MODEL
    # The pinned WebUI enforces read access at each preset's base-model hop.
    for model_id in ("restaurant-buyer", "bakery-buyer", base_model):
        model = request(f"/api/v1/models/model?id={model_id}", token=token)
        grants = model.get("access_grants") or []
        if not any(all(existing.get(key) == value for key, value in grant.items()) for existing in grants):
            request("/api/v1/models/model/access/update", {
                "id": model_id,
                "access_grants": [*grants, grant],
            }, token)

    tool_ids = ["recipe_planner"]
    if os.environ.get("VALIO_AIMO_RECIPE_PERMISSION", "").lower() == "true":
        tool_ids.append("valio_recipes")
    for tool_id in tool_ids:
        tool = request(f"/api/v1/tools/id/{tool_id}", token=token)
        grants = tool.get("access_grants") or []
        if not any(all(existing.get(key) == value for key, value in grant.items()) for existing in grants):
            request(f"/api/v1/tools/id/{tool_id}/access/update", {
                "access_grants": [*grants, grant],
            }, token)

    if os.environ.get("MCP_SERVER_URL", "").strip():
        grant_buyer(request, token, buyer["id"])

    print("Buyer access: Acme Kitchens and Acme Bakery; the inference base remains hidden.")
    print("Optional user features are disabled. Voice and existing resource grants are preserved.")
    print("The administrator remains unrestricted. Purchasing follows the server mandate; no approval authority was added.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, KeyError, ValueError, RuntimeError) as error:
        print(f"Buyer setup failed: {error}", file=sys.stderr)
        sys.exit(1)
