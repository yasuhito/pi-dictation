import type { AuthenticatedFrameStreamRequest } from "../../src/lib/bridge-protocol.js";

const request: AuthenticatedFrameStreamRequest = {
  endpoint: { type: "tcp", host: "127.0.0.1", port: 12121 },
  credential: {
    id: "77777777-7777-4777-8777-777777777777",
    secret: new Uint8Array(32),
  },
  requestId: "88888888-8888-4888-8888-888888888888",
  operation: "levels",
  payload: {},
  timing: {
    connect: { kind: "absolute", at: Date.now() + 1000 },
    challenge: { kind: "no-progress", timeoutMs: 1000 },
    requestWrite: { kind: "phase", timeoutMs: 1000 },
    response: { kind: "phase", timeoutMs: 1000 },
    stream: { kind: "no-progress", timeoutMs: 1000 },
    end: { kind: "phase", timeoutMs: 1000 },
  },
  signal: new AbortController().signal,
  kind: "binary",
};

void request;
