# Proofdeck

Test management in the spirit of Zephyr Scale, with one-click bug reports from failed steps.
Zero npm dependencies: Node 22.13+ and its built-in SQLite.

```
npm start            # http://127.0.0.1:4780
npm test             # API tests (isolated server + database per file)
./e2e/run.sh         # browser checks, needs a Chromium-based browser (see the script header)
npm run reset-password -- --list   # locked out? see "Forgot the admin password" below
```

## First run

Open the app. With no users yet it asks you to **create the admin account**; that account can add everyone else
under **Users**. Until it exists, anyone who can reach the server can claim it, so do this before exposing the port.

## Forgot the admin password

On the machine running Proofdeck (works while it runs; uses `DATA_DIR` like the server):

```
npm run reset-password -- --list                       # who exists
npm run reset-password -- ada                          # prompts, input hidden
npm run reset-password -- ada --make-admin --activate  # also promote / re-enable
echo 'a new password' | npm run reset-password -- ada --password-stdin
```

All of that user's sessions are ended.

## What it does

- **Test cases** with steps (action / test data / expected), folders (tree, drag and drop, bulk move), labels, priority.
- **Call-to-test**: a step can run another test case's steps (loops are refused). **Data sets**: `{{column}}`
  placeholders, one execution per row.
- **Version history** for every case: compare any version with the current one, restore it. Runs remember which version they used.
- **Requirements**: link cases to Jira keys, `#123` GitHub issues or any name; the coverage report shows what is covered and how it last ran.
- **Test cycles** and **test plans** (a plan groups cycles with rolled-up progress). Clone a cycle, or only its failed cases.
  Run any case on its own (standalone run).
- **Test player**: pass / fail / blocked per step, actual result, screenshots and files (paste, drop or pick), keyboard shortcuts.
- **Create bug from a failed step**: expected result, actual result, screenshots and an editable *steps to reproduce*
  (pre-filled from the steps up to the failure, including which called case each came from and the data set used).
