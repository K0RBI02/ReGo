# Built by GitHub Actions (context = repo root), not on the Pi. The Pi only downloads the finished image.
# Current Tailscale straight from the official image (the Alpine package is often outdated)
FROM docker.io/tailscale/tailscale:stable AS ts

FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/K0RBI02/ReGo" \
      org.opencontainers.image.description="ReGo – public-transport app for commuters (Home Assistant add-on)"
COPY --from=ts /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=ts /usr/local/bin/tailscale /usr/local/bin/tailscale
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY public ./public
COPY rego/config.yaml ./config.yaml
COPY rego/run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]
