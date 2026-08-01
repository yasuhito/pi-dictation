import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const testDir = resolve("test");
const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.cjs"))
  .map((name) => join(testDir, name));
const violations = [];

function isAssertCall(node) {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "assert";
}

for (const file of testFiles) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );

  function inspect(node) {
    if (ts.isFunctionLike(node) && node.body) {
      let assertionCount = 0;
      function countDirectAssertions(child) {
        if (child !== node && ts.isFunctionLike(child)) return;
        if (isAssertCall(child)) assertionCount++;
        ts.forEachChild(child, countDirectAssertions);
      }
      countDirectAssertions(node.body);
      if (assertionCount > 1) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(`${file}:${line + 1} contains ${assertionCount} assertions in one function`);
      }
    }
    ts.forEachChild(node, inspect);
  }

  inspect(source);
}

if (violations.length > 0) {
  console.error("Each test case or named subtest may contain at most one assertion:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${testFiles.length} test files: at most one assertion per test function.`);
}
