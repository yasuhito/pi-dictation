const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");

const endpoint = { type: "unix", path: "/private/companion.sock" };
const credential = {
  id: "22222222-2222-4222-8222-222222222222",
  secret: Buffer.alloc(32, 2).toString("base64"),
};

async function managementModule() {
  return import("../bin/bridge-management-request.mjs");
}

test("management exchanges cross the shared request seam once", async (t) => {
  const { companionRequestAt } = await managementModule();
  const calls = [];
  const request = async (options) => {
    calls.push(options);
    return { status: "ok", payload: { connections: 0 } };
  };
  const requestId = randomUUID();
  const startedAt = Date.now();
  const result = await companionRequestAt(endpoint, credential, "credential-effects", requestId, request);

  await t.test("returns the shared seam payload", () => assert.deepEqual(result, { connections: 0 }));
  await t.test("does not retry", () => assert.equal(calls.length, 1));
  await t.test("preserves the management operation", () => assert.equal(calls[0].operation, "credential-effects"));
  await t.test("preserves the fixed request identity", () => assert.equal(calls[0].requestId, requestId));
  await t.test("uses the caller-owned endpoint", () => assert.deepEqual(calls[0].endpoint, endpoint));
  await t.test("sends no operation-specific payload", () => assert.deepEqual(calls[0].payload, {}));
  await t.test("starts connection and challenge from one fixed deadline", () => {
    assert.deepEqual(calls[0].timing.connect, calls[0].timing.challenge);
  });
  await t.test("sets the initial deadline to five seconds", () => {
    assert.equal(calls[0].timing.connect.at >= startedAt + 5000 && calls[0].timing.connect.at <= startedAt + 5100, true);
  });
  await t.test("resets the request-write timeout", () => {
    assert.deepEqual(calls[0].timing.requestWrite, { kind: "no-progress", timeoutMs: 5000 });
  });
  await t.test("resets the authenticated response timeout", () => {
    assert.deepEqual(calls[0].timing.response, { kind: "no-progress", timeoutMs: 5000 });
  });
});

test("management exchanges preserve authenticated status outcomes", async (t) => {
  const { companionRequestAt } = await managementModule();
  let error;
  try {
    await companionRequestAt(endpoint, credential, "credential-revoke", undefined, async () => ({ status: "busy", payload: {} }));
  } catch (caught) { error = caught; }

  await t.test("preserves the authenticated status field", () => assert.equal(error.status, "busy"));
  await t.test("preserves the authenticated CLI message", () => {
    assert.equal(error.message, "The companion rejected credential-revoke with authenticated status busy.");
  });
});

test("management exchanges preserve authenticated version mismatch diagnostics", async () => {
  const { companionRequestAt } = await managementModule();
  await assert.rejects(
    companionRequestAt(endpoint, credential, "health", undefined, async () => ({
      status: "version-mismatch",
      payload: { clientVersion: 3, companionVersion: 2 },
    })),
    { message: "Authenticated protocol mismatch: Pi uses version 3; companion uses version 2." },
  );
});

for (const [name, kind, stage, code, message] of [
  ["invalid frame", "malformed", "challenge", "ERR_BRIDGE_INVALID_FRAME", "The companion sent an invalid protocol frame."],
  ["malformed protocol data", "malformed", "response", "ERR_BRIDGE_MALFORMED_PROTOCOL_DATA", "The companion sent malformed protocol data."],
  ["trailing bytes", "malformed", "challenge", "ERR_BRIDGE_TRAILING_BYTES", "The companion sent trailing protocol bytes."],
  ["invalid challenge", "malformed", "challenge", "ERR_BRIDGE_INVALID_CHALLENGE", "The companion sent an invalid authentication challenge."],
  ["invalid response", "malformed", "response", "ERR_BRIDGE_INVALID_RESPONSE", "The companion returned an invalid authenticated response."],
  ["invalid version data", "malformed", "response", "ERR_BRIDGE_INVALID_VERSION_DATA", "The companion returned invalid authenticated version data."],
  ["noncanonical authentication", "authentication", "response", "ERR_BRIDGE_NONCANONICAL_AUTHENTICATION", "The companion sent malformed authenticated protocol data."],
  ["unexpected response EOF", "transport", "response", "ERR_BRIDGE_UNEXPECTED_EOF", "The companion closed an incomplete health response."],
  ["socket failure", "transport", "response", undefined, "The companion Unix socket is unavailable."],
]) {
  test(`management exchanges preserve the ${name} diagnostic`, async () => {
    const { BridgeProtocolFailure } = await import("../lib/bridge-protocol.mjs");
    const { companionRequestAt } = await managementModule();
    const cause = Object.assign(new Error(code), { code });
    await assert.rejects(
      companionRequestAt(endpoint, credential, "health", undefined, async () => {
        throw new BridgeProtocolFailure(kind, stage, cause);
      }),
      { message },
    );
  });
}

test("management credentials are rejected before the shared seam connects", async (t) => {
  const { companionRequestAt } = await managementModule();
  let calls = 0;
  await assert.rejects(
    companionRequestAt(endpoint, { ...credential, secret: "not-a-secret" }, "health", undefined, async () => {
      calls += 1;
      return { status: "ok", payload: {} };
    }),
    { message: "Refusing invalid bridge credential." },
  );
  await t.test("does not enter the shared seam", () => assert.equal(calls, 0));
});
