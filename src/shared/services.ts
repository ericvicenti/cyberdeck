// Shell commands for a fleet service, by the manifest's service type (fleet.json `hosts.<h>.services`).
// Shared by the UI (a terminal on the host runs them) and the daemon (the MCP `service_logs` /
// `services_restart` tools run them over `bash -s`, locally or through ssh). Every name is quoted.

export type ServiceRef = { service: string; type: string };

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Types the daemon knows how to restart and read logs for (http probes have neither). */
export const SERVICE_TYPES = ["systemd", "systemd-timer", "systemd-user", "launchd", "docker"] as const;

/** Recent logs of a service; `follow` keeps tailing and `interactive` lets sudo prompt (terminal use). null when the type has no logs (http probes). */
export function serviceLogCmd(row: ServiceRef, opts: { lines?: number; follow?: boolean; interactive?: boolean } = {}): string | null {
  const n = q(row.service);
  const sudo = opts.interactive ? "sudo" : "sudo -n";
  const lines = Math.max(1, Math.min(2000, Math.floor(opts.lines ?? 200)));
  const f = opts.follow ? " -f" : "";
  const pager = opts.follow ? "" : " --no-pager";
  switch (row.type) {
    case "systemd": return `journalctl${pager} -u ${n} -n ${lines}${f} || ${sudo} journalctl${pager} -u ${n} -n ${lines}${f}`;
    case "systemd-timer": {
      const unit = q(row.service.replace(/\.timer$/, ""));
      return `systemctl list-timers ${n}${pager}; journalctl${pager} -u ${unit} -n ${lines} || ${sudo} journalctl${pager} -u ${unit} -n ${lines}`;
    }
    case "systemd-user": return `journalctl${pager} --user -u ${n} -n ${lines}${f}`;
    case "launchd": return `launchctl print gui/$(id -u)/${n} | head -${opts.follow ? 40 : 12}; launchctl print gui/$(id -u)/${n} | sed -nE 's/^[[:space:]]*(stdout|stderr) path = //p' | sort -u | { files=(); while IFS= read -r f; do files+=("$f"); done; [ \${#files[@]} -gt 0 ] && tail -n ${lines}${f} "\${files[@]}"; }`;
    case "docker": return `docker logs -n ${lines}${f} ${n} 2>&1 || sudo -n docker logs -n ${lines}${f} ${n} 2>&1`;
    default: return null;
  }
}

/** Restarts a service, run on its host. null for types that cannot be restarted this way. */
export function serviceRestartCmd(row: ServiceRef, opts: { interactive?: boolean } = {}): string | null {
  const n = q(row.service);
  const sudo = opts.interactive ? "sudo" : "sudo -n";
  switch (row.type) {
    case "systemd": case "systemd-timer": return `${sudo} systemctl restart ${n} && systemctl status ${n} --no-pager | head -20`;
    case "systemd-user": return `systemctl --user restart ${n} && systemctl --user status ${n} --no-pager | head -20`;
    case "launchd": return `launchctl kickstart -k gui/$(id -u)/${n} && launchctl print gui/$(id -u)/${n} | head -20`;
    case "docker": return `docker restart ${n} || sudo -n docker restart ${n}`;
    default: return null;
  }
}

/** Prints one word for the service's state (the same probe `deck services` runs): active / inactive / running / unknown ... */
export function serviceStateCmd(row: ServiceRef): string | null {
  const n = q(row.service);
  switch (row.type) {
    case "systemd": case "systemd-timer": return `systemctl is-active ${n} || true`;
    case "systemd-user": return `systemctl --user is-active ${n} || true`;
    case "launchd": return `launchctl list | awk -v l=${n} '$3==l{print ($1=="-"?"inactive":"active")}' | grep . || echo unknown`;
    case "docker": return `docker inspect -f '{{.State.Status}}' ${n} 2>/dev/null || sudo -n docker inspect -f '{{.State.Status}}' ${n} 2>/dev/null || echo unknown`;
    default: return null;
  }
}

/** Whether a state word means the service is up. */
export const stateOk = (state: string) => ["active", "running", "activating"].includes(state.trim().split(/\s+/).pop() ?? "");
