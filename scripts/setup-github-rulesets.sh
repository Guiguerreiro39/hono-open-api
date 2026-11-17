#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    *)
      ;;
  esac
done

RULESET_FILE="docs/github-ruleset.json"
if [ ! -f "$RULESET_FILE" ]; then
  echo "❌ Error: Ruleset file '$RULESET_FILE' not found." >&2
  exit 1
fi

# Validate JSON syntax
if ! node -e "JSON.parse(require('fs').readFileSync('$RULESET_FILE', 'utf8'))" >/dev/null 2>&1; then
  echo "❌ Error: Ruleset file '$RULESET_FILE' contains invalid JSON." >&2
  exit 1
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "🔍 [Dry Run] Validated 'docs/github-ruleset.json' successfully."
  echo "🔍 [Dry Run] Ruleset Payload:"
  cat "$RULESET_FILE"
  echo ""
  echo "✅ [Dry Run] Verification complete. Run without --dry-run to apply to GitHub."
  exit 0
fi

# Real execution requires authenticated gh CLI
if ! gh auth status >/dev/null 2>&1; then
  echo "❌ Error: GitHub CLI ('gh') is not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

REPO_NAME=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || gh repo view --json nameWithOwner --jq .nameWithOwner)
echo "🛡️  Applying Production Ruleset to: $REPO_NAME..."

RULESET_NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$RULESET_FILE', 'utf8')).name)")
EXISTING_ID=$(gh api -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "/repos/$REPO_NAME/rulesets" --jq ".[] | select(.name == \"$RULESET_NAME\") | .id" 2>/dev/null || echo "")

if [ -n "$EXISTING_ID" ]; then
  echo "🔄 Existing ruleset found with ID: $EXISTING_ID. Updating..."
  gh api \
    --method PUT \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "/repos/$REPO_NAME/rulesets/$EXISTING_ID" \
    --input "$RULESET_FILE"
else
  echo "➕ Creating new ruleset..."
  gh api \
    --method POST \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "/repos/$REPO_NAME/rulesets" \
    --input "$RULESET_FILE"
fi

echo "✅ Ruleset successfully applied! Direct pushes to the default branch are now restricted."
