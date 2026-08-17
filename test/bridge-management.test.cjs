const assert = require("node:assert/strict");
const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { mkdtempSync, rmSync } = require("node:fs");
const net = require("node:net");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");

const root = resolve(__dirname, "..");
const credential = { id: "33333333-3333-4333-8333-333333333333", secret: Buffer.alloc(32, 7).toString("base64") };
const secret = Buffer.from(credential.secret, "base64");

function encode(fields) {
  const pieces = [Buffer.from("pi-dictation-bridge-auth-v1\0")];
  for (const field of fields) {
    const value = Buffer.isBuffer(field) ? field : Buffer.from(String(field));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    pieces.push(length, value);
  }
  return Buffer.concat(pieces);
}

function tag(fields) {
  return createHmac("sha256", secret).update(encode(fields)).digest();
}

function framed(body) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function frame(value) {
  return framed(Buffer.from(JSON.stringify(value)));
}

function authenticated({ request, challenge }, overrides = {}) {
  const status = overrides.status ?? "ok";
  const version = overrides.version ?? 3;
  const payload = overrides.payload ?? Buffer.from(JSON.stringify(overrides.body ?? {}));
  const responseTag = tag([
    "response", 3, version, challenge, credential.id, request.requestId, `${request.operation}:${status}`, payload,
  ]);
  return frame({
    type: "response", version, requestId: request.requestId, status,
    payload: payload.toString("base64"), hmac: overrides.hmac ?? responseTag.toString("hex"),
  });
}

