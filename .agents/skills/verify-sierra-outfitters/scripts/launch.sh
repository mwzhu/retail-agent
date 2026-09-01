#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ $# -ne 2 ]]; then
  printf 'Usage: %s <run-id> <port>\n' "$0" >&2
  exit 2
fi

verification_run_id=$1
verification_port=$2

if [[ ! $verification_run_id =~ ^[A-Za-z0-9._-]+$ ]]; then
  printf 'Run ID may contain only letters, numbers, dot, underscore, and hyphen.\n' >&2
  exit 2
fi
if [[ ! $verification_port =~ ^[0-9]+$ ]] || (( verification_port < 1025 || verification_port > 65535 )); then
  printf 'Port must be an integer from 1025 through 65535.\n' >&2
  exit 2
fi

verification_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
verification_repo_root=$(CDPATH= cd -- "$verification_script_dir/../../../.." && pwd)
verification_run_dir="$verification_repo_root/.audit/verification/runs/$verification_run_id"
verification_evidence_dir="$verification_repo_root/.audit/verification/evidence/$verification_run_id"
verification_database_path="$verification_run_dir/sierra.db"

if [[ -e $verification_run_dir || -e $verification_evidence_dir ]]; then
  printf 'Run state or evidence already exists for %s. Choose a new run ID.\n' "$verification_run_id" >&2
  exit 1
fi
if lsof -nP -iTCP:"$verification_port" -sTCP:LISTEN >/dev/null 2>&1; then
  printf 'Port %s already has a listener. Choose another port.\n' "$verification_port" >&2
  exit 1
fi
if [[ ! -f $verification_repo_root/dist/index.html ]]; then
  printf 'dist/index.html is missing. Run npm run build first.\n' >&2
  exit 1
fi
if [[ ! -x $verification_repo_root/node_modules/.bin/tsx ]]; then
  printf 'node_modules/.bin/tsx is missing. Install dependencies first.\n' >&2
  exit 1
fi

mkdir -p "$verification_run_dir" "$verification_evidence_dir"
cleanup_partial_launch() {
  rm -rf -- "$verification_run_dir"
}
trap cleanup_partial_launch EXIT

verification_dist_digest=$(
  find "$verification_repo_root/dist" -type f -exec shasum -a 256 {} \; \
    | LC_ALL=C sort \
    | shasum -a 256 \
    | awk '{print $1}'
)
verification_git_revision=$(git -C "$verification_repo_root" rev-parse HEAD)
verification_pid=$$

printf '%s\n' "$verification_pid" >"$verification_run_dir/pid"
printf '%s\n' "$verification_port" >"$verification_run_dir/port"
printf '%s\n' "$verification_repo_root" >"$verification_run_dir/repo-root"
printf '%s\n' "$verification_database_path" >"$verification_run_dir/database-path"
printf '%s\n' "$verification_evidence_dir" >"$verification_run_dir/evidence-path"
printf '%s\n' "$verification_dist_digest" >"$verification_run_dir/dist-digest"
printf '%s\n' "$verification_git_revision" >"$verification_run_dir/git-revision"

printf 'Starting: http://127.0.0.1:%s/\n' "$verification_port"
printf 'Run ID: %s\n' "$verification_run_id"
printf 'PID: %s\n' "$verification_pid"
printf 'Database: %s\n' "$verification_database_path"
printf 'Evidence: %s\n' "$verification_evidence_dir"

cd "$verification_repo_root"
exec env \
  HOST=127.0.0.1 \
  PORT="$verification_port" \
  DATABASE_PATH="$verification_database_path" \
  node --import tsx src/server/index.ts \
  >>"$verification_evidence_dir/server.log" 2>&1
