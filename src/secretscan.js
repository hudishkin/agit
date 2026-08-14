import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 1024 * 1024;

const RULES = [
  { id: "private_key", label: "private key block", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { id: "aws_access_key", label: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "github_token", label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: "slack_token", label: "Slack token", re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
  { id: "stripe_key", label: "Stripe secret key", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}\b/ },
  { id: "google_api_key", label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "npm_token", label: "npm token", re: /\bnpm_[0-9A-Za-z]{36}\b/ },
];

export function scanText(text) {
  return RULES.filter((rule) => rule.re.test(text)).map((rule) => rule.label);
}

export function scanFilesForSecrets(cwd, files) {
  const hits = [];

  for (const file of files) {
    const path = join(cwd, file);
    let buffer;
    try {
      const stats = statSync(path);
      if (!stats.isFile() || stats.size > MAX_BYTES) {
        continue;
      }
      buffer = readFileSync(path);
    } catch {
      continue;
    }

    if (buffer.includes(0)) {
      continue;
    }

    const findings = scanText(buffer.toString("utf8"));
    if (findings.length > 0) {
      hits.push({ file, findings });
    }
  }

  return hits;
}
