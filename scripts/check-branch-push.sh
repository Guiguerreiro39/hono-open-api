#!/usr/bin/env bash
set -euo pipefail

# Allow repository author/admin emergency bypass
if [ "${ALLOW_DIRECT_MAIN_PUSH:-0}" = "1" ]; then
  exit 0
fi

is_protected_branch() {
  local ref="$1"
  case "$ref" in
    "main"|"master"|"refs/heads/main"|"refs/heads/master")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

block_push() {
  local target="$1"
  echo "" >&2
  echo "❌ [Git Push Guard] Direct pushes to '$target' are prohibited!" >&2
  echo "💡 Please create a feature branch and submit a Pull Request:" >&2
  echo "   git checkout -b feat/your-feature-name" >&2
  echo "   git push -u origin feat/your-feature-name" >&2
  echo "" >&2
  echo "⚠️ (To bypass this check in an authorized emergency, run: ALLOW_DIRECT_MAIN_PUSH=1 git push)" >&2
  echo "" >&2
  exit 1
}

# 1. Check if invoked by git pre-push hook with stdin stream
# Standard pre-push sends lines: <local ref> <local sha1> <remote ref> <remote sha1>
if [ ! -t 0 ]; then
  while read -r local_ref _local_oid remote_ref _remote_oid; do
    if [ -n "$remote_ref" ] && is_protected_branch "$remote_ref"; then
      block_push "$remote_ref"
    fi
    if [ -n "$local_ref" ] && is_protected_branch "$local_ref"; then
      block_push "$local_ref"
    fi
  done
fi

# 2. Check current branch name (via GIT_BRANCH environment variable or git symbolic-ref)
current_branch="${GIT_BRANCH:-$(git symbolic-ref --short HEAD 2>/dev/null || echo "")}"
if is_protected_branch "$current_branch"; then
  block_push "$current_branch"
fi

exit 0
