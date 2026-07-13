#!/bin/bash
set -euo pipefail

# Cloud SQL connection. INSTANCE_CONNECTION_NAME is "project:region:instance" (see the
# instance's "Connection name" in the console). Secrets are NOT here — DB_PASS (database
# password) and TWILIO_AUTH_TOKEN (verifies the inbound-SMS webhook signature) live in Secret
# Manager (see one-time setup in DEPLOYMENT.md) and are injected as env vars.
INSTANCE_CONNECTION_NAME="goingblue:us-west1:goingblue"
DB_USER="postgres"
DB_NAME="goingblue"
TWILIO_WEBHOOK_URL="https://going.blue/sms"

gcloud run deploy goingblue --project goingblue --source . --region us-west1 \
  --allow-unauthenticated --platform managed \
  --add-cloudsql-instances "$INSTANCE_CONNECTION_NAME" \
  --set-env-vars "INSTANCE_CONNECTION_NAME=$INSTANCE_CONNECTION_NAME,DB_USER=$DB_USER,DB_NAME=$DB_NAME,TWILIO_WEBHOOK_URL=$TWILIO_WEBHOOK_URL" \
  --set-secrets "DB_PASS=DB_PASS:latest,TWILIO_AUTH_TOKEN=TWILIO_AUTH_TOKEN:latest"
