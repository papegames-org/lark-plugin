function stripProfilePrefix(args) {
  if (args[0] === "--profile") return args.slice(2);
  return args;
}

export function okLarkCliResult(stdout = "", stderr = "") {
  return { stdout, stderr, code: 0, ok: true };
}

export function createLarkCliStatusPayload({
  appId = "cli_test",
  openId = "ou_test",
  grantedScopes = ["scope:a"],
  userAvailable = true,
  userVerified = true,
} = {}) {
  return {
    appId,
    app_id: appId,
    identities: {
      user: {
        openId,
        open_id: openId,
        available: userAvailable,
        verified: userVerified,
        scope: grantedScopes,
        scopes: grantedScopes,
      },
    },
  };
}

export function createLarkCliCommandRunner(options = {}) {
  const calls = options.calls || [];
  const appId = options.appId ?? "cli_test";
  const openId = options.openId ?? "ou_test";
  const profiles = options.profiles ?? [{ name: "default", appId, app_id: appId }];

  return async (args) => {
    calls.push(args);
    const cmd = stripProfilePrefix(args);
    if (cmd[0] === "--version") {
      return okLarkCliResult("lark-cli 1.0.0");
    }
    if (cmd[0] === "profile" && cmd[1] === "list") {
      return okLarkCliResult(JSON.stringify(profiles));
    }
    if (cmd[0] === "config" && cmd[1] === "bind") {
      return okLarkCliResult("");
    }
    if (cmd[0] === "auth" && cmd[1] === "status" && cmd[2] === "--verify") {
      if (typeof options.onAuthStatusVerify === "function") {
        return options.onAuthStatusVerify(args, calls);
      }
      const payload = options.statusPayload ?? createLarkCliStatusPayload({
        appId,
        openId,
        grantedScopes: options.grantedScopes ?? ["scope:a"],
        userAvailable: options.userAvailable ?? true,
        userVerified: options.userVerified ?? true,
      });
      return okLarkCliResult(JSON.stringify(payload));
    }
    if (cmd[0] === "auth" && cmd[1] === "login") {
      if (typeof options.onAuthLogin === "function") {
        return options.onAuthLogin(args, calls);
      }
      return okLarkCliResult(JSON.stringify({
        verification_url: options.verificationUrl ?? "https://example.com/user-login",
        device_code: options.deviceCode ?? "device-user-grant",
        expires_in: 600,
        interval: 5,
      }));
    }
    if (typeof options.onUnknown === "function") {
      return options.onUnknown(args, calls);
    }
    throw new Error(`unexpected lark-cli args ${args.join(" ")}`);
  };
}
