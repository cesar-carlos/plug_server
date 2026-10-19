"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const mode = process.env.SWAGGER_STATIC_SYNC ?? "auto";

if (mode === "skip") {
  console.log("Skipping swagger static sync (SWAGGER_STATIC_SYNC=skip)");
  process.exit(0);
}

// The shell script copies assets to /var/lib/plug_server for the Linux nginx
// host. On Windows, `bash` is the WSL launcher and the only distro here is
// docker-desktop, which has no /bin/bash. Auto mode is a no-op on that host.
if (process.platform === "win32" && mode === "auto") {
  console.log(
    "Skipping swagger static sync: /var/lib/plug_server does not exist (dev/CI)",
  );
  process.exit(0);
}

const script = path.join(__dirname, "sync-swagger-ui-static.sh");
const result = spawnSync("bash", [script], {
  stdio: "inherit",
  env: process.env,
  windowsHide: true,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
