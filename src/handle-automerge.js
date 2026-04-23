'use strict';

/**
 * handle-automerge.js
 *
 * Entry point for the "automerge" mode of the action.
 * Triggered by: pull_request (opened | synchronize) from dependabot[bot]
 *
 * Decision tree:
 *   1. Not a Dependabot PR               → skip
 *   2. Cannot parse version bump          → skip (safe default)
 *   3. Major bump                         → skip (alert handler already webhooks this)
 *   4. Minor/patch + above min severity + not dev dep → approve + enable auto-merge
 */

const core = require('@actions/core');
const github = require('@actions/github');
const { meetsMinSeverity, isMinorOrPatchBump, isDevDependency } = require('./utils');

const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'];
const VALID_MERGE_METHODS = ['merge', 'squash', 'rebase'];

// Dependabot PR titles:
//   "Bump lodash from 4.17.20 to 4.17.21"
//   "chore(deps): bump lodash from 4.17.20 to 4.17.21"
//   "chore(deps-dev): bump eslint from 8.0.0 to 8.57.0"
const BUMP_TITLE_RE = /bump\s+(.+?)\s+from\s+([\d][\w.\-+]*)\s+to\s+([\d][\w.\-+]*)/i;

async function run() {
  // ── Inputs ────────────────────────────────────────────────────────────────
  const token = core.getInput('github-token', { required: true });
  const minSeverity = core.getInput('min-severity', { required: true }).toLowerCase().trim();
  const rawMergeMethod = core.getInput('merge-method').toLowerCase().trim() || 'squash';
  const enableAutoMerge = core.getInput('enable-auto-merge').trim().toLowerCase() !== 'false';

  if (!VALID_SEVERITIES.includes(minSeverity)) {
    core.setFailed(`Invalid min-severity "${minSeverity}". Allowed: ${VALID_SEVERITIES.join(', ')}`);
    return;
  }
  if (!VALID_MERGE_METHODS.includes(rawMergeMethod)) {
    core.setFailed(`Invalid merge-method "${rawMergeMethod}". Allowed: ${VALID_MERGE_METHODS.join(', ')}`);
    return;
  }

  // Short-circuit: if auto-merge is disabled at the caller level, do nothing.
  // The alert handler will have already sent a webhook notification.
  if (!enableAutoMerge) {
    core.info('enable-auto-merge is false — skipping PR auto-merge.');
    core.setOutput('action-taken', 'skipped-auto-merge-disabled');
    return;
  }

  // ── Context ───────────────────────────────────────────────────────────────
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const pr = github.context.payload.pull_request;

  if (!pr) {
    core.setFailed('No pull_request object in event payload.');
    return;
  }

  // ── Step 1: Confirm Dependabot actor ──────────────────────────────────────
  const actor = github.context.payload.sender?.login;
  if (actor !== 'dependabot[bot]') {
    core.info(`PR #${pr.number} was opened by "${actor}", not dependabot[bot]. Skipping.`);
    core.setOutput('action-taken', 'skipped-not-dependabot');
    return;
  }

  core.info(`Processing Dependabot PR #${pr.number}: "${pr.title}"`);

  // ── Step 2: Parse version bump from PR title ──────────────────────────────
  const bumpMatch = BUMP_TITLE_RE.exec(pr.title);
  if (!bumpMatch) {
    core.info(`Cannot parse version info from PR title. Skipping auto-merge.`);
    core.setOutput('action-taken', 'skipped-unparseable-title');
    return;
  }

  const [, packageName, fromVersion, toVersion] = bumpMatch;
  core.info(`Package: ${packageName} | ${fromVersion} → ${toVersion}`);

  // ── Step 3: Bump type gate ────────────────────────────────────────────────
  if (!isMinorOrPatchBump(fromVersion, toVersion)) {
    core.info(`Major version bump detected (${fromVersion} → ${toVersion}). Skipping auto-merge.`);
    core.setOutput('action-taken', 'skipped-major-bump');
    return;
  }

  // ── Step 4: Validate via open Dependabot alerts ───────────────────────────
  // Look up the related alert to verify severity and dep scope, since the
  // alert handler may not have run yet (e.g., on PR synchronize events).
  let alertSeverity = null;
  let alertIsDev = false;

  try {
    const { data: alerts } = await octokit.rest.dependabot.listAlertsForRepo({
      owner,
      repo,
      state: 'open',
      per_page: 100,
    });

    // Match by package name (case-insensitive).
    const related = alerts.find(
      (a) => a.dependency?.package?.name?.toLowerCase() === packageName.toLowerCase(),
    );

    if (related) {
      alertSeverity = related.security_advisory?.severity?.toLowerCase();
      alertIsDev = await isDevDependency(related, octokit, owner, repo).catch(() => false);
      core.info(`Related alert: severity=${alertSeverity}, dev=${alertIsDev}`);
    } else {
      core.info(`No open alert found for "${packageName}". Proceeding without alert context.`);
    }
  } catch (err) {
    core.warning(`Could not fetch Dependabot alerts: ${err.message}`);
  }

  if (alertSeverity && !meetsMinSeverity(alertSeverity, minSeverity)) {
    core.info(`Alert severity "${alertSeverity}" is below minimum "${minSeverity}". Skipping auto-merge.`);
    core.setOutput('action-taken', 'skipped-low-severity');
    return;
  }

  if (alertIsDev) {
    core.info(`"${packageName}" is a dev dependency. Skipping auto-merge.`);
    core.setOutput('action-taken', 'skipped-dev-dependency');
    return;
  }

  // ── Step 5: Approve + enable auto-merge ───────────────────────────────────
  core.info(`PR #${pr.number} qualifies for auto-merge. Enabling (method: ${rawMergeMethod}).`);

  // Approve the PR first (required for repos that enforce review approvals).
  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pr.number,
      event: 'APPROVE',
      body:
        `Auto-approved by dependabot-manager: ` +
        `${packageName} ${fromVersion} → ${toVersion} (minor/patch bump).`,
    });
    core.info(`PR #${pr.number} approved.`);
  } catch (err) {
    // Approval may fail if the token belongs to the same account that opened
    // the PR (GitHub prevents self-approval). Log and continue — auto-merge
    // can still work if branch protections allow it.
    core.warning(`Could not approve PR #${pr.number}: ${err.message}`);
  }

  // Enable auto-merge via GraphQL (REST does not support this endpoint).
  await enableAutoMerge(octokit, pr.node_id, rawMergeMethod);
  core.info(`Auto-merge enabled on PR #${pr.number}.`);
  core.setOutput('action-taken', 'auto-merge-enabled');
}

// ---------------------------------------------------------------------------
// GraphQL auto-merge mutation
// ---------------------------------------------------------------------------

const ENABLE_AUTO_MERGE_MUTATION = /* GraphQL */ `
  mutation EnableAutoMerge($prId: ID!, $method: PullRequestMergeMethod!) {
    enablePullRequestAutoMerge(input: { pullRequestId: $prId, mergeMethod: $method }) {
      pullRequest {
        autoMergeRequest {
          enabledAt
          mergeMethod
        }
      }
    }
  }
`;

const MERGE_METHOD_MAP = {
  merge: 'MERGE',
  squash: 'SQUASH',
  rebase: 'REBASE',
};

async function enableAutoMerge(octokit, prNodeId, mergeMethod) {
  await octokit.graphql(ENABLE_AUTO_MERGE_MUTATION, {
    prId: prNodeId,
    method: MERGE_METHOD_MAP[mergeMethod] ?? 'SQUASH',
  });
}

run().catch((err) => core.setFailed(err.message));
