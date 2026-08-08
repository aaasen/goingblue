#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SCRIPT_DIR/deploy.env" ] && source "$SCRIPT_DIR/deploy.env"

PROJECT="${PROJECT:?set PROJECT in deploy.env}"
REGION="${REGION:?set REGION in deploy.env}"
SQL_INSTANCE="${SQL_INSTANCE:?set SQL_INSTANCE in deploy.env}"
DB_NAME="${DB_NAME:?set DB_NAME in deploy.env}"
PUBLIC_URL="${PUBLIC_URL:?set PUBLIC_URL in deploy.env}"
SERVICE="${SERVICE:-$PROJECT}"
DB_USER="${DB_USER:-postgres}"

# Cloud SQL connection. INSTANCE_CONNECTION_NAME is "project:region:instance" (see the
# instance's "Connection name" in the console). Secrets are NOT here — DB_PASS (database
# password), TWILIO_AUTH_TOKEN (verifies the inbound-SMS webhook signature) and STATS_PASS (the
# /stats dashboard's basic-auth password) live in Secret Manager (see one-time setup in
# docs/private/DEPLOYMENT.md) and are injected as env vars.
INSTANCE_CONNECTION_NAME="${PROJECT}:${REGION}:${SQL_INSTANCE}"
TWILIO_WEBHOOK_URL="${PUBLIC_URL}/sms"
# Protocol version → codec-server service URL (deployed by deploy-codec.sh; see VERSIONING.md).
# An unmapped version gets the "please update the app" reply, so deploy the codec service for
# the current version BEFORE the first gateway deploy that expects it.
CODEC_URL_V1="$(gcloud run services describe "${SERVICE}-codec-v1" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"

gcloud run deploy "$SERVICE" --project "$PROJECT" --source . --region "$REGION" \
  --allow-unauthenticated --platform managed \
  --add-cloudsql-instances "$INSTANCE_CONNECTION_NAME" \
  --set-env-vars "INSTANCE_CONNECTION_NAME=$INSTANCE_CONNECTION_NAME,DB_USER=$DB_USER,DB_NAME=$DB_NAME,TWILIO_WEBHOOK_URL=$TWILIO_WEBHOOK_URL,CODEC_URL_V1=$CODEC_URL_V1" \
  --set-secrets "DB_PASS=DB_PASS:latest,TWILIO_AUTH_TOKEN=TWILIO_AUTH_TOKEN:latest,STATS_PASS=STATS_PASS:latest"
