import {
  BridgeProtocolFailure,
  request,
  withStream,
  type BridgeProtocolResponse,
  type BridgeProtocolStreamResponse,
  type JsonObject,
} from "../lib/bridge-protocol.mjs";

const payload: JsonObject = { probe: [true, null, 3] };
const pending: Promise<BridgeProtocolResponse> = request({
  endpoint: { type: "unix", path: "/private/listener.sock" },
  credential: { id: "77777777-7777-4777-8777-777777777777", secret: new Uint8Array(32) },
  requestId: "88888888-8888-4888-8888-888888888888",
  operation: "health",
  payload,
  timing: {
    connect: { kind: "absolute", at: Date.now() + 1000 },
    challenge: { kind: "no-progress", timeoutMs: 1000 },
    requestWrite: { kind: "no-progress", timeoutMs: 1000 },
    response: { kind: "absolute", at: Date.now() + 1000 },
  },
  signal: new AbortController().signal,
});

const streamBase = {
  endpoint: { type: "tcp" as const, host: "127.0.0.1", port: 12121 },
  credential: { id: "77777777-7777-4777-8777-777777777777", secret: new Uint8Array(32) },
  requestId: "88888888-8888-4888-8888-888888888888",
  operation: "stream",
  payload,
  timing: {
    connect: { kind: "absolute" as const, at: Date.now() + 1000 },
    challenge: { kind: "no-progress" as const, timeoutMs: 1000 },
    requestWrite: { kind: "no-progress" as const, timeoutMs: 1000 },
    response: { kind: "absolute" as const, at: Date.now() + 1000 },
    stream: { kind: "no-progress" as const, timeoutMs: 1000 },
    end: { kind: "absolute" as const, at: Date.now() + 1000 },
  },
  signal: new AbortController().signal,
};
const binary: Promise<BridgeProtocolStreamResponse<number>> = withStream(
  { ...streamBase, kind: "binary" },
  async ({ metadata, bytes }) => {
    for await (const chunk of bytes.readExactly(3)) void chunk;
    void metadata;
    return 3;
  },
);
const frames: Promise<BridgeProtocolStreamResponse<void>> = withStream(
  { ...streamBase, kind: "authenticated-frames" },
  async ({ metadata, frames: payloads }) => {
    for await (const framePayload of payloads) void framePayload;
    void metadata;
  },
);

void pending;
void binary;
void frames;
void new BridgeProtocolFailure("transport", "connect");
