#!/bin/bash
gcloud run deploy goingblue --project goingblue --source . --region us-west1 --allow-unauthenticated --platform managed
