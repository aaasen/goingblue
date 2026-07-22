# Protocol Versioning

How Going Blue ships new protocol versions without breaking clients in the field.

## The scheme

Old protocol versions are kept alive as **frozen containers**, not as code paths on main:

- **`packages/server` — the gateway.** Continuously deployed, never frozen. Owns every
  transport (Twilio SMS, inbound email, Garmin replies), accounts, quotas, request logging,
  legal pages, and the web app. It routes each forecast request to the codec server for the
  request's protocol version and knows almost nothing about the message grammar.
- **`packages/codec-server` — one running container per shipped protocol version.** Stateless:
  parse the request, fetch Open-Meteo, encode, reply. When a version is superseded, its
  container (built from a git tag) simply keeps running; main deletes the old version's code
  entirely and carries **only the current version**.

Rationale: the codec's compat requirement is *bit-exactness*, not API-shape compatibility. A
codebook regeneration or shared-helper refactor can silently move one bit of an old version's
output, and a deployed client with no reception to update decodes garbage. Freezing the whole
container makes that class of breakage impossible; the golden corpus (below) covers the rest.

## Contracts frozen forever

Everything not listed here may change freely between versions.

1. **The request carries an explicit `vN` word** (e.g. `v1`), matched case-insensitively as a
   whole whitespace-separated word. **There is no default version**: a request without one is
   answered with a human-readable "include a version or update the app" reply, never routed.
   Clients must always send it (the app always has, since the first release).
2. **The `u:` account-token word.** The gateway extracts it for quotas and logging; its grammar
   (`u:` + token with check symbol, `packages/protocol/src/token.ts`) cannot change.
3. **The response version prefix**: every encoded message begins with one base-85 character
   whose alphabet index is the protocol version (`packages/protocol/src/version.ts`), so any
   decoder can identify a message's version before knowing anything else about its layout.
4. **The gateway ↔ codec wire contract**:
   `POST {CODEC_URL_V<N>}/encode` with the raw request text as the body →
   `200` encoded message · `400` malformed request · `503` upstream unavailable.
   `GET /health` → `200`. Nothing else.

The gateway's version → backend mapping is env config: `CODEC_URL_V1`, `CODEC_URL_V2`, … An
unmapped version (never existed, or sunset) gets a static "please update the app" reply.

## Version lifecycle

**Develop.** Main carries exactly one version. While the current version has *no* deployed
clients, iterate on it freely (codebooks, layout, fill order — no version bump needed).

**Ship.** The moment version N reaches real clients, N is bit-frozen: record the golden corpus
(below) and let it enforce on main that no change moves a bit of vN's output. From here, any
encoding change belongs to version N+1.

**Freeze (when N+1 ships).** Runbook:

1. `git tag codec-vN <last-commit-with-vN>` and push the tag.
2. From a clean checkout of the tag, build and push the image (`Dockerfile.codec`), e.g. via
   `cloudbuild-codec.yaml`, tagged `codec:vN`.
3. Deploy it as Cloud Run service `goingblue-codec-vN`, min instances 0 (scale-to-zero: a
   quiet old version costs nothing). Env: `OPEN_METEO_BASE_URL` unset (live API).
4. Run `verify-container` against the deployed URL — recorded fixtures in, golden bits out.
5. Set `CODEC_URL_VN` on the gateway to the service URL.
6. On main: delete `packages/protocol/src/versions/vN.ts`, its codebooks, its golden fixtures,
   and any vN-only encoder policy. Bump `CURRENT_VERSION`. The app treats saved vN messages as
   expired (past forecasts are a short-lived buffer, not storage).

**Patch a frozen version** (base-image CVE, Open-Meteo shape change, secret plumbing): branch
from the `codec-vN` tag, make the surgical fix, rebuild the image, and gate the swap on
`verify-container` passing — bit-identical output or it doesn't deploy. Tag the result
`codec-vN.1` etc.

**Sunset.** The gateway records every served request's version (`requests.version` in
Postgres). When a version has been quiet for a few months —

```sql
select version, count(*), max(created_at) from requests
group by version order by version;
```

— delete its Cloud Run service and its `CODEC_URL_VN` mapping. From then on, stragglers get
the "please update the app" reply. Don't guess the window from expedition length: the tail is
set by seasonal users who last opened the app with connectivity months ago, so measure.

## Golden corpus

`packages/codec-server/test/golden/` holds recorded request → response fixtures: for each of a
set of representative requests, the exact Open-Meteo responses (keyed by request URL) and the
exact encoded output.

- **Record** (at ship time, hits the live API):
  `node packages/codec-server/scripts/record-goldens.ts`
- **Enforce on main** (`test/golden.test.ts`, runs in every `pnpm test`): replays the recorded
  responses through the pipeline and asserts byte-identical output. While version N has
  deployed clients, a red golden test means "this change breaks phones in the field — it must
  be version N+1".
- **Verify a container** (rebuilds of frozen images):
  `node packages/codec-server/scripts/verify-container.ts --codec-url <url>` serves the
  recorded responses from a local fixture server; start the container under test with
  `OPEN_METEO_BASE_URL` pointing at it, and the script diffs every golden case.

Pinned inputs are what make exact-output assertions meaningful: same request + same recorded
upstream bytes → fully deterministic output, so any diff is a real behavior change, never
weather.

## Why old containers stay boring

The gateway owns everything that wants to keep evolving (Twilio, accounts, abuse handling,
billing, web). A frozen codec container talks to exactly two parties — the gateway in front,
Open-Meteo behind — and holds no state and no secrets beyond env-injected config. The main
residual risk is upstream drift; seamless models absorb model churn without changing the API
shape, and the patch runbook covers the rare shape change.
