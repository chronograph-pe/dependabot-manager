# dependabot-manager

A reusable GitHub Action for intelligent Dependabot alert triage. Deploy it once and call it from every private repository in your organisation.

---

## How it works

Every Dependabot alert passes through a sequential decision tree:

```
dependabot_alert (created / reintroduced)
│
├─ severity < min-severity?
│     YES → dismiss alert                              (dismissed-low-severity)
│
├─ development / test dependency?
│     YES → dismiss alert                              (dismissed-dev-dependency)
│
├─ no patched version available?
│     YES → webhook: manual review required            (webhook-no-fix)
│
├─ minor / patch version bump?
│   │
│   ├─ enable-auto-merge = true
│   │     → queue for PR auto-merge                    (queued-for-auto-merge)
│   │
│   └─ enable-auto-merge = false  (default)
│         → webhook: minor bump notification           (webhook-minor-bump)
│
└─ major version bump?
      → webhook: manual investigation required         (webhook-major-bump)


pull_request opened by dependabot[bot]
│
├─ enable-auto-merge = false?   → skip                (skipped-auto-merge-disabled)
├─ title unparseable?           → skip                (skipped-unparseable-title)
├─ major bump?                  → skip                (skipped-major-bump)
├─ severity < min-severity?     → skip                (skipped-low-severity)
├─ development dependency?      → skip                (skipped-dev-dependency)
└─ all checks pass              → approve + auto-merge (auto-merge-enabled)
```

---

## Repository structure

```
├── action.yml                        # Composite action — the core engine
├── package.json                      # @actions/core + @actions/github
├── src/
│   ├── handle-alert.js               # Processes dependabot_alert events
│   ├── handle-automerge.js           # Processes pull_request events from dependabot[bot]
│   └── utils.js                      # Semver, dev-dep detection, webhook signing
├── .github/workflows/
│   ├── handle-alert.yml              # Reusable workflow — call from consuming repos
│   └── handle-automerge.yml          # Reusable workflow — call from consuming repos
└── examples/
    └── caller-workflow.yml           # Template to copy into each consuming repo
```

---

## Quickstart

### 1. Prepare this repository

Replace every occurrence of `YOUR_ORG` in the reusable workflows and example with your actual GitHub organisation or username.

Tag a release so consuming repos can pin to a stable version:

```bash
git add .
git commit -m "chore: initial release"
git tag v1
git push origin main --tags
```

### 2. Add the caller workflow to each consuming repo

Copy `examples/caller-workflow.yml` to `.github/workflows/dependabot-manager.yml` in each target repository. Replace `YOUR_ORG` with your org/username.

### 3. Configure secrets and variables

Set the following in each consuming repo, or at the organisation level so all repos inherit them automatically:

| Name | Type | Required | Description |
|---|---|---|---|
| `DEPENDABOT_MANAGER_TOKEN` | Secret | Yes | PAT or GitHub App token — see permissions below |
| `WEBHOOK_SECRET` | Secret | No | HMAC signing secret for webhook payloads |
| `SECURITY_WEBHOOK_URL` | Variable | No | Endpoint URL for notifications (Slack, PagerDuty, etc.) |

### 4. (Optional) Enable auto-merge

Only needed if you set `enable-auto-merge: 'true'` in the caller workflow.

1. Go to **Settings → General → Pull Requests** and enable **Allow auto-merge**.
2. Configure branch protection on your default branch to require at least one passing status check — this is what tells GitHub when it is safe to merge automatically.

---

## Caller workflow

Copy this to `.github/workflows/dependabot-manager.yml` in each consuming repo:

