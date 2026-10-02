import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

// Restricted to the temporary hostname authorized for this project. Never log tokens.
const hostname = "reversing.agentryx-ai.com";
const zoneName = "agentryx-ai.com";
const tunnelName = "reversing-all-temporary";
const directory = resolve("data/deployment");
const statePath = join(directory, "cloudflare.json");
const command = process.argv[2] || "inspect";
if (!["inspect", "prepare", "route", "status"].includes(command))
  throw new Error("Use inspect, prepare, route, or status");
const portArgs = process.argv.slice(3);
if (
  portArgs.length &&
  (command !== "prepare" ||
    portArgs.length !== 2 ||
    portArgs[0] !== "--origin-port" ||
    !/^\d+$/.test(portArgs[1]))
)
  throw new Error("Use prepare --origin-port PORT");
const requestedPort = portArgs.length ? Number(portArgs[1]) : undefined;
if (
  requestedPort !== undefined &&
  (!Number.isInteger(requestedPort) ||
    requestedPort < 1024 ||
    requestedPort > 65535)
)
  throw new Error("invalid-origin-port");
mkdirSync(directory, { recursive: true });
const projectTokenPath = "C:/_authentication/reversing-cloudflare.env";
const env = readFileSync(
  process.env.CLOUDFLARE_TOKEN_FILE ||
    (existsSync(projectTokenPath)
      ? projectTokenPath
      : "C:/_authentication/cloudflare-common.env"),
  "utf8",
);
const token = env
  .match(/^\s*CLOUDFLARE_API_TOKEN\s*=\s*(.+)\s*$/m)?.[1]
  .trim()
  .replace(/^["']|["']$/g, "");
if (!token) throw new Error("cloudflare-token-missing");
async function call(path, method = "GET", body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok || result.success !== true)
    throw new Error(
      `cloudflare-${response.status}-${(result.errors || []).map((e) => e.code).join("-")}`,
    );
  return result.result;
}
async function main() {
  const zones = await call(`/zones?name=${zoneName}`);
  if (zones.length !== 1 || zones[0].status !== "active")
    throw new Error("active-zone-required");
  const zone = zones[0];
  const base = `/accounts/${zone.account.id}/cfd_tunnel`;
  const records = await call(`/zones/${zone.id}/dns_records?name=${hostname}`);
  const tunnels = (await call(`${base}?is_deleted=false`)).filter(
    (t) => t.name === tunnelName,
  );
  if (tunnels.length > 1) throw new Error("ambiguous-tunnel");
  let tunnel = tunnels[0];
  if (command === "inspect") {
    console.log(
      JSON.stringify({
        hostname,
        zoneActive: true,
        existingDns: records.map((r) => ({ type: r.type, content: r.content })),
        tunnelExists: !!tunnel,
      }),
    );
    return;
  }
  const old = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : null;
  const originPort = requestedPort ?? old?.originPort ?? 3100;
  if (!Number.isInteger(originPort) || originPort < 1024 || originPort > 65535)
    throw new Error("invalid-origin-port");
  if (tunnel && old?.tunnelId !== tunnel.id)
    throw new Error("unowned-existing-tunnel");
  if (command === "prepare") {
    if (
      records.length &&
      (!tunnel ||
        records.some(
          (r) =>
            r.type !== "CNAME" || r.content !== `${tunnel.id}.cfargotunnel.com`,
        ))
    )
      throw new Error("hostname-already-used");
    if (!tunnel) {
      tunnel = await call(base, "POST", {
        name: tunnelName,
        config_src: "cloudflare",
      });
      // Write the resource receipt immediately so a subsequent failure can resume safely.
      writeFileSync(
        statePath,
        JSON.stringify(
          {
            hostname,
            zoneId: zone.id,
            accountId: zone.account.id,
            tunnelId: tunnel.id,
            originPort,
          },
          null,
          2,
        ),
      );
    }
    await call(`${base}/${tunnel.id}/configurations`, "PUT", {
      config: {
        ingress: [
          {
            hostname,
            service: `http://127.0.0.1:${originPort}`,
            originRequest: {},
          },
          { service: "http_status:404" },
        ],
      },
    });
    const runToken = tunnel.token || (await call(`${base}/${tunnel.id}/token`));
    if (typeof runToken !== "string" || !runToken)
      throw new Error("tunnel-token-missing");
    writeFileSync(join(directory, "tunnel-token.txt"), runToken, {
      mode: 0o600,
    });
    // Official release + repository-provided digest; the binary is private, never committed.
    const releaseResponse = await fetch(
      "https://api.github.com/repos/cloudflare/cloudflared/releases/latest",
      {
        headers: { "User-Agent": "reversing-all-deployment" },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!releaseResponse.ok) throw new Error("release-discovery-failed");
    const release = await releaseResponse.json();
    const asset = release.assets.find(
      (a) => a.name === "cloudflared-windows-amd64.exe",
    );
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || ""))
      throw new Error("official-binary-digest-required");
    const binaryPath = join(directory, "cloudflared.exe");
    const digest = (b) =>
      `sha256:${createHash("sha256").update(b).digest("hex")}`;
    if (
      !existsSync(binaryPath) ||
      digest(readFileSync(binaryPath)) !== asset.digest
    ) {
      const response = await fetch(asset.browser_download_url, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error("binary-download-failed");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (digest(bytes) !== asset.digest)
        throw new Error("binary-digest-mismatch");
      writeFileSync(binaryPath, bytes);
    }
    writeFileSync(
      statePath,
      JSON.stringify(
        {
          hostname,
          zoneId: zone.id,
          accountId: zone.account.id,
          tunnelId: tunnel.id,
          originPort,
          binaryVersion: release.tag_name,
          binaryDigest: asset.digest,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        prepared: true,
        hostname,
        originPort,
        binaryVersion: release.tag_name,
        dnsRouted: false,
      }),
    );
    return;
  }
  if (!tunnel || old?.tunnelId !== tunnel.id) throw new Error("prepare-first");
  if (command === "route") {
    const content = `${tunnel.id}.cfargotunnel.com`;
    if (records.some((r) => r.type !== "CNAME" || r.content !== content))
      throw new Error("hostname-already-used");
    if (!records.length)
      await call(`/zones/${zone.id}/dns_records`, "POST", {
        type: "CNAME",
        proxied: true,
        name: hostname,
        content,
        ttl: 1,
      });
    console.log(JSON.stringify({ routed: true, url: `https://${hostname}` }));
    return;
  }
  const current = await call(`${base}/${tunnel.id}`);
  console.log(
    JSON.stringify({
      hostname,
      status: current.status,
      connections: current.connections?.length || 0,
      dnsRouted: records.some(
        (r) => r.content === `${tunnel.id}.cfargotunnel.com`,
      ),
    }),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "deployment-failed");
  process.exitCode = 1;
});
