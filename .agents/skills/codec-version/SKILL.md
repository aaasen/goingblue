---
name: codec-version
description: Freeze the codec and bump the codec version
---

The Going Blue codec is versioned. See the "Codec Versioning" section of the README for an explanation of the versioning scheme and why it is necessary. 

The codec needs to be frozen before each new version of the app is submitted to the App Store or Google Play so that the codec does not change once the app version goes live. After the codec is frozen, the codec version can be bumped to resume development.

The steps for freezing the codec are:
1. Record goldens for the current codec version. This pulls forecast data from Open-Meteo and records responses to ensure that they never change.
```
pnpm --filter @weather/protocol build
pnpm exec tsx packages/codec-server/scripts/record-goldens.ts
```
2. Ensure all tests pass with `pnpm test`.
3. Commit with the message "Record v<n> goldens", create a git tag `codec-v<n>`, and ask the user to push it.
4. Ensure that the currently deployed codec image matches the frozen version. Ask the user to deploy the current codec with `./deploy-codec.sh <n>`. This must run before the version bump below.

After freezing the codec, bump the version to resume development:
1. Bump `WIRE_VERSION` in `packages/protocol/src/wire.ts`.
2. Delete the goldens for the old version at `packages/codec-server/test/golden/goldens.json`. These were recorded with the old codec version so they will fail once the version is bumped.
3. Regenerate the wire fixture to capture the new version:
```
pnpm --filter @weather/protocol build
pnpm exec tsx packages/protocol/scripts/generate-fixture.ts
```
4. Run `pnpm test` and ensure that all tests pass.

Then, deploy the new codec. Do not run these steps without explicit permission:
1. Run `./deploy-codec.sh <n>` where `n` is the new codec version.
2. Add a `CODEC_URL_V<n>` mapping to `deploy.sh` and add it to the environment variables string.
3. Run `./deploy.sh` to update the gateway with the new codec version.