```yaml
name: Dependabot Manager

on:
  dependabot_alert:
    types: [created, reintroduced]
  pull_request:
    types: [opened, synchronize]

concurrency:
  group: dependabot-manager-${{ github.event_name }}-${{ github.event.alert.number || github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  handle-alert:
    if: github.event_name == 'dependabot_alert'
    uses: YOUR_ORG/dependabot-manager/.github/workflows/handle-alert.yml@v1
    secrets: inherit
    with:
      min-severity: medium
      enable-auto-merge: 'false'        # set to 'true' to enable auto-merge
      webhook-url: ${{ vars.SECURITY_WEBHOOK_URL }}

  handle-automerge:
    if: github.event_name == 'pull_request' && github.actor == 'dependabot[bot]'
    uses: YOUR_ORG/dependabot-manager/.github/workflows/handle-automerge.yml@v1
    secrets: inherit
    with:
      min-severity: medium
      enable-auto-merge: 'false'        # must match handle-alert above
      merge-method: squash
```

> `enable-auto-merge` must be set to the same value in both jobs. When `false` (the default) the automerge job exits immediately and the alert handler sends a webhook for minor bumps instead.

---

## Inputs reference

All inputs are available on both the composite action (`action.yml`) and the reusable workflows.

| Input | Default | Description |
|---|---|---|
| `github-token` | — | **Required.** Token with the permissions listed below. |
| `min-severity` | `medium` | Minimum severity to act on. Alerts below this are dismissed. Allowed: `low` \| `medium` \| `high` \| `critical` |
| `enable-auto-merge` | `false` | `'true'` to approve Dependabot PRs and enable auto-merge for minor/patch bumps. `'false'` sends a webhook notification instead. |
| `webhook-url` | `""` | HTTPS endpoint for notifications (major bumps, no-fix alerts, minor bumps when auto-merge is off). |
| `webhook-secret` | `""` | HMAC-SHA256 secret for signing webhook payloads. Always store as a GitHub Secret. |
| `merge-method` | `squash` | Merge strategy when auto-merging. Allowed: `merge` \| `squash` \| `rebase` |
| `action-ref` | `v1` | Git ref of this repo to check out. Pin to a SHA in high-security environments. |

### Output: `action-taken`

The step output `action-taken` describes what the action did. Useful for conditional follow-up steps.

| Value | Meaning |
|---|---|
| `dismissed-low-severity` | Alert dismissed — severity was below `min-severity` |
| `dismissed-dev-dependency` | Alert dismissed — package is a dev/test dependency |
| `webhook-no-fix` | Webhook sent — no patched version is currently available |
| `webhook-minor-bump` | Webhook sent — minor/patch bump with auto-merge disabled |
| `webhook-major-bump` | Webhook sent — major version bump requires manual investigation |
| `queued-for-auto-merge` | Minor/patch bump, Dependabot PR will be auto-merged |
| `auto-merge-enabled` | PR approved and auto-merge enabled |
| `skipped-auto-merge-disabled` | Automerge workflow ran but `enable-auto-merge` is false |
| `skipped-major-bump` | Automerge workflow skipped — major bump detected |
| `skipped-low-severity` | Automerge workflow skipped — related alert below threshold |
| `skipped-dev-dependency` | Automerge workflow skipped — dev dependency |
| `skipped-not-dependabot` | Automerge workflow skipped — PR not from dependabot[bot] |
| `skipped-unparseable-title` | Automerge workflow skipped — could not parse version from PR title |

---

## Required token permissions

Use a **GitHub App token** or a **dedicated service account PAT** — not your personal token. This also sidesteps the GitHub restriction that prevents a user from approving pull requests they opened.

| Permission | Scope | Reason |
|---|---|---|
| `security-events` | write | Dismiss Dependabot alerts |
| `pull-requests` | write | Approve PRs and enable auto-merge |
| `contents` | read | Read package manifests and lockfiles |

When using `secrets: inherit`, grant these permissions in the caller workflow's `permissions:` block.

---

## Webhook payloads

All webhook POSTs use `Content-Type: application/json`. When `webhook-secret` is configured the body is HMAC-SHA256 signed and the signature is sent in the `X-Hub-Signature-256` header, using the same format as native GitHub webhooks.

### `minor-bump-notify`

Sent when a minor/patch fix is available but `enable-auto-merge` is `false`.

