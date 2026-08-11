const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, rmSync, statSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const modulePromise = import("../bin/bounded-log.mjs");

test("bounded bridge logs rotate, aggregate, and redact", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-dictation-log-"));
  try {
    const path = join(directory, "tunnel.log");
    const { createBoundedLogger } = await modulePromise;
    const logger = createBoundedLogger(path, "tunnel");
    const secret = "01234567890123456789012345678901234567890123=";
    logger.event("same-error", { stage: secret });
    for (let index = 0; index < 5; index += 1) logger.event("same-error", { stage: secret });
    logger.event("different", { stage: "probe" });
    const aggregated = readFileSync(path, "utf8").includes('"code":"repeated"');
    for (let index = 0; index < 60000; index += 1) {
      logger.event(index % 2 ? "load-a" : "load-b", { stage: "probe", retry: index });
    }
    logger.close();
    const files = [path, `${path}.1`, `${path}.2`].filter(existsSync);
    const contents = files.map((file) => readFileSync(file, "utf8")).join("");
    await t.test("keeps exactly three generations", () => assert.equal(files.length, 3));
    await t.test("keeps every generation at or below one MiB", () => assert.equal(files.every((file) => statSync(file).size <= 1024 * 1024), true));
    await t.test("redacts rejected field values", () => assert.equal(contents.includes(secret), false));
    await t.test("aggregates consecutive repeated events", () => assert.equal(aggregated, true));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
