'use strict';

const SEVERITY_LEVELS = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Returns true if alertSeverity meets or exceeds minSeverity.
 */
function meetsMinSeverity(alertSeverity, minSeverity) {
  const alertLevel = SEVERITY_LEVELS[alertSeverity?.toLowerCase()];
  const minLevel = SEVERITY_LEVELS[minSeverity?.toLowerCase()];
  if (alertLevel === undefined) throw new Error(`Unknown alert severity: "${alertSeverity}"`);
  if (minLevel === undefined) throw new Error(`Unknown min-severity input: "${minSeverity}"`);
  return alertLevel >= minLevel;
}

/**
 * Parses a version string into { major, minor, patch }.
 * Strips leading non-numeric characters (e.g. "^", "~", "v").
 */
function parseSemver(version) {
  if (!version) return null;
  const cleaned = String(version).replace(/^[^0-9]*/, '').split(/[-+]/)[0];
  const parts = cleaned.split('.').map((p) => parseInt(p, 10) || 0);
  return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0 };
}

/**
 * Returns true if the bump from currentVersion to fixedVersion does NOT
 * cross a major version boundary (i.e. it is a minor or patch bump).
 */
function isMinorOrPatchBump(currentVersion, fixedVersion) {
  const current = parseSemver(currentVersion);
  const fixed = parseSemver(fixedVersion);
  if (!current || !fixed) return false;
  return fixed.major === current.major;
}

// ---------------------------------------------------------------------------
// Dev-dependency detection
// ---------------------------------------------------------------------------

/**
 * Determines whether the alerted dependency is a development/test-only dep.
 * Strategy:
 *   1. Trust alert.dependency.scope when present ('runtime' | 'development').
 *   2. Fall back to fetching + parsing the manifest file.
 */
async function isDevDependency(alert, octokit, owner, repo) {
  const scope = alert.dependency?.scope;
  if (scope === 'development') return true;
  if (scope === 'runtime') return false;

  const ecosystem = alert.dependency?.package?.ecosystem;
  const packageName = alert.dependency?.package?.name;
  const manifestPath = alert.dependency?.manifest_path;

  if (!manifestPath || !packageName) return false;

  try {
    if (ecosystem === 'npm') {
      return await isNpmDevDep(octokit, owner, repo, manifestPath, packageName);
    }
    if (ecosystem === 'pip') {
      return isPipDevManifest(manifestPath);
    }
    if (ecosystem === 'rubygems') {
      return await isGemfileDevDep(octokit, owner, repo, manifestPath, packageName);
    }
    if (ecosystem === 'maven' || ecosystem === 'gradle') {
      return await isJvmDevDep(octokit, owner, repo, manifestPath, packageName);
    }
  } catch {
    // Conservative fallback: treat as runtime so we don't miss real issues.
    return false;
  }

  return false;
}

async function fetchFileContent(octokit, owner, repo, path) {
  const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
  return Buffer.from(data.content, 'base64').toString('utf8');
}

async function isNpmDevDep(octokit, owner, repo, manifestPath, packageName) {
  const content = await fetchFileContent(octokit, owner, repo, manifestPath);
  const pkg = JSON.parse(content);
  return packageName in (pkg.devDependencies ?? {});
}

function isPipDevManifest(manifestPath) {
  return /dev|test|lint|ci|build/i.test(manifestPath);
}

async function isGemfileDevDep(octokit, owner, repo, manifestPath, gemName) {
  const content = await fetchFileContent(octokit, owner, repo, manifestPath);
  // Match gem inside a :development or :test group block
  const groupBlock = /group\s+[^d\n]*:(?:development|test)[^{]*\{([^}]*)\}/gis;
  let match;
  while ((match = groupBlock.exec(content)) !== null) {
    if (match[1].includes(`'${gemName}'`) || match[1].includes(`"${gemName}"`)) return true;
  }
  return false;
}

async function isJvmDevDep(octokit, owner, repo, manifestPath, packageName) {
  const content = await fetchFileContent(octokit, owner, repo, manifestPath);
  // Maven: <scope>test</scope> near the artifact id
  // Gradle: testImplementation / testCompileOnly
  const testPatterns = [
    /<scope>test<\/scope>/i,
    /testImplementation|testCompileOnly|testRuntimeOnly/i,
  ];
  const nameIndex = content.indexOf(packageName.split(':').pop() ?? packageName);
  if (nameIndex === -1) return false;
  const surrounding = content.slice(Math.max(0, nameIndex - 200), nameIndex + 200);
  return testPatterns.some((re) => re.test(surrounding));
}

// ---------------------------------------------------------------------------
// Installed-version resolution
// ---------------------------------------------------------------------------

/**
 * Tries to determine the exact installed version of a package from the repo's
 * lockfile / manifest. Returns null if it cannot be determined.
 */
