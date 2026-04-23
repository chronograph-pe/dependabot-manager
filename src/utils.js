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
// Webhook dispatch
// ---------------------------------------------------------------------------

/**
 * POSTs a JSON payload to a webhook URL.
 * If a secret is provided the body is HMAC-SHA256 signed and the signature
 * is sent in the X-Hub-Signature-256 header (same convention as GitHub webhooks).
 */
async function sendWebhook(url, secret, payload) {
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'dependabot-manager-action/1.0',
  };

  if (secret) {
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Hub-Signature-256'] = `sha256=${sig}`;
  }

  const response = await fetch(url, { method: 'POST', headers, body });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Webhook POST failed: ${response.status} ${response.statusText} – ${text}`);
  }
}

module.exports = {
  meetsMinSeverity,
  parseSemver,
  isMinorOrPatchBump,
  isDevDependency,
  getInstalledVersion,
  sendWebhook,
};
