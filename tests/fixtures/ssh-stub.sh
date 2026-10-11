#!/bin/bash
# Stand-in for ssh in the service-control tests: records argv and the script it was handed,
# answers state checks with "active" and everything else with a canned log line.
script=$(cat)
printf '%s\n--\n%s\n==\n' "$*" "$script" >> "${SSH_STUB_LOG:-/dev/null}"
case "$script" in
  *is-active*|*"State.Status"*) echo active ;;
  *) echo "stub log line from $5" ;;
esac
