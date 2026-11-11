#!/usr/bin/env bash
# Browser end-to-end checks. Each script gets a fresh server and database and drives a real browser over the
# DevTools protocol (no extra npm packages). Needs any Chromium-based browser.
#
#   BROWSER="chromium" ./e2e/run.sh                      # run everything
#   BROWSER="flatpak run com.brave.Browser" ./e2e/run.sh 04-versions   # run scripts whose name contains this
#
# Screenshots go to e2e/out/.
set -u
cd "$(dirname "$0")/.."
BROWSER=${BROWSER:-chromium}
PORT_APP=4791; PORT_CDP=9333
WORK=$(mktemp -d); OUT=e2e/out; mkdir -p "$OUT"
cleanup() { fuser -k $PORT_APP/tcp $PORT_CDP/tcp >/dev/null 2>&1; sleep 1; rm -rf "$WORK" 2>/dev/null; }
trap cleanup EXIT

$BROWSER --headless=new --disable-gpu --no-first-run --remote-debugging-port=$PORT_CDP --user-data-dir="$WORK/profile" \
  --window-size=1300,1000 about:blank >"$WORK/browser.log" 2>&1 &
for _ in $(seq 1 40); do curl -s "http://127.0.0.1:$PORT_CDP/json/version" >/dev/null && break; sleep 0.5; done

failed=0
for script in e2e/[0-9]*.mjs; do
  case "${1:-}" in "") ;; *) [[ "$script" == *"$1"* ]] || continue ;; esac
  fuser -k $PORT_APP/tcp 2>/dev/null; sleep 0.3; rm -rf "$WORK/data"
  DATA_DIR="$WORK/data" PORT=$PORT_APP node --disable-warning=ExperimentalWarning server.js >"$WORK/server.log" 2>&1 &
  disown
  for _ in $(seq 1 30); do curl -s "http://127.0.0.1:$PORT_APP/api/auth/me" >/dev/null && break; sleep 0.3; done
  echo "== $script"
  out=$(node "$script" "$OUT" 2>&1); code=$?
  printf '%s\n' "$out" | grep -E '^FAIL' || true
  echo "   $(printf '%s\n' "$out" | grep -c '^PASS') passed, $(printf '%s\n' "$out" | grep -c -E '^FAIL|Error:') failed"
  # Newer scripts exit non-zero on failure; the older ones only print FAIL lines. A crash prints no summary at all.
  if [ $code -ne 0 ] || printf '%s\n' "$out" | grep -q -E '^FAIL|Error:'; then failed=$((failed + 1)); fi
done
echo; [ $failed -eq 0 ] && echo "all browser scripts passed" || echo "$failed script(s) failed"
exit $failed
