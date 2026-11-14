import os
import urllib.parse

SERVER_ID = "trusted-trade"
TOOL_ID = f"server:mcp:{SERVER_ID}"


def grant_buyer(request, token, buyer_id):
    grant = {"principal_type": "user", "principal_id": buyer_id, "permission": "read"}
    settings = request("/api/v1/configs/tool_servers", token=token)
    for connection in settings.get("TOOL_SERVER_CONNECTIONS") or []:
        if (connection.get("info") or {}).get("id") == SERVER_ID:
            grants = connection["config"].setdefault("access_grants", [])
            if not any(all(item.get(key) == value for key, value in grant.items()) for item in grants):
                grants.append(grant)
    request("/api/v1/configs/tool_servers", settings, token)

def configure(request, token):
    url = os.environ.get("MCP_SERVER_URL", "").strip()
    if not url:
        raise ValueError("Set MCP_SERVER_URL to the purchasing server.")
    key = os.environ.get("MCP_AGENT_KEY", "")

    settings = request("/api/v1/configs/tool_servers", token=token)
    connections = settings.get("TOOL_SERVER_CONNECTIONS") or []
    existing = next((item for item in connections if (item.get("info") or {}).get("id") == SERVER_ID), None)
    connection = {
        "type": "mcp", "url": url, "path": "", "auth_type": "bearer" if key else "none", "key": key,
        "info": {"id": SERVER_ID, "name": "Trusted Trade", "description": "Wholesaler purchasing and MCP Apps"},
        "config": {**((existing or {}).get("config") or {}), "enable": True},
    }
    request("/api/v1/configs/tool_servers/verify", connection, token)
    settings["TOOL_SERVER_CONNECTIONS"] = [connection if item is existing else item for item in connections] if existing else connections + [connection]
    request("/api/v1/configs/tool_servers", settings, token)
    email = os.environ.get("BUYER_EMAIL", "chef@localhost.invalid")
    users = request("/api/v1/users/?" + urllib.parse.urlencode({"query": email}), token=token)["users"]
    for buyer in users:
        if buyer["email"].lower() == email.lower() and buyer["role"] == "user":
            grant_buyer(request, token, buyer["id"])
    print(f"Configured Trusted Trade MCP at {url}. No order or approval was submitted.")
    return [TOOL_ID]
