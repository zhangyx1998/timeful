import { describe, expect, it } from "vitest";
import { parseArgs, usage } from "./args.ts";
import { CliError } from "./errors.ts";

describe("parseArgs", () => {
  it("defaults to deciding for itself, with no overrides", () => {
    expect(parseArgs([])).toEqual({
      command: "auto",
      all: false,
      yes: false,
      dryRun: false,
      overrides: {},
    });
  });

  it("accepts --flag=value", () => {
    expect(parseArgs(["--port=8080", "--host=0.0.0.0"]).overrides).toEqual({
      port: 8080,
      host: "0.0.0.0",
    });
  });

  it("accepts --flag value", () => {
    expect(
      parseArgs(["--var-dir", "/srv/data", "--trusted-proxy", "10.0.0.0/8"]).overrides,
    ).toEqual({ varDir: "/srv/data", trustedProxy: "10.0.0.0/8" });
  });

  it("takes --yes in either spelling", () => {
    expect(parseArgs(["-y"]).yes).toBe(true);
    expect(parseArgs(["--yes"]).yes).toBe(true);
  });

  it("returns help and version early", () => {
    expect(parseArgs(["--port=1", "--help"]).command).toBe("help");
    expect(parseArgs(["-v"]).command).toBe("version");
  });

  it("parses service actions", () => {
    expect(parseArgs(["service", "install"])).toMatchObject({
      command: "service",
      action: "install",
    });
    expect(parseArgs(["service", "status"]).action).toBe("status");
  });

  it("parses the service tier switches", () => {
    expect(parseArgs(["service", "install", "--system"]).tier).toBe("system");
    expect(parseArgs(["service", "install", "--user"]).tier).toBe("user");
    expect(parseArgs(["service", "install"]).tier).toBeUndefined();
  });

  it("rejects a port that is not a port", () => {
    expect(() => parseArgs(["--port=nope"])).toThrow(CliError);
    expect(() => parseArgs(["--port=0"])).toThrow(/between 1 and 65535/);
    expect(() => parseArgs(["--port=70000"])).toThrow(/between 1 and 65535/);
  });

  it("rejects a flag with no value", () => {
    expect(() => parseArgs(["--host"])).toThrow(/--host requires a value/);
    // The next flag is a forgotten argument, not a hostname.
    expect(() => parseArgs(["--host", "--port=3000"])).toThrow(/--host requires a value/);
  });

  it("rejects unknown options, commands and actions", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown option '--nope'/);
    expect(() => parseArgs(["serv"])).toThrow(/Unknown command 'serv'/);
    expect(() => parseArgs(["service", "reload"])).toThrow(/Unknown service action 'reload'/);
    expect(() => parseArgs(["service", "status", "/srv/a", "extra"])).toThrow(
      /Unexpected argument/,
    );
  });
});

describe("parseArgs: actions", () => {
  it("takes init and serve as positional actions", () => {
    expect(parseArgs(["init"]).command).toBe("init");
    expect(parseArgs(["serve"]).command).toBe("serve");
    expect(parseArgs(["serve", "--port", "8080"])).toMatchObject({
      command: "serve",
      overrides: { port: 8080 },
    });
    expect(parseArgs(["init", "--yes"])).toMatchObject({ command: "init", yes: true });
  });

  it("gives init and serve nothing to take an argument for", () => {
    expect(() => parseArgs(["serve", "/srv/timeful"])).toThrow(/takes no arguments/);
    expect(() => parseArgs(["init", "here"])).toThrow(/takes no arguments/);
  });

  it("parses every service verb", () => {
    for (const verb of ["install", "uninstall", "start", "stop", "restart", "status"])
      expect(parseArgs(["service", verb]).action).toBe(verb);
  });

  it("leaves the verb unset for a bare 'service', which lists them", () => {
    expect(parseArgs(["service"]).command).toBe("service");
    expect(parseArgs(["service"]).action).toBeUndefined();
  });

  it("takes a webroot after the verb", () => {
    expect(parseArgs(["service", "restart", "/srv/timeful"])).toMatchObject({
      command: "service",
      action: "restart",
      target: "/srv/timeful",
    });
  });

  it("takes -A/--all for the verbs that can mean every webroot", () => {
    for (const verb of ["uninstall", "start", "stop", "restart", "status"])
      expect(parseArgs(["service", verb, "-A"])).toMatchObject({ action: verb, all: true });
    expect(parseArgs(["service", "--all"]).all).toBe(true);
  });

  it("refuses -A where it cannot mean anything", () => {
    expect(() => parseArgs(["service", "install", "-A"])).toThrow(/works on one webroot/);
    expect(() => parseArgs(["serve", "--all"])).toThrow(/only means something for/);
    expect(() => parseArgs(["service", "stop", "/srv/a", "-A"])).toThrow(
      /webroot or -A\/--all, not both/,
    );
  });

  it("takes --dry-run anywhere", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseArgs(["init", "--dry-run"])).toMatchObject({ command: "init", dryRun: true });
    expect(parseArgs(["service", "install", "--dry-run"]).dryRun).toBe(true);
    expect(parseArgs([]).dryRun).toBe(false);
  });
});

describe("usage", () => {
  it("names the version and every option", () => {
    const text = usage("1.2.3");
    expect(text).toContain("timeful 1.2.3");
    for (const flag of [
      "--port",
      "--host",
      "--var-dir",
      "--trusted-proxy",
      "--yes",
      "--system",
      "--all",
      "--dry-run",
    ])
      expect(text).toContain(flag);
  });

  it("documents every action and service verb", () => {
    const text = usage("1.2.3");
    for (const action of ["timeful init", "timeful serve", "timeful service"])
      expect(text).toContain(action);
    for (const verb of ["install", "uninstall", "start", "stop", "restart", "status"])
      expect(text).toContain(verb);
  });
});
