#!/usr/bin/env bash
# Disposable installed-app acceptance. Called after an API 26/28/29/35 AVD boots.
set -euo pipefail
root=$(pwd)
api=$(adb shell getprop ro.build.version.sdk | tr -d '\r')
case "$api" in 26|28|29|35) ;; *) echo "Unsupported emulator API $api" >&2; exit 1;; esac
run_temp=${RUNNER_TEMP:-/tmp}
artifact="$run_temp/rfc-0033-d4d-device-api${api}"
mkdir -p "$artifact"
touch "$artifact/assertions.txt"
record() { printf '%s=%s\n' "$1" "$2" >> "$artifact/assertions.txt"; }
redact() {
  sed -E -e 's/\r$//' \
    -e 's/fixture-caption-[A-Za-z0-9_-]+/<caption>/g' \
    -e 's/fixture-legacy-[A-Za-z0-9_-]+/<caption>/g' \
    -e 's/Fixture caption/<caption>/g' \
    -e 's/rfc0033-doc-[A-Za-z0-9._-]+/<file>/g' \
    -e 's/notes-café\.txt/<file>/g' \
    -e 's@"(data|bytes)"[[:space:]]*:[[:space:]]*"[A-Za-z0-9+/=]+"@"\1":"<bytes>"@g' \
    -e 's/Line with café/<fixture-content>/g' \
    -e 's/picker round trip/<fixture-content>/g' \
    -e 's/retry café/<fixture-content>/g' \
    -e 's/withdraw/<fixture-content>/g' \
    -e 's/not a PDF/<fixture-content>/g' \
    -e 's@<p>markup</p>@<fixture-content>@g' \
    -e 's/%PDF-[^[:space:]]*/<fixture-content>/g' \
    -e 's@content://[^[:space:]]+@<content-uri>@g' \
    -e 's@(/storage/emulated/[0-9]+/)?Download(s)?/[^[:space:]]+@<downloads-file>@g' \
    -e 's/[A-Za-z0-9+\/=]{200,}/<bytes>/g'
}
harness_pid=
failed=0
reported=false
capture_failure() {
  local stage=$1 status=$2
  printf 'FAILED: %s (exit %s)\n' "$stage" "$status" >&2
  timeout 20 adb exec-out uiautomator dump /dev/tty 2>/dev/null | redact > "$artifact/$stage-failure-ui.txt" || :
  timeout 20 adb logcat -d -t 1000 2>/dev/null | redact > "$artifact/$stage-failure-logcat.txt" || :
}
cleanup() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$reported" = false ]; then
    record result FAIL
    capture_failure runner "$status"
  fi
  if [ -n "$harness_pid" ]; then
    kill "$harness_pid" 2>/dev/null || :
    wait "$harness_pid" 2>/dev/null || :
  fi
}
trap cleanup EXIT
test "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1
record api "$api"

run_stage() {
  local stage=$1 status=0
  shift
  "$@" || status=$?
  if [ "$status" -ne 0 ]; then
    failed=1
    record "$stage" FAIL
    capture_failure "$stage" "$status"
    return 1
  fi
  record "$stage" PASS
}

skip_stages() {
  local reason=$1 stage
  shift
  for stage; do
    record "$stage" "SKIP ($reason)"
  done
}

prepare_old_bridge() {
  local old_bridge="$run_temp/rfc-0033-old-bridge"
  mkdir -p "$old_bridge" || return
  git archive '176707ac2^' herdr/mods/pocket-link/bridge | tar -x -C "$old_bridge" || return
  export OLD_BRIDGE_DIR="$old_bridge/herdr/mods/pocket-link/bridge"
  test -s "$OLD_BRIDGE_DIR/chat.mjs"
}

