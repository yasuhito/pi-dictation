const { resolve } = require("node:path");
const { createJiti } = require("jiti");

const packageRoot = resolve(__dirname, "..", "..");
const extensionPath = resolve(packageRoot, "extensions", "pi-dictation.ts");
const jiti = createJiti(__filename, { interopDefault: true });

async function main() {
  const extension = await jiti.import(extensionPath, { default: true });
  let shortcut;
  extension({
    registerShortcut(_key, definition) {
      shortcut = definition.handler;
    },
    registerCommand() {},
    on() {},
  });

  await shortcut({
    mode: "tui",
    cwd: packageRoot,
    ui: {
      notify() {},
      pasteToEditor() {},
      setStatus() {},
    },
  });

  setInterval(() => {}, 1000);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
