# Wird von GitHub Actions gebaut (Kontext = Repo-Wurzel), nicht auf dem Pi. Der Pi lädt nur das fertige Image.
# Aktuelles Tailscale direkt aus dem offiziellen Image (das Alpine-Paket ist oft veraltet)
FROM docker.io/tailscale/tailscale:stable AS ts

FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/K0RBI02/ReGo" \
      org.opencontainers.image.description="ReGo – ÖPNV-App für Pendler (Home-Assistant-Add-on)"
COPY --from=ts /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=ts /usr/local/bin/tailscale /usr/local/bin/tailscale
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY public ./public
COPY rego/run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]
