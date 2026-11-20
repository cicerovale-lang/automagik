#!/usr/bin/env bash
# Disposable API 35 memory notice check; workflow boots the emulator first.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
artifact=${RUNNER_TEMP:?RUNNER_TEMP must be set}/androidmemnotice-device-api35
mkdir -p "$artifact"
package=ai.namastex.automagik
runner="$package.test/androidx.test.runner.AndroidJUnitRunner"
step=prerequisites
harness_pid=
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    printf 'FAILED: %s (exit %s)\n' "$step" "$result" >&2
    timeout 20 adb exec-out screencap -p > "$artifact/failure.png" 2>/dev/null || :
    timeout 20 adb logcat -d -t 1000 2>/dev/null | redact > "$artifact/failure-logcat.txt" || :
  fi
  if [ -n "$harness_pid" ]; then
    kill "$harness_pid" 2>/dev/null || :
    wait "$harness_pid" 2>/dev/null || :
  fi
}
redact() {
  sed -e 's/Seeded fixture note/<memory>/g' -e 's/Device fixture draft/<memory>/g' \
      -e 's/Added from the emulator/<memory>/g' \
      -e 's/Edited from the emulator/<memory>/g' \
      -e 's/Changed on the desktop/<memory>/g' \
      -e 's/Phone stale edit/<memory>/g'
}
trap cleanup EXIT
record() { printf '%s=%s\n' "$1" "$2" >> "$artifact/assertions.txt"; }

for tool in node adb grep sed timeout; do command -v "$tool" >/dev/null; done
test "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1
test "$(adb shell getprop ro.build.version.sdk | tr -d '\r')" = 35
test -f .automagik/verify-1182.init.gradle
test -f .automagik/memory-notice-harness.mjs
record api 35

step=harness_start
NODE_OPTIONS='--import=./apps/bots-dsh/test/harness-resolve.mjs' node .automagik/memory-notice-harness.mjs \
  > "$artifact/harness-stdout.txt" 2> "$artifact/harness-stderr.txt" &
harness_pid=$!
ready=false
for attempt in {1..60}; do
  if grep -qx READY "$artifact/harness-stdout.txt"; then ready=true; break; fi
  kill -0 "$harness_pid" 2>/dev/null || break
  sleep 1
done
test "$ready" = true
record harness_ready true

step=build
(
  cd apps/pocket/android
  ./gradlew --init-script "$root/.automagik/verify-1182.init.gradle" --no-daemon --max-workers=2 --stacktrace \
    :app:assembleGithubDebug :app:assembleGithubDebugAndroidTest
)
app_apk=apps/pocket/android/app/build/outputs/apk/github/debug/app-github-debug.apk
test_apk=apps/pocket/android/app/build/outputs/apk/androidTest/github/debug/app-github-debug-androidTest.apk
test -s "$app_apk" && test -s "$test_apk"
record app_and_android_test_built true

step=install
adb install "$app_apk" > "$artifact/install-app.txt"
adb install "$test_apk" > "$artifact/install-test.txt"
record both_apks_installed true

step=instrument
instrument_status=0
timeout 600 adb shell am instrument -w -e class "$package.MemoryNoticeDeviceTest" "$runner" \
  > "$artifact/instrument-raw.txt" 2>&1 || instrument_status=$?
redact < "$artifact/instrument-raw.txt" > "$artifact/instrument-output.txt"
rm "$artifact/instrument-raw.txt"
test "$instrument_status" -eq 0
grep -Fq 'OK (1 test)' "$artifact/instrument-output.txt"
record memory_notice_device_test 'OK (1 test)'
record result PASS
printf 'PASS: memory notice through Pocket chat on API 35\n'
