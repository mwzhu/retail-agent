#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s <run-id>\n' "$0" >&2
  exit 2
fi

verification_run_id=$1
if [[ ! $verification_run_id =~ ^[A-Za-z0-9._-]+$ ]]; then
  printf 'Invalid run ID.\n' >&2
  exit 2
fi

verification_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
verification_repo_root=$(CDPATH= cd -- "$verification_script_dir/../../../.." && pwd)
verification_run_dir="$verification_repo_root/.audit/verification/runs/$verification_run_id"

for verification_state_name in pid port repo-root database-path evidence-path dist-digest git-revision; do
  if [[ ! -f $verification_run_dir/$verification_state_name ]]; then
    printf 'Missing run state: %s\n' "$verification_run_dir/$verification_state_name" >&2
    exit 1
  fi
done

verification_pid=$(<"$verification_run_dir/pid")
verification_port=$(<"$verification_run_dir/port")
verification_recorded_root=$(<"$verification_run_dir/repo-root")
verification_database_path=$(<"$verification_run_dir/database-path")
verification_evidence_path=$(<"$verification_run_dir/evidence-path")
verification_expected_digest=$(<"$verification_run_dir/dist-digest")
verification_git_revision=$(<"$verification_run_dir/git-revision")

if [[ $verification_recorded_root != "$verification_repo_root" ]]; then
  printf 'Recorded repository root does not match this checkout.\n' >&2
  exit 1
fi
case $verification_database_path in
  "$verification_run_dir"/*) ;;
  *) printf 'Database path is outside the run directory.\n' >&2; exit 1 ;;
esac
case $verification_evidence_path in
  "$verification_repo_root/.audit/verification/evidence/$verification_run_id") ;;
  *) printf 'Evidence path is outside the expected directory.\n' >&2; exit 1 ;;
esac
if [[ ! $verification_pid =~ ^[0-9]+$ ]] || ! kill -0 "$verification_pid" 2>/dev/null; then
  printf 'Recorded process %s is not alive.\n' "$verification_pid" >&2
  exit 1
fi

verification_command=$(ps -p "$verification_pid" -o command=)
verification_cwd=$(lsof -a -p "$verification_pid" -d cwd -Fn | sed -n 's/^n//p')
if [[ $verification_cwd != "$verification_repo_root" ]]; then
  printf 'Recorded process has the wrong working directory: %s\n' "$verification_cwd" >&2
  exit 1
fi
if [[ $verification_command != *"src/server/index.ts"* ]]; then
  printf 'Recorded process is not the Sierra server: %s\n' "$verification_command" >&2
  exit 1
fi
if ! lsof -nP -a -p "$verification_pid" -iTCP:"$verification_port" -sTCP:LISTEN >/dev/null 2>&1; then
  printf 'Recorded process does not own port %s.\n' "$verification_port" >&2
  exit 1
fi

verification_health=$(curl --silent --show-error --max-time 3 "http://127.0.0.1:$verification_port/api/health")
if ! node -e '
  const health = JSON.parse(process.argv[1]);
  if (health?.ok !== true || health?.mode !== "openai") process.exit(1);
' "$verification_health" 2>/dev/null; then
  printf 'Verification requires an OpenAI-backed server.\n' >&2
  exit 1
fi

verification_current_digest=$(
  find "$verification_repo_root/dist" -type f -exec shasum -a 256 {} \; \
    | LC_ALL=C sort \
    | shasum -a 256 \
    | awk '{print $1}'
)
if [[ $verification_current_digest != "$verification_expected_digest" ]]; then
  printf 'dist changed after this instance launched. Rebuild and start a new run.\n' >&2
  exit 1
fi

printf 'Sierra Outfitters verification instance is healthy.\n'
printf 'URL: http://127.0.0.1:%s/\n' "$verification_port"
printf 'PID: %s\n' "$verification_pid"
printf 'Mode: openai\n'
printf 'Git revision: %s\n' "$verification_git_revision"
printf 'Database: %s\n' "$verification_database_path"
printf 'Evidence: %s\n' "$verification_evidence_path"
