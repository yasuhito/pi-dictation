import type { BridgeProtocolRequest } from "../../src/lib/bridge-protocol.js";

const request: BridgeProtocolRequest = {
  endpoint: { type: "unix", path: "/private/listener.sock" },
  credential: {
    id: "77777777-7777-4777-8777-777777777777",
    secret: new Uint8Array(32),
  },
  requestId: "88888888-8888-4888-8888-888888888888",
  operation: "health",
  payload: {},
  timing: {
    connect: { kind: "phase", timeoutMs: 1000 },
    challenge: { kind: "phase", timeoutMs: 1000 },
    requestWrite: { kind: "phase", timeoutMs: 1000 },
  },
  signal: new AbortController().signal,
};

void request;
