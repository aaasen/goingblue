#!/bin/bash
set -euo pipefail

# Deploys the codec server for ONE protocol version as its own Cloud Run service.
#
#   ./deploy-codec.sh <protocol-version>     # e.g. ./deploy-codec.sh 1
#
# For the CURRENT version, run from main. For a FROZEN version, run from a clean checkout of
# its codec-v<N> git tag, and gate the rollout on verify-container passing against the new
# image (see VERSIONING.md). After the first deploy of a version, point the gateway at it by
# setting CODEC_URL_V<N> in deploy.sh to the service URL this prints.
V="${1:?usage: deploy-codec.sh <protocol-version>}"
PROJECT="goingblue"
REGION="us-west1"
# One-time setup: gcloud artifacts repositories create codec --repository-format=docker \
#   --project goingblue --location us-west1
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/codec/codec:v${V}"

gcloud builds submit --project "$PROJECT" --config cloudbuild-codec.yaml \
  --substitutions "_IMAGE=${IMAGE}" .

# Scale-to-zero (the default min-instances) keeps a quiet frozen version effectively free.
# The service is unauthenticated for now: it holds no secrets and serves only public weather
# data; tightening to IAM-authenticated invocation from the gateway is a later hardening step.
gcloud run deploy "goingblue-codec-v${V}" --project "$PROJECT" --region "$REGION" \
  --image "$IMAGE" --platform managed --allow-unauthenticated

echo
echo "Service URL (set CODEC_URL_V${V} to this in deploy.sh, then redeploy the gateway):"
gcloud run services describe "goingblue-codec-v${V}" --project "$PROJECT" --region "$REGION" \
  --format 'value(status.url)'