- **Screenshot annotator** (arrow, box, pen, text) and attachments: images, PDF, text/log, CSV, JSON, ZIP, MP4, WebM.
- **Jira Cloud / GitHub**: send a bug as an issue (Jira gets the attachments; GitHub's API cannot take images).
- **Import** CSV / Excel (column mapping, Zephyr-style one row per step, issue coverage becomes requirement links, HTML rich text can be
  stripped) and **export** CSV / Excel. Importing can **update existing cases** by ID or by title and folder instead of making duplicates:
  only the mapped columns change, steps are replaced only if the file has steps, and a blank priority/status never overwrites.
- **CI results API**: record automated test results from any pipeline (see below).
- **Reports**: results per cycle, coverage of each case, failure hotspots, flaky tests, bug stats, tester activity, requirement coverage.
- **Accounts**: roles *admin*, *tester*, *viewer* (read only). Everything is attributed: who wrote a version, ran a test, filed or was assigned a bug.

## CI results

Create a token under **API tokens** (admin, per project; shown once, stored as a SHA-256 hash). A token can call only `/api/ci/*`,
never the rest of the API. Put it in your CI secrets as `PROOFDECK_TOKEN`.

```
# A JUnit XML report (Jest, pytest, Playwright, Maven/Gradle, Go...). The cycle is found or created from name + build,
# so retries and parallel shards add to the same cycle.
curl -sS -X POST "$URL/api/ci/junit?cycle=Nightly&build=$BUILD_ID&environment=CI&autoCreate=1&createBugs=1" \
  -H "Authorization: Bearer $PROOFDECK_TOKEN" -H "Content-Type: application/xml" --data-binary @junit.xml

# JSON results
curl -sS -X POST "$URL/api/ci/results" -H "Authorization: Bearer $PROOFDECK_TOKEN" -H "Content-Type: application/json" \
  -d '{"cycle":{"name":"Nightly","build":"1.4.2"},
       "results":[{"case":"PROJ-T1","status":"Pass"},
                  {"automation_key":"login.spec.ts::rejects a wrong password","status":"Fail","message":"Expected 401"}]}'

# Gate the pipeline: non-zero unless every test in the cycle passed
curl -sS "$URL/api/ci/cycle?name=Nightly&build=$BUILD_ID" -H "Authorization: Bearer $PROOFDECK_TOKEN" | jq -e '.ok'
```

- **Matching**: `case` is a key (`PROJ-T1`) or id; `automation_key` matches the key set on a test case (JUnit uses `classname::name`,
  or just the name with `&key=name`). Sending both once binds the automation key to the case. Unknown keys are reported per result,
  or created as draft cases with `autoCreate` (skipped tests never create cases).
- **Status**: `Pass`, `Fail`, `Blocked` (also `passed`, `failed`, `error`, ...) or `Skipped` (recorded as nothing). Optional per-step
  `steps: [{position, status, actual}]`, a data-set `iteration`, `message`, `duration_ms`, and `attachments` (logs, screenshots).
- **Bugs**: `createBugs` opens one bug for a failing case. While it stays open, later failures add a comment instead of new bugs.
- **Safety**: each result is applied in a savepoint, so one bad result never leaves half a change; add `strict=true` to save nothing
  if any result has a problem. Up to 5000 results per request.
- Invalid tokens are throttled; a valid token is never locked out.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4780` | Port to listen on (`0` picks a free one) |
| `HOST` | `127.0.0.1` | Interface. Keep it on localhost, or put a TLS-terminating reverse proxy in front |
| `DATA_DIR` | `./data` | Database (`proofdeck.db`) and `secret.key` |
| `COOKIE_SECURE` | unset | `1` adds the `Secure` flag to the session cookie. Set it when served over HTTPS |
| `TRUST_PROXY` | unset | `1` trusts `X-Forwarded-Proto: https` from a reverse proxy to add `Secure` |
| `PROOFDECK_SECRET` | unset | Encrypts stored Jira/GitHub tokens with this value instead of `data/secret.key` |
| `PUBLIC_URL` | unset | Public address of Proofdeck, used for the link back from Jira/GitHub issues |

## Security notes

- Passwords are hashed with scrypt. Sessions are random tokens in `HttpOnly`, `SameSite=Strict` cookies; only a hash is stored.
- Five wrong passwords lock that user and address for 30 seconds, doubling each time (kept in memory, resets on restart).
- Writes must be JSON and, when the browser sends an `Origin`, from the same site. Roles are enforced on the server;
  hiding buttons for viewers is only a convenience.
- Integration tokens are encrypted (AES-256-GCM). Whoever can read both `proofdeck.db` and `secret.key` can decrypt them,
  so keep `DATA_DIR` private, or use `PROOFDECK_SECRET`.
- Uploads are limited to an allow-list and the bytes must match the claimed type. Images and video display inline; everything
  else downloads. HTML, SVG and scripts are refused.
- Integration URLs must be `https://` (plain `http://` only for localhost).

## Backups

Everything lives in `DATA_DIR`. For a consistent copy while the server runs:
`sqlite3 data/proofdeck.db ".backup 'backup.db'"`. Keep `secret.key` with it if you use Jira/GitHub.

## Layout

```
server.js            core: database, cases, cycles, executions, bugs, HTTP
routes/              auth, integrations, reports, plans, traceability, API tokens, CI
lib/                 auth, secret, integrations (Jira/GitHub), versions, links, import, export, JUnit reader
scripts/             reset-password, check-integration
public/              the web app (vanilla JS, no build step)
test/                API tests (node --test)
e2e/                 browser checks over the DevTools protocol
```

## Known limits

- Jira support is Jira Cloud (API token). Jira Server/Data Center is not covered. GitHub issues cannot receive images.
- The Jira and GitHub integrations are tested against local fakes of their APIs. The GitHub client has also been checked against
  the real GitHub API for its error path. To verify yours with real credentials (read-only by default):
  `GITHUB_TOKEN=... npm run check-integration -- github --owner ORG --repo REPO` or
  `JIRA_TOKEN=... npm run check-integration -- jira --base https://team.atlassian.net --email you@co.com --project PROJ`
  (add `--create` to file one clearly labelled throwaway issue).
- Excel import is tested with hand-written workbooks shaped like Excel's own output, not files saved by Excel. Dates arrive as
  their serial numbers.
- Old `.xls` files are not read; save as `.xlsx` or CSV.
- A single process with a single SQLite file: built for a team, not for large-scale hosting.
