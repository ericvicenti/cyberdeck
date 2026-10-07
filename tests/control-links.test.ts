// Pure helpers behind the Projects ⇄ Services links in the UI (ui/lib/control.ts, ui/lib/hosts.ts).
import { describe, expect, test } from "bun:test";
import { serviceMatches, projectsForService, servicesForProject, projectsOnHost, serviceLogCmd, serviceRestartCmd, linkCommand, fleetPath, type Project, type ServiceRow } from "../ui/lib/control";
import { resolveHost } from "../ui/lib/hosts";

const proj = (slug: string, services: string[], hosts: string[] = []): Project => ({ slug, name: slug, status: "active", depth: slug.split("/").length - 1, parent: slug.includes("/") ? slug.slice(0, slug.lastIndexOf("/")) : null, repos: [], hosts, services, links: [], body: "", file: "" });
const row = (host: string, service: string, type = "systemd"): ServiceRow => ({ host, service, type, state: "active", ok: true });

describe("service patterns", () => {
  test("host/name with * as one segment", () => {
    expect(serviceMatches("botical/afterglow*", row("botical", "afterglow-proxy"))).toBe(true);
    expect(serviceMatches("botical/afterglow*", row("botical", "afterglow"))).toBe(true);
    expect(serviceMatches("botical/afterglow*", row("yacht", "afterglow"))).toBe(false);
    expect(serviceMatches("*/cyberdeck", row("iris", "cyberdeck"))).toBe(true);
    expect(serviceMatches("*/cyberdeck", row("iris", "cyberdeck-old"))).toBe(false);
    expect(serviceMatches("starlight/io.commander.*", row("starlight", "io.commander.vanguard-online"))).toBe(true);
    expect(serviceMatches("starlight/io.commander.*", row("starlight", "ioXcommander.x"))).toBe(false); // dots are literal
  });

  test("projects for a service, services for a project (subprojects included)", () => {
    const ps = [proj("seed", ["yacht/seed-host"], ["yacht"]), proj("seed/agents", ["agentic/agents-*"], ["agentic"]), proj("deck", ["*/cyberdeck"], ["yacht", "starlight"])];
    const rows = [row("yacht", "seed-host"), row("agentic", "agents-dev", "docker"), row("yacht", "cyberdeck", "http"), row("iris", "jellyfin")];
    expect(projectsForService(rows[1], ps).map((p) => p.slug)).toEqual(["seed/agents"]);
    expect(projectsForService(rows[3], ps)).toEqual([]);
    expect(servicesForProject(ps[0], ps, rows).map((r) => r.service)).toEqual(["seed-host", "agents-dev"]);
    expect(servicesForProject(ps[1], ps, rows).map((r) => r.service)).toEqual(["agents-dev"]);
    expect(projectsOnHost("Yacht", ps).map((p) => p.slug)).toEqual(["seed", "deck"]);
  });

  test("projects without a services key still work", () => {
    const p = { ...proj("x", []), services: undefined } as Project;
    expect(servicesForProject(p, [p], [row("a", "b")])).toEqual([]);
    expect(projectsForService(row("a", "b"), [p])).toEqual([]);
  });
});

describe("service commands", () => {
  test("log command per service type, quoted for the shell", () => {
    expect(serviceLogCmd(row("h", "caddy"))).toContain("journalctl -u 'caddy' -n 200 -f");
    expect(serviceLogCmd(row("h", "cyberdeck", "systemd-user"))).toContain("journalctl --user -u 'cyberdeck'");
    expect(serviceLogCmd(row("h", "backup.timer", "systemd-timer"))).toContain("journalctl -u 'backup'");
    expect(serviceLogCmd(row("h", "agents-dev", "docker"))).toContain("docker logs -n 200 -f 'agents-dev'");
    expect(serviceLogCmd(row("h", "sh.cyberdeck.daemon", "launchd"))).toContain("launchctl print gui/$(id -u)/'sh.cyberdeck.daemon'");
    expect(serviceLogCmd(row("h", "cyberdeck", "http"))).toBeNull();
    expect(serviceLogCmd(row("h", "it's", "docker"))).toContain(`'it'\\''s'`);
  });
  test("restart command per service type", () => {
    expect(serviceRestartCmd(row("h", "caddy"))).toContain("sudo systemctl restart 'caddy'");
    expect(serviceRestartCmd(row("h", "x", "launchd"))).toContain("launchctl kickstart -k gui/$(id -u)/'x'");
    expect(serviceRestartCmd(row("h", "x", "docker"))).toContain("docker restart 'x'");
    expect(serviceRestartCmd(row("h", "x", "http"))).toBeNull();
  });
});

describe("links and paths", () => {
  test("ssh links become commands, the rest do not", () => {
    expect(linkCommand("ssh root@voice.botical.com")).toBe("ssh root@voice.botical.com");
    expect(linkCommand("ssh agent.hm (containers agents-dev / agents-staging)")).toBe("ssh agent.hm");
    expect(linkCommand("https://hyper.media")).toBeNull();
    expect(linkCommand("launchd io.commander.vanguard-online on starlight")).toBeNull();
  });
  test("handoff file paths resolve against the fleet checkout", () => {
    expect(fleetPath("/Users/me/Code/Deck", "handoff/starlight-cc.md")).toBe("/Users/me/Code/Deck/handoff/starlight-cc.md");
    expect(fleetPath("/Users/me/Code/Deck", "/abs/x.md")).toBe("/abs/x.md");
  });
});

describe("where a host command runs", () => {
  const hosts = [{ name: "starlight", ssh: "starlight" }, { name: "botical", ssh: "root@voice.botical.com" }, { name: "jetpack", ssh: null }, { name: "yacht", ssh: "yacht" }].map((h) => ({ ...h, kind: "", os: "", roles: [], online: true, cyberdeck: null }));
  const nodes = [{ id: "n1", name: "Yacht", online: true }, { id: "n2", name: "Iris", online: false }];
  test("this host runs locally", () => expect(resolveHost({ host: "Starlight", me: "starlight", hosts, nodes })).toEqual({ kind: "local" }));
  test("a paired online node runs there (names compare case-insensitively)", () => expect(resolveHost({ host: "yacht", me: "starlight", hosts, nodes })).toEqual({ kind: "node", id: "n1", name: "Yacht" }));
  test("anything else goes over the fleet.json ssh alias", () => expect(resolveHost({ host: "botical", me: "starlight", hosts, nodes })).toEqual({ kind: "ssh", alias: "root@voice.botical.com" }));
  test("an offline node without an alias, or a host with no alias, cannot run", () => {
    expect(resolveHost({ host: "iris", me: "starlight", hosts, nodes }).kind).toBe("none");
    expect(resolveHost({ host: "jetpack", me: "starlight", hosts, nodes }).kind).toBe("none");
  });
});
