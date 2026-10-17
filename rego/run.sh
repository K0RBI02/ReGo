#!/bin/sh
# Read the options of the add-on (/data/options.json), optionally start Tailscale (https), then ReGo.
# Data lives in /data (it survives updates).
OPT=/data/options.json
get() { node -e "try{const o=require('$OPT');process.stdout.write(String(o['$1']??''))}catch(e){}"; }
export HOST=0.0.0.0 PORT=8080 REGO_DATA=/data REGO_VERBOSE=1
export NODE_OPTIONS="--dns-result-order=ipv4first $NODE_OPTIONS"      # bahn.de hangs here over IPv6 (timeout), IPv4 works
P=$(get provider); [ -n "$P" ] && export REGO_PROVIDER="$P"
F=$(get fcm_key); [ -n "$F" ] && export REGO_FCM_KEY="$F"
I=$(get invite_code); [ -n "$I" ] && export REGO_INVITE="$I"          # if set: new devices need this invitation code
C=$(get contact); [ -n "$C" ] && export REGO_CONTACT="$C"             # where testers send feedback (email address or link), shown in the app

# Network self-test: does the container reach bahn.de over IPv4 and over IPv6?
cat > /tmp/nettest.mjs <<'JS'
import https from 'node:https';
const t = (family) => new Promise((res) => {
  const r = https.get({ host: 'www.bahn.de', path: '/', family, timeout: 6000, headers: { 'user-agent': 'Mozilla/5.0' } }, (x) => { res('HTTP ' + x.statusCode); x.resume(); });
  r.on('timeout', () => { r.destroy(); res('Timeout'); }); r.on('error', (e) => res(e.code || e.message));
});
const m = () => new Promise((res) => {
  const r = https.get({ host: 'efa.mvv-muenchen.de', path: '/ng/XML_STOPFINDER_REQUEST?outputFormat=rapidJSON&type_sf=any&name_sf=Marienplatz', family: 4, timeout: 8000, headers: { 'user-agent': 'ReGo' } }, (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res('HTTP ' + x.statusCode + (b.includes('Marienplatz') ? ' (Haltestellen kommen an)' : ''))); });
  r.on('timeout', () => { r.destroy(); res('Timeout'); }); r.on('error', (e) => res(e.code || e.message));
});
console.log('Netztest bahn.de  IPv4: ' + await t(4) + '  IPv6: ' + await t(6));
console.log('Netztest MVV      IPv4: ' + await m());
JS
node /tmp/nettest.mjs

MODE=$(get ts_mode)
if [ "$MODE" = "serve" ] || [ "$MODE" = "funnel" ]; then
  HN=$(get ts_hostname); [ -z "$HN" ] && HN=rego
  KEY=$(get ts_authkey)
  TS="tailscale --socket=/tmp/tailscaled.sock"
  tailscale version 2>/dev/null | head -1
  mkdir -p /data/tailscale
  tailscaled --tun=userspace-networking --state=/data/tailscale/tailscaled.state --socket=/tmp/tailscaled.sock >/tmp/tailscaled.log 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do [ -S /tmp/tailscaled.sock ] && break; sleep 1; done
  if [ -n "$KEY" ]; then $TS up --authkey="$KEY" --hostname="$HN" --accept-dns=false || echo "Tailscale: Anmeldung fehlgeschlagen (Auth-Key prüfen)"
  else $TS up --hostname="$HN" --accept-dns=false || echo "Tailscale: nicht angemeldet. Auth-Key in den Add-on-Optionen eintragen."; fi
  if [ "$MODE" = "funnel" ]; then $TS funnel --bg 8080 || echo "Tailscale: Funnel konnte nicht starten"
  else $TS serve --bg 8080 || echo "Tailscale: Serve konnte nicht starten"; fi
  $TS serve status 2>&1 | head -5
fi
exec node server/index.mjs
