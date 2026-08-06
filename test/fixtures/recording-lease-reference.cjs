const { createHash } = require("node:crypto");

class RecordingLeaseReference {
  constructor() {
    this.leases = new Map();
    this.activeId = undefined;
    this.requests = new Map();
  }

  apply(owner, requestId, operation, payload, options = {}) {
    const requestKey = `${owner}:${requestId}`;
    const content = createHash("sha256").update(operation).update("\0").update(JSON.stringify(payload)).digest("hex");
    const previous = this.requests.get(requestKey);
    if (previous && previous.content !== content) return { status: "request-conflict" };
    if (previous?.outcome) return previous.outcome;
    this.requests.set(requestKey, { content });
    if (operation === "start") {
      const outcome = this.start(owner, payload, options);
      if (outcome.status === "busy") this.requests.get(requestKey).outcome = outcome;
      return outcome;
    }
    const lease = this.leases.get(payload.recordingId);
    if (!lease || lease.owner !== owner || lease.secret !== payload.leaseSecret) return { status: "not-found" };
    if (operation === "status") return this.ok(lease);
    if (operation === "levels") return lease.state === "recording" ? this.ok(lease) : { status: "invalid-state" };
    if (operation === "stop") {
      if (lease.state === "recording") { lease.state = "result-ready"; this.activeId = undefined; }
      return lease.state === "result-ready" ? this.ok(lease) : { status: "invalid-state" };
    }
    if (operation === "fetch") return lease.state === "result-ready" ? this.ok(lease) : { status: "invalid-state" };
    if (operation === "cancel") {
      if (["recording", "finalizing", "result-ready"].includes(lease.state)) {
        lease.state = "cancelled"; if (this.activeId === lease.id) this.activeId = undefined;
      }
      return lease.state === "cancelled" ? this.ok(lease) : { status: "invalid-state" };
    }
    if (operation === "acknowledge") {
      if (lease.state === "result-ready") lease.state = "acknowledged";
      return lease.state === "acknowledged" ? this.ok(lease) : { status: "invalid-state" };
    }
    return { status: "failed" };
  }

  start(owner, payload, options) {
    const existing = this.leases.get(payload.recordingId);
    if (existing) {
      if (existing.owner !== owner || existing.secret !== payload.leaseSecret) return { status: "not-found" };
      return this.ok(existing);
    }
    if (this.activeId) return { status: "busy" };
    if (options.reservable === false) return { status: "failed" };
    const lease = { id: payload.recordingId, owner, secret: payload.leaseSecret, state: "recording" };
    this.leases.set(lease.id, lease); this.activeId = lease.id;
    return this.ok(lease);
  }

  force(recordingId, state) {
    const lease = this.leases.get(recordingId);
    lease.state = state;
    if (!["recording", "finalizing"].includes(state) && this.activeId === recordingId) this.activeId = undefined;
  }

  ok(lease) { return { status: "ok", state: lease.state }; }
}

module.exports = { RecordingLeaseReference };
