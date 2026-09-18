#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  assertResolvedAddressesSafe,
  isBenchmarkProxyIp,
  isPrivateIpAddress,
} from "../runtime/pi/net.mjs";

assert.equal(isBenchmarkProxyIp("198.18.0.1"), true);
assert.equal(isBenchmarkProxyIp("198.19.255.254"), true);
assert.equal(isBenchmarkProxyIp("::ffff:198.18.0.1"), true);
assert.equal(isBenchmarkProxyIp("198.20.0.1"), false);
assert.equal(isPrivateIpAddress("198.18.0.1"), true);

assert.doesNotThrow(() => assertResolvedAddressesSafe([{ address: "93.184.216.34" }], "https:"));
assert.doesNotThrow(() => assertResolvedAddressesSafe([{ address: "2606:2800:220:1:248:1893:25c8:1946" }], "https:"));
assert.doesNotThrow(() => assertResolvedAddressesSafe([{ address: "198.18.0.28" }], "https:"));

for (const address of ["127.0.0.1", "10.0.0.1", "169.254.1.1", "172.16.0.1", "192.168.0.1", "::1", "fc00::1"]) {
  assert.throws(
    () => assertResolvedAddressesSafe([{ address }], "https:"),
    /private, local, or unsupported/,
  );
}
assert.throws(
  () => assertResolvedAddressesSafe([{ address: "198.18.0.28" }], "http:"),
  /require HTTPS/,
);
assert.throws(
  () => assertResolvedAddressesSafe([] , "https:"),
  /did not resolve/,
);

console.log("network safety: PASS (public HTTPS, proxy fake-IP HTTPS, private/local blocking)");
