#!/bin/bash
set -euo pipefail

# Cloud SQL connection. INSTANCE_CONNECTION_NAME is "project:region:instance" (see the
# instance's "Connection name" in the console). The password is NOT here — it lives in
# Secret Manager (see one-time setup in DEPLOYMENT.md) and is injected as the DB_PASS env var.
INSTANCE_CONNECTION_NAME="goingblue:us-west1:goingblue"
DB_USER="postgres"
DB_NAME="goingblue"

gcloud run deploy goingblue --project goingblue --source . --region us-west1 \
  --allow-unauthenticated --platform managed \
  --add-cloudsql-instances "$INSTANCE_CONNECTION_NAME" \
  --set-env-vars "INSTANCE_CONNECTION_NAME=$INSTANCE_CONNECTION_NAME,DB_USER=$DB_USER,DB_NAME=$DB_NAME" \
  --set-secrets "DB_PASS=DB_PASS:latest"
