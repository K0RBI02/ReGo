#!/bin/sh
# Trägt die Adresse der App in die Ressourcen ein. Aufruf: sh android/prepare.sh <host>
# Beispiel: sh android/prepare.sh rego-beta-app.tail2a5f03.ts.net
set -e
HOST="${1:?Adresse fehlt, z. B. rego-beta-app.tail2a5f03.ts.net}"
sed -i "s/__HOST__/$HOST/g" "$(dirname "$0")/app/src/main/res/values/strings.xml"