```json
{
  "event": "minor-bump-notify",
  "alert_number": 12,
  "package": "lodash",
  "ecosystem": "npm",
  "severity": "high",
  "summary": "Prototype pollution in lodash",
  "vulnerable_range": ">= 4.0.0, < 4.17.21",
  "installed_version": "4.17.20",
  "fixed_version": "4.17.21",
  "alert_url": "https://github.com/org/repo/security/dependabot/12",
  "repository": "org/repo",
  "message": "\"lodash\" has a minor/patch fix available (4.17.20 → 4.17.21). Auto-merge is disabled — please review and merge manually."
}
```

### `major-bump-required`

Sent when fixing the vulnerability requires a major version bump.

```json
{
  "event": "major-bump-required",
  "alert_number": 42,
  "package": "express",
  "ecosystem": "npm",
  "severity": "high",
  "summary": "Prototype pollution in express",
  "vulnerable_range": "< 5.0.0",
  "installed_version": "4.18.2",
  "fixed_version": "5.0.0",
  "alert_url": "https://github.com/org/repo/security/dependabot/42",
  "repository": "org/repo",
  "message": "\"express\" requires a MAJOR version bump (4.18.2 → 5.0.0). Manual investigation required."
}
```

### `no-fix-available`

Sent when there is no patched version yet.

```json
{
  "event": "no-fix-available",
  "alert_number": 7,
  "package": "some-package",
  "ecosystem": "npm",
  "severity": "critical",
  "summary": "Remote code execution in some-package",
  "vulnerable_range": ">= 0.0.1",
  "alert_url": "https://github.com/org/repo/security/dependabot/7",
  "repository": "org/repo",
  "message": "No patched version is currently available for some-package. Manual review required."
}
```

### Verifying signatures

```javascript
const crypto = require('crypto');

function verifyWebhookSignature(secret, rawBody, signatureHeader) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)            // raw Buffer or string — do not parse JSON first
    .digest('hex');
  const actual = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expected);
  if (actual.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actual, expectedBuf);
}
```

---

## Supported ecosystems

| Ecosystem | Dev dependency detection | Installed version resolution |
|---|---|---|
| npm / yarn | `devDependencies` in `package.json` | `package-lock.json` → `package.json` range |
| pip | Manifest path heuristic (`dev`, `test`, `ci`, etc.) | `requirements*.txt` pinned version |
| RubyGems | Gemfile `:development` / `:test` group blocks | — |
| Maven | `<scope>test</scope>` near artifact ID | — |
| Gradle | `testImplementation` / `testCompileOnly` / `testRuntimeOnly` | — |
| All others | Dependabot `dependency.scope` field when present | — |

When the installed version cannot be resolved the action conservatively treats the bump as **major** and sends a webhook rather than silently enabling auto-merge.

---

## Security

- **Secrets are never logged.** `@actions/core` automatically masks any value retrieved via `getInput` that is marked as a secret.
- **Webhook payloads are HMAC-signed.** Always verify the `X-Hub-Signature-256` header on the receiving end before trusting the payload.
- **Principle of least privilege.** The token only needs the three permissions listed above. Do not use a token with broader scopes.
- **Pin versions in production.** Reference this action at a commit SHA (`@abc1234`) rather than a mutable tag in sensitive environments.
- **Dev dependencies are fully dismissed.** They will never trigger a PR action or a webhook — not just deprioritised.
- **Conservative version fallback.** If the installed version cannot be determined, the action assumes a major bump and escalates via webhook rather than silently auto-merging.
- **No dynamic code execution.** The scripts use only `@actions/core`, `@actions/github`, and Node.js built-ins. There is no `eval` or dynamic `require`.

---

## Using across private repositories

This action is designed as a central **reusable workflow** (`workflow_call`). Consuming repos need no code of their own beyond the single caller workflow file.

Requirements for each consuming repository:

1. The repository must be in the same GitHub organisation as `dependabot-manager`, or the organisation must grant cross-repo workflow access.
2. The `DEPENDABOT_MANAGER_TOKEN` secret (or equivalent org-level secret) must be available.
3. The caller workflow must be present at `.github/workflows/dependabot-manager.yml`.

To add a new repo, copy the caller workflow, set `YOUR_ORG`, and push. No other changes are needed.
