FROM ghcr.io/open-webui/open-webui:v0.13.3@sha256:46b59158e6558eeb980bc828e0f1b30238ad24d82ed84d5e5eda1dab2a082f14
LABEL io.trusted-trade.service="openwebui"

COPY hosts/openwebui/branding/custom.css /app/backend/open_webui/static/custom.css
COPY hosts/openwebui/branding/ /app/backend/open_webui/static/acme/
COPY hosts/openwebui/branding/custom.css /app/build/static/custom.css
COPY hosts/openwebui/branding/ /app/build/static/acme/
COPY hosts/openwebui/agent/ /opt/trusted-trade/hosts/openwebui/agent/
COPY hosts/openwebui/scripts/ /opt/trusted-trade/hosts/openwebui/scripts/
COPY skills/trusted-trade-ordering/ /opt/trusted-trade/skills/trusted-trade-ordering/