start_harness() {
  test -f .automagik/attach-harness.mjs || return
  NODE_OPTIONS='--import=./apps/bots-dsh/test/harness-resolve.mjs' \
    node .automagik/attach-harness.mjs > "$artifact/harness-stdout.txt" 2> "$artifact/harness-stderr.txt" &
  harness_pid=$!
  local attempt
  for attempt in {1..60}; do
    kill -0 "$harness_pid" 2>/dev/null || return
    if grep -qx READY "$artifact/harness-stdout.txt"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

build_apks() (
  local tree=$1 label=$2
  cd "$tree" || return
  ./gradlew --init-script "$root/.automagik/verify-0033-d4d.init.gradle" --no-daemon --max-workers=2 --stacktrace \
    :app:assembleGithubDebug :app:assembleGithubDebugAndroidTest 2>&1 | redact | tee "$artifact/build-$label.txt"
)

install_apks() {
  local tree=$1 label=$2
  local app_apk="$tree/app/build/outputs/apk/github/debug/app-github-debug.apk"
  local test_apk="$tree/app/build/outputs/apk/androidTest/github/debug/app-github-debug-androidTest.apk"
  test -s "$app_apk" && test -s "$test_apk" || return
  adb install -r "$app_apk" > "$artifact/install-$label-app.txt" || return
  adb install -r "$test_apk" > "$artifact/install-$label-test.txt"
}

build_legacy() {
  local test_dir="$legacy/apps/pocket/android/app/src/androidTest/java/ai/namastex/automagik"
  mkdir -p "$legacy" || return
  # The candidate commit is the newest one titled RFC 0033 D3; its parent is the pre-D3 tree (survives rebases).
  local d3
  d3=$(git log --format=%H -1 --grep='(RFC 0033 D3)$') || return
  [ -n "$d3" ] || return
  git archive "$d3^" | tar -x -C "$legacy" || return
  mkdir -p "$test_dir" || return
  cp .automagik/LegacyPhoneDeviceTest.kt "$test_dir/" || return
  build_apks "$legacy/apps/pocket/android" legacy
}

package=ai.namastex.automagik
runner=$package.test/androidx.test.runner.AndroidJUnitRunner
instrument() {
  local label=$1 class=$2 expected=$3
  shift 3
  local out="$artifact/${label}-instrument.txt" status=0 case_id unit=tests
  if [ "$expected" -eq 1 ]; then unit=test; fi
  timeout 1200 adb shell am instrument -w -e class "$package.$class" "$runner" 2>&1 | redact > "$out" || status=$?
  if ! grep -Fxq "OK ($expected $unit)" "$out"; then
    printf '%s: expected OK (%s %s), instrumentation exit %s\n' "$label" "$expected" "$unit" "$status" >&2
    status=1
  fi
  for case_id; do
    if [ "$case_id" = E6 ] || [ "$case_id" = D11 ]; then
      if grep -Fq "ASSERT:${case_id} NOT AUTOMATED" "$out"; then
        record "$case_id" "NOT AUTOMATED"
        continue
      fi
    fi
    if grep -Fq "ASSERT:${case_id} PASS" "$out"; then
      record "$case_id" PASS
    else
      record "$case_id" FAIL
      status=1
    fi
  done
  return "$status"
}

apk_pipeline() {
  local label=$1 tree=$2
  shift 2
  if run_stage "build_$label" "$@"; then
    run_stage "install_$label" install_apks "$tree" "$label"
  else
    skip_stages "build_$label failed" "install_$label"
    return 1
  fi
}

harness_ready=false
if run_stage old_bridge prepare_old_bridge; then
  if run_stage harness_start start_harness; then harness_ready=true; fi
else
  skip_stages 'old_bridge failed' harness_start
fi

current=apps/pocket/android
attach_cases=(D1 D2 D3 D3b D4 D5 D6a D6b D7 D8 D9 D12)
if apk_pipeline current "$current" build_apks "$current" current; then
  if [ "$harness_ready" = true ]; then
    run_stage attach instrument attach AttachDeviceTest 11 "${attach_cases[@]}" || :
    run_stage picker instrument picker AttachPickerDeviceTest 1 D11 || :
    run_stage documents instrument documents AttachDocumentDeviceTest 6 E1 E2 E3 E4 E5 E6 || :
  else
    skip_stages 'harness unavailable' attach "${attach_cases[@]}" picker D11
    skip_stages 'harness unavailable' documents E1 E2 E3 E4 E5 E6
  fi
  if run_stage codec instrument codec AttachImageDeviceTest 7; then
    record D13 PASS
  else
    record D13 FAIL
  fi
else
  skip_stages 'current APKs unavailable' attach "${attach_cases[@]}" picker D11
  skip_stages 'current APKs unavailable' documents E1 E2 E3 E4 E5 E6 codec D13
fi

legacy="$run_temp/rfc-0033-pre-d3"
if apk_pipeline legacy "$legacy/apps/pocket/android" build_legacy; then
  if [ "$harness_ready" = true ]; then
    run_stage legacy instrument legacy LegacyPhoneDeviceTest 1 D10 || :
  else
    skip_stages 'harness unavailable' legacy D10
  fi
else
  skip_stages 'legacy APKs unavailable' legacy D10
fi

reported=true
if [ "$failed" -ne 0 ]; then
  record result FAIL
  exit 1
fi
record result PASS
printf 'PASS: RFC 0033 D4d device acceptance on API %s\n' "$api"
