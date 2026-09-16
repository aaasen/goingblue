#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SCRIPT_DIR/deploy.env" ] && source "$SCRIPT_DIR/deploy.env"

PROJECT="${PROJECT:?set PROJECT in deploy.env}"
REGION="${REGION:?set REGION in deploy.env}"
SQL_INSTANCE="${SQL_INSTANCE:?set SQL_INSTANCE in deploy.env}"
DB_NAME="${DB_NAME:?set DB_NAME in deploy.env}"
PUBLIC_URL="${PUBLIC_URL:?set PUBLIC_URL in deploy.env}"
SERVICE="${SERVICE:?set SERVICE in deploy.env}"
TWILIO_ACCOUNT_SID="${TWILIO_ACCOUNT_SID:?set TWILIO_ACCOUNT_SID in deploy.env}"
DB_USER="${DB_USER:-postgres}"

INSTANCE_CONNECTION_NAME="${PROJECT}:${REGION}:${SQL_INSTANCE}"
TWILIO_WEBHOOK_URL="${PUBLIC_URL}/sms"
TWILIO_SINK_URL="${PUBLIC_URL}/twilio-sink"
ENCODE_QUEUE="projects/${PROJECT}/locations/${REGION}/queues/encode"
ENCODE_URL="${PUBLIC_URL}/encode"
HEALTH_CHECK_URL="${PUBLIC_URL}/health-check"
# The service account Cloud Tasks and Cloud Scheduler mint identity tokens for: the runtime
# account itself. /encode and /health-check accept only tokens for this account (invoker.ts).
INVOKER_EMAIL="$(gcloud projects describe "$PROJECT" --format 'value(projectNumber)')-compute@developer.gserviceaccount.com"

# Supported codec services.
CODEC_URL_V1="$(gcloud run services describe "${SERVICE}-codec-v1" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
CODEC_URL_V2="$(gcloud run services describe "${SERVICE}-codec-v2" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
CODEC_URL_V3="$(gcloud run services describe "${SERVICE}-codec-v3" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
CODEC_URL_V4="$(gcloud run services describe "${SERVICE}-codec-v4" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
CODEC_URL_V5="$(gcloud run services describe "${SERVICE}-codec-v5" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"

gcloud run deploy "$SERVICE" --project "$PROJECT" --source . --region "$REGION" \
  --allow-unauthenticated --platform managed --timeout 60 \
  --add-cloudsql-instances "$INSTANCE_CONNECTION_NAME" \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT,INSTANCE_CONNECTION_NAME=$INSTANCE_CONNECTION_NAME,DB_USER=$DB_USER,DB_NAME=$DB_NAME,TWILIO_WEBHOOK_URL=$TWILIO_WEBHOOK_URL,TWILIO_SINK_URL=$TWILIO_SINK_URL,TWILIO_ACCOUNT_SID=$TWILIO_ACCOUNT_SID,ENCODE_QUEUE=$ENCODE_QUEUE,ENCODE_URL=$ENCODE_URL,HEALTH_CHECK_URL=$HEALTH_CHECK_URL,INVOKER_EMAIL=$INVOKER_EMAIL,CODEC_URL_V1=$CODEC_URL_V1,CODEC_URL_V2=$CODEC_URL_V2,CODEC_URL_V3=$CODEC_URL_V3,CODEC_URL_V4=$CODEC_URL_V4,CODEC_URL_V5=$CODEC_URL_V5" \
  --set-secrets "DB_PASS=DB_PASS:latest,TWILIO_AUTH_TOKEN=TWILIO_AUTH_TOKEN:latest,STATS_PASS=STATS_PASS:latest"
