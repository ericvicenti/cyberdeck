#!/bin/bash
# Stand-in for ssh in the service-control tests: records argv and the script it was handed,
# answers state checks with "active" and everything else with a canned log line.
script=$(cat)
printf '%s\n--\n%s\n==\n' "$*" "$script" >> "${SSH_STUB_LOG:-/dev/null}"
case "$script" in
  *is-active*|*"State.Status"*) echo active ;;
  *"df -Pk"*) printf '%s\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' \
      '/dev/sda1 50331648 48234496 2097152 96% /' 'tmpfs 1000 0 1000 0% /run' \
      '/dev/loop3 1000 1000 0 100% /snap/core/1' '/dev/sdb 262144000 94371840 167772160 36% /var/lib/docker' ;;
  *) echo "stub log line from $5" ;;
esac
