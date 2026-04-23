'use strict';

/**
 * handle-alert.js
 *
 * Entry point for the "alert" mode of the action.
 * Triggered by: dependabot_alert (created | reintroduced)
 *
 * Decision tree:
 *   1. Severity below minimum threshold  → dismiss alert
 *   2. Development / test dependency     → dismiss alert
 *   3. No fixed version available        → webhook (manual review)
 *   4. Minor / patch bump                → log + let dependabot-automerge.yml handle the PR
 *   5. Major bump                        → webhook (manual investigation)
 */

const core = require('@actions/core');
const github = require('@actions/github');
const {
  meetsMinSeverity,
  isMinorOrPatchBump,
  isDevDependency,
  getInstalledVersion,
  sendSlackMessage,
} = require('./utils');

const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'];
const DISMISS_REASONS = {
  LOW_SEVERITY: 'tolerable_risk',
  DEV_DEPENDENCY: 'tolerable_risk',
};
// GitHub caps dismissed_comment at 280 characters.
const MAX_COMMENT_LEN = 280;

async function run() {
  // ── Inputs ────────────────────────────────────────────────────────────────
  const token = core.getInput('github-token', { required: true });
  const minSeverity = core.getInput('min-severity', { required: true }).toLowerCase().trim();
  const slackWebhookUrl = core.getInput('slack-webhook-url').trim();
  const enableAutoMerge = core.getInput('enable-auto-merge').trim().toLowerCase() !== 'false';

  if (!VALID_SEVERITIES.includes(minSeverity)) {
    core.setFailed(
      `Invalid min-severity "${minSeverity}". Allowed values: ${VALID_SEVERITIES.join(', ')}`,
    );
    return;
  }

  // ── Context ───────────────────────────────────────────────────────────────
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const alert = github.context.payload.alert;

  if (!alert) {
    core.setFailed('No alert object found in event payload. Ensure this action is triggered by dependabot_alert.');
    return;
  }

  const alertNumber = alert.number;
  const severity = alert.security_advisory?.severity?.toLowerCase() ?? 'unknown';
  const packageName = alert.dependency?.package?.name ?? 'unknown';
  const ecosystem = alert.dependency?.package?.ecosystem ?? 'unknown';
  const manifestPath = alert.dependency?.manifest_path;
  const fixedVersion = alert.security_vulnerability?.first_patched_version?.identifier;
  const vulnerableRange = alert.security_vulnerability?.vulnerable_version_range;
  const alertUrl = alert.html_url;
  const summary = alert.security_advisory?.summary ?? '';

  core.info(`[Alert #${alertNumber}] ${packageName} (${ecosystem}) | severity: ${severity} | fixed: ${fixedVersion ?? 'none'}`);

  // ── Step 1: Severity gate ─────────────────────────────────────────────────
  if (!meetsMinSeverity(severity, minSeverity)) {
    core.info(`Severity "${severity}" is below minimum "${minSeverity}". Dismissing.`);
    await dismissAlert(
      octokit, owner, repo, alertNumber,
      DISMISS_REASONS.LOW_SEVERITY,
      `Auto-dismissed: severity "${severity}" is below the configured minimum of "${minSeverity}".`,
    );
    core.setOutput('action-taken', 'dismissed-low-severity');
    return;
  }

  // ── Step 2: Dev dependency gate ───────────────────────────────────────────
  const isDev = await isDevDependency(alert, octokit, owner, repo);
  if (isDev) {
    core.info(`"${packageName}" is a development/test dependency. Dismissing.`);
    await dismissAlert(
      octokit, owner, repo, alertNumber,
      DISMISS_REASONS.DEV_DEPENDENCY,
      `Auto-dismissed: "${packageName}" is a development/test-only dependency and does not affect production.`,
    );
    core.setOutput('action-taken', 'dismissed-dev-dependency');
    return;
  }

  // ── Step 3: No fix available ──────────────────────────────────────────────
  if (!fixedVersion) {
    core.warning(`No patched version available for "${packageName}". Escalating for manual review.`);
    await maybeSlack(slackWebhookUrl, {
      event: 'no-fix-available',
      alert_number: alertNumber,
      package: packageName,
      ecosystem,
      severity,
      summary,
      vulnerable_range: vulnerableRange,
      alert_url: alertUrl,
      repository: `${owner}/${repo}`,
      message: `No patched version is currently available for ${packageName}. Manual review required.`,
    });
    core.setOutput('action-taken', 'webhook-no-fix');
    return;
  }

  // ── Step 4/5: Determine bump type ─────────────────────────────────────────
  const installedVersion = await getInstalledVersion(
    octokit, owner, repo, manifestPath, packageName, ecosystem,
  );

  let isMinor;
  if (installedVersion) {
    isMinor = isMinorOrPatchBump(installedVersion, fixedVersion);
    core.info(
      `Version bump: ${installedVersion} → ${fixedVersion} ` +
      `(${isMinor ? 'minor/patch' : 'MAJOR'})`,
    );
  } else {
    // Cannot determine installed version — default to treating as major (safe).
    core.warning(
      `Could not resolve installed version of "${packageName}" from manifest. ` +
      'Treating as a major bump to be safe.',
    );
    isMinor = false;
  }

  if (isMinor) {
    if (enableAutoMerge) {
      // The dependabot-automerge.yml reusable workflow will enable auto-merge
      // when Dependabot opens the corresponding PR.
      core.info(
        `"${packageName}" qualifies for auto-merge (minor/patch bump). ` +
        'Dependabot will open a PR; the automerge workflow will handle it.',
      );
      core.setOutput('action-taken', 'queued-for-auto-merge');
    } else {
      // Auto-merge is disabled — notify via webhook so the team still hears about it.
      core.info(
        `"${packageName}" is a minor/patch bump but enable-auto-merge is false. ` +
        'Sending webhook notification.',
      );
      await maybeSlack(slackWebhookUrl, {
        event: 'minor-bump-notify',
        alert_number: alertNumber,
        package: packageName,
        ecosystem,
        severity,
        summary,
        vulnerable_range: vulnerableRange,
        installed_version: installedVersion,
        fixed_version: fixedVersion,
        alert_url: alertUrl,
        repository: `${owner}/${repo}`,
        message:
          `"${packageName}" has a minor/patch fix available ` +
          `(${installedVersion ?? 'current'} → ${fixedVersion}). ` +
          'Auto-merge is disabled — please review and merge manually.',
      });
      core.setOutput('action-taken', 'webhook-minor-bump');
    }
  } else {
    // Major bump — human needs to evaluate breaking changes.
    core.info(`Major bump required for "${packageName}". Sending webhook for manual investigation.`);
    await maybeSlack(slackWebhookUrl, {
      event: 'major-bump-required',
      alert_number: alertNumber,
      package: packageName,
      ecosystem,
      severity,
      summary,
      vulnerable_range: vulnerableRange,
      installed_version: installedVersion,
      fixed_version: fixedVersion,
      alert_url: alertUrl,
      repository: `${owner}/${repo}`,
      message:
        `"${packageName}" requires a MAJOR version bump ` +
        `(${installedVersion ?? 'current'} → ${fixedVersion}). Manual investigation required.`,
    });
    core.setOutput('action-taken', 'webhook-major-bump');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function dismissAlert(octokit, owner, repo, alertNumber, reason, comment) {
  await octokit.rest.dependabot.updateAlert({
    owner,
    repo,
    alert_number: alertNumber,
    state: 'dismissed',
    dismissed_reason: reason,
    dismissed_comment: comment.slice(0, MAX_COMMENT_LEN),
  });
  core.info(`Alert #${alertNumber} dismissed (reason: ${reason}).`);
}

async function maybeSlack(url, payload) {
  if (!url) {
    core.warning('No slack-webhook-url configured — skipping Slack notification.');
    return;
  }
  try {
    await sendSlackMessage(url, payload);
    core.info(`Slack message sent for event "${payload.event}".`);
  } catch (err) {
    // Slack failure is non-fatal: log and continue so the action doesn't
    // block the pipeline due to a notification issue.
    core.error(`Slack notification failed: ${err.message}`);
  }
}

run().catch((err) => core.setFailed(err.message));
