#!/usr/bin/env bash
set -euo pipefail
repo=${1:-}
if [[ ! "$repo" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]]; then
  echo 'Usage: bash scripts/publish-github.sh OWNER/REPO' >&2
  exit 2
fi
command -v gh >/dev/null || { echo 'Install GitHub CLI and run gh auth login on your own machine.' >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo 'GitHub CLI is not authenticated.' >&2; exit 1; }
[[ -f package.json && -f hooks.mjs && -f LICENSE ]] || { echo 'Run from the project root.' >&2; exit 1; }
git rev-parse --show-toplevel >/dev/null 2>&1 || { echo 'Initialize and review the Git repository first.' >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo 'Review and commit local changes before publishing.' >&2; exit 1; }
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
const names = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0');
if (names.some(name => /(^|\/)(\.env($|\.)|options\.local\.json|\.state\/|node_modules\/)/.test(name))) {
  console.error('Refusing to publish local configuration or state.');
  process.exit(1);
}
JS
if git remote get-url origin >/dev/null 2>&1; then
  echo 'An origin already exists. Push it explicitly after checking its owner.' >&2
  exit 1
fi
npm run check
npm test
gh repo create "$repo" --public --description 'OpenViking memory recall and opt-in capture through Magpie async gateway hooks' --source . --remote origin --push
gh api --method PUT "repos/$repo/topics" --input - <<'JSON'
{"names":["magpie-plugin","openviking","memory","llm-gateway"]}
JSON
echo "Published https://github.com/$repo with the magpie-plugin repository topic."