async function companion(respond, challengeBytes) {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-management-"));
  const path = join(directory, "companion.sock");
  const requests = [];
  const connections = [];
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    connections.push(socket);
    const challenge = randomBytes(32);
    socket.write(challengeBytes
      ? challengeBytes(challenge)
      : frame({ type: "challenge", challenge: challenge.toString("base64") }));
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const length = buffered.readUInt32BE(0);
      if (buffered.length !== length + 4) return;
      const request = JSON.parse(buffered.subarray(4));
      requests.push(request);
      const payload = Buffer.from(request.payload, "base64");
      const expected = tag(["request", 3, challenge, credential.id, request.requestId, request.operation, payload]);
      const actual = Buffer.from(request.hmac, "hex");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return socket.destroy();
      const response = respond({ request, challenge, socket });
      if (response !== undefined) socket.end(response);
    });
  });
  await new Promise((ready) => server.listen(path, ready));
  return {
    endpoint: { type: "unix", path },
    requests,
    connections,
    close() {
      for (const socket of connections) socket.destroy();
      server.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function managementSeam() {
  const shared = await import(join(root, "lib", "bridge-protocol.mjs"));
  const management = await import(join(root, "bin", "bridge-management.mjs"));
  const observed = [];
  return {
    ...management,
    shared,
    observed,
    protocol: {
      request(options) {
        observed.push(options);
        return shared.request(options);
      },
    },
  };
}

const health = { permission: "authorized", defaultInputAvailable: true };
const effects = { connections: 1, activeRecordingLease: 0, incompleteAudio: 0, retainedWav: 2 };

test("authenticated management health crosses the shared Bridge protocol seam", async (t) => {
  const seam = await managementSeam();
  const server = await companion((exchange) => authenticated(exchange, { body: health }));
  try {
    const observedHealth = await seam.healthAt(server.endpoint, credential, seam.protocol);
    await t.test("requests health through the shared seam", () => {
      assert.deepEqual(seam.observed.map((options) => options.operation), ["health"]);
    });
    await t.test("returns the validated authenticated health payload", () => {
      assert.deepEqual(observedHealth, health);
    });
    await t.test("keeps the payload empty on the wire", () => {
      assert.equal(Buffer.from(server.requests[0].payload, "base64").toString(), "{}");
    });
  } finally {
    server.close();
  }
});

test("credential administration crosses the shared seam with its caller-owned identity", async (t) => {
  const seam = await managementSeam();
  const server = await companion((exchange) => authenticated(exchange, { body: effects }));
  const fixedRequestId = "44444444-4444-5444-8444-444444444444";
  try {
    const observedEffects = await seam.companionRequestAt(
      server.endpoint, credential, "credential-effects", fixedRequestId, seam.protocol,
    );
    await t.test("requests the credential effects through the shared seam", () => {
      assert.deepEqual(seam.observed.map((options) => options.operation), ["credential-effects"]);
    });
    await t.test("preserves the fixed administration request identity", () => {
      assert.deepEqual(server.requests.map((request) => request.requestId), [fixedRequestId]);
    });
    await t.test("returns the authenticated credential effects", () => {
      assert.deepEqual(observedEffects, effects);
    });
  } finally {
    server.close();
  }
});

test("a management exchange bounds each protocol phase at five seconds without resetting on progress", async (t) => {
  const seam = await managementSeam();
  const server = await companion((exchange) => authenticated(exchange, { body: health }));
  try {
    await seam.healthAt(server.endpoint, credential, seam.protocol);
    const { timing } = seam.observed[0];
    await t.test("bounds connection and challenge with one absolute deadline", () => {
      assert.equal(timing.connect.kind, "absolute");
    });
    await t.test("shares that deadline with the challenge phase", () => {
      assert.deepEqual(timing.challenge, timing.connect);
    });
    await t.test("bounds the request write for its own phase", () => {
      assert.deepEqual(timing.requestWrite, { kind: "phase", timeoutMs: 5000 });
    });
    await t.test("bounds the response for its own phase", () => {
      assert.deepEqual(timing.response, { kind: "phase", timeoutMs: 5000 });
    });
  } finally {
    server.close();
  }
});

test("a management exchange keeps authenticated non-success statuses without retrying", async (t) => {
  const seam = await managementSeam();
  const server = await companion((exchange) => authenticated(exchange, { status: "busy" }));
  try {
    const rejected = await seam.companionRequestAt(server.endpoint, credential, "credential-effects")
      .then(() => undefined, (error) => error);
    await t.test("reports the authenticated CLI status message", () => {
      assert.equal(rejected.message, "The companion rejected credential-effects with authenticated status busy.");
    });
    await t.test("exposes the authenticated status field", () => {
      assert.equal(rejected.status, "busy");
    });
    await t.test("opens exactly one management connection", () => {
      assert.equal(server.connections.length, 1);
    });
  } finally {
    server.close();
  }
});

test("a management exchange reports an authenticated protocol mismatch", async () => {
  const seam = await managementSeam();
  const server = await companion((exchange) => authenticated(exchange, {
    status: "version-mismatch", version: 2, body: { clientVersion: 3, companionVersion: 2 },
  }));
  try {
    const rejected = await seam.healthAt(server.endpoint, credential, seam.protocol)
      .then(() => undefined, (error) => error);
    assert.equal(
      rejected.message,
      "Authenticated protocol mismatch: Pi uses version 3; companion uses version 2.",
    );
  } finally {
    server.close();
  }
});

test("a management exchange rejects an invalid bridge credential before connecting", async (t) => {
  const seam = await managementSeam();
  const server = await companion((exchange) => authenticated(exchange, { body: health }));
  try {
    const rejected = await seam.healthAt(server.endpoint, { id: credential.id, secret: "not-base64" }, seam.protocol)
      .then(() => undefined, (error) => error);
    await t.test("preserves the credential ownership message", () => {
      assert.equal(rejected.message, "Refusing invalid bridge credential.");
    });
    await t.test("never reaches the shared seam", () => {
      assert.deepEqual(seam.observed, []);
    });
    await t.test("never opens a management connection", () => {
      assert.equal(server.connections.length, 0);
    });
  } finally {
    server.close();
  }
});

test("a management exchange rejects operation-specific health data outside the shared seam", async (t) => {
  const seam = await managementSeam();
  const server = await companion((exchange) => authenticated(exchange, {
    body: { permission: "unexpected", defaultInputAvailable: true },
  }));
  try {
    const rejected = await seam.healthAt(server.endpoint, credential, seam.protocol)
      .then(() => undefined, (error) => error);
    await t.test("preserves the invalid health data message", () => {
      assert.equal(rejected.message, "The companion returned invalid health data.");
    });
    await t.test("still authenticates the exchange through the shared seam", () => {
      assert.deepEqual(seam.observed.map((options) => options.operation), ["health"]);
    });
  } finally {
    server.close();
  }
});

const wireFaults = [
  {
    name: "an out-of-bounds response frame length",
    respond: () => framed(Buffer.from("x")),
    message: "The companion sent an invalid protocol frame.",
  },
  {
    name: "response bytes that are not strict JSON",
    respond: () => framed(Buffer.from("{\"type\":}")),
    message: "The companion sent malformed protocol data.",
  },
  {
    name: "an unexpected response shape",
    respond: () => frame({ type: "response" }),
    message: "The companion returned an invalid authenticated response.",
  },
  {
    name: "a noncanonical response payload encoding",
    respond: (exchange) => authenticated(exchange, { payload: Buffer.alloc(0) }),
    message: "The companion sent malformed authenticated protocol data.",
  },
  {
    name: "an authenticated payload that is not strict JSON",
    respond: (exchange) => authenticated(exchange, { payload: Buffer.from("{\"a\":1,\"a\":2}") }),
    message: "The companion sent malformed authenticated protocol data.",
  },
  {
    name: "a noncanonical response authentication tag encoding",
    respond: (exchange) => authenticated(exchange, { hmac: tag(["nothing"]).toString("hex").toUpperCase() }),
    message: "The companion sent malformed authenticated protocol data.",
  },
  {
    name: "an unauthenticated response",
    respond: (exchange) => authenticated(exchange, { hmac: Buffer.alloc(32).toString("hex") }),
    message: "The companion response could not be authenticated.",
  },
  {
    name: "an authenticated response with another protocol version",
    respond: (exchange) => authenticated(exchange, { version: 4 }),
    message: "The companion returned invalid authenticated version data.",
  },
  {
    name: "invalid authenticated version-mismatch data",
    respond: (exchange) => authenticated(exchange, {
      status: "version-mismatch", version: 2, body: { clientVersion: 3, companionVersion: 9 },
    }),
    message: "The companion returned invalid authenticated version data.",
  },
  {
    name: "trailing bytes after the response",
    respond: (exchange) => Buffer.concat([authenticated(exchange, { body: health }), Buffer.from("x")]),
    message: "The companion sent trailing protocol bytes.",
  },
  {
    name: "a closed connection before the response",
    respond: ({ socket }) => void socket.destroy(),
    message: "The companion closed an incomplete health response.",
  },
];

for (const fault of wireFaults) {
  test(`a management exchange preserves its diagnostic for ${fault.name}`, async () => {
    const seam = await managementSeam();
    const server = await companion(fault.respond);
    try {
      const rejected = await seam.healthAt(server.endpoint, credential, seam.protocol)
        .then(() => undefined, (error) => error);
      assert.equal(rejected.message, fault.message);
    } finally {
      server.close();
    }
  });
}

const challengeFaults = [
  {
    name: "an unexpected authentication challenge",
    challengeBytes: () => frame({ type: "hello", challenge: "" }),
    message: "The companion sent an invalid authentication challenge.",
  },
  {
    name: "a noncanonical challenge encoding",
    challengeBytes: () => frame({ type: "challenge", challenge: "not-base64" }),
    message: "The companion sent malformed authenticated protocol data.",
  },
  {
    name: "trailing bytes after the challenge",
    challengeBytes: (challenge) => Buffer.concat([
      frame({ type: "challenge", challenge: challenge.toString("base64") }), Buffer.from("x"),
    ]),
    message: "The companion sent trailing protocol bytes.",
  },
];

for (const fault of challengeFaults) {
  test(`a management exchange preserves its diagnostic for ${fault.name}`, async () => {
    const seam = await managementSeam();
    const server = await companion((exchange) => authenticated(exchange, { body: health }), fault.challengeBytes);
    try {
      const rejected = await seam.healthAt(server.endpoint, credential, seam.protocol)
        .then(() => undefined, (error) => error);
      assert.equal(rejected.message, fault.message);
    } finally {
      server.close();
    }
  });
}

test("a management exchange reports an unavailable companion socket", async () => {
  const seam = await managementSeam();
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-management-"));
  try {
    const rejected = await seam
      .healthAt({ type: "unix", path: join(directory, "missing.sock") }, credential, seam.protocol)
      .then(() => undefined, (error) => error);
    assert.equal(rejected.message, "The companion Unix socket is unavailable.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const [kind, stage] of [["deadline", "response"], ["cancelled", "challenge"]]) {
  test(`a management exchange reports its timeout diagnostic for a ${kind} failure`, async () => {
    const seam = await managementSeam();
    const rejected = await seam
      .healthAt({ type: "unix", path: "/nonexistent.sock" }, credential, {
        request() { return Promise.reject(new seam.shared.BridgeProtocolFailure(kind, stage)); },
      })
      .then(() => undefined, (error) => error);
    assert.equal(rejected.message, "Authenticated health request timed out.");
  });
}