async function getInstalledVersion(octokit, owner, repo, manifestPath, packageName, ecosystem) {
  if (!manifestPath || !packageName) return null;
  try {
    if (ecosystem === 'npm') return await getNpmInstalledVersion(octokit, owner, repo, manifestPath, packageName);
    if (ecosystem === 'pip') return await getPipInstalledVersion(octokit, owner, repo, manifestPath, packageName);
  } catch {
    return null;
  }
  return null;
}

async function getNpmInstalledVersion(octokit, owner, repo, manifestPath, packageName) {
  // 1. Try package-lock.json (exact resolved version)
  const lockPath = manifestPath.replace(/package\.json$/, 'package-lock.json');
  try {
    const content = await fetchFileContent(octokit, owner, repo, lockPath);
    const lock = JSON.parse(content);
    // lockfile v2/v3
    if (lock.packages) {
      const entry = lock.packages[`node_modules/${packageName}`];
      if (entry?.version) return entry.version;
    }
    // lockfile v1
    if (lock.dependencies?.[packageName]?.version) {
      return lock.dependencies[packageName].version;
    }
  } catch {
    // lockfile not found or unreadable
  }

  // 2. Fall back to package.json declared range
  const content = await fetchFileContent(octokit, owner, repo, manifestPath);
  const pkg = JSON.parse(content);
  const allDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
  return allDeps[packageName] ?? null;
}

async function getPipInstalledVersion(octokit, owner, repo, manifestPath, packageName) {
  const content = await fetchFileContent(octokit, owner, repo, manifestPath);
  // Match: package==1.2.3 or package>=1.2.3
  const re = new RegExp(`^${escapeRegex(packageName)}[=><!\\s]+([\d.]+)`, 'im');
  const match = re.exec(content);
  return match ? match[1] : null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Slack notification
// ---------------------------------------------------------------------------

const SEVERITY_EMOJI = {
  critical: ':rotating_light:',
  high: ':warning:',
  medium: ':large_yellow_circle:',
  low: ':information_source:',
};

const EVENT_HEADER = {
  'minor-bump-notify':   ':bell: Dependency update available',
  'major-bump-required': ':rotating_light: Major bump required \u2014 manual review',
  'no-fix-available':    ':sos: No fix available \u2014 monitor required',
};

const EVENT_CONTEXT = {
  'minor-bump-notify':   'Review the Dependabot PR and merge when ready.',
  'major-bump-required': 'Breaking changes likely. Manual investigation required before upgrading.',
  'no-fix-available':    'No patch exists yet. Monitor the advisory for updates.',
};

/**
 * Builds a Slack Block Kit payload for a Dependabot alert event.
 */
function buildSlackBlocks(payload) {
  const {
    event,
    package: pkg,
    ecosystem,
    severity,
    summary,
    installed_version: installedVersion,
    fixed_version: fixedVersion,
    vulnerable_range: vulnerableRange,
    alert_number: alertNumber,
    alert_url: alertUrl,
    repository,
  } = payload;

  const severityEmoji = SEVERITY_EMOJI[severity] || ':warning:';
  const header = EVENT_HEADER[event] || ':bell: Dependabot alert';
  const contextMsg = EVENT_CONTEXT[event];

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: header, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Package*\n\`${pkg}\` (${ecosystem})` },
        { type: 'mrkdwn', text: `*Severity*\n${severityEmoji} ${severity}` },
        { type: 'mrkdwn', text: `*Repository*\n\`${repository}\`` },
        { type: 'mrkdwn', text: `*Alert*\n<${alertUrl}|#${alertNumber}>` },
      ],
    },
  ];

  // Version bump details
  if (installedVersion && fixedVersion) {
    const bumpLabel = event === 'major-bump-required' ? '*MAJOR*' : 'minor/patch';
    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Current version*\n\`${installedVersion}\`` },
        { type: 'mrkdwn', text: `*Fixed version*\n\`${fixedVersion}\` (${bumpLabel})` },
      ],
    });
  }

  // Vulnerable range (shown when no installed version is resolved)
  if (vulnerableRange && !installedVersion) {
    blocks.push({
      type: 'section',
      fields: [{ type: 'mrkdwn', text: `*Vulnerable range*\n\`${vulnerableRange}\`` }],
    });
  }

  // Advisory summary
  if (summary) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Advisory*\n${summary}` },
    });
  }

  blocks.push({ type: 'divider' });

  if (contextMsg) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: contextMsg }],
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'View Alert', emoji: true },
        url: alertUrl,
        style: event === 'minor-bump-notify' ? 'primary' : 'danger',
      },
    ],
  });

  return blocks;
}

/**
 * POSTs a Slack Block Kit message to an incoming webhook URL.
 */
async function sendSlackMessage(url, payload) {
  const body = JSON.stringify({ blocks: buildSlackBlocks(payload) });
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Slack webhook failed: ${response.status} ${response.statusText} – ${text}`);
  }
}

module.exports = {
  meetsMinSeverity,
  parseSemver,
  isMinorOrPatchBump,
  isDevDependency,
  getInstalledVersion,
  sendSlackMessage,
};
