#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import ts from "typescript";

const manifestPath = resolve(
  process.argv[2] ?? resolve(process.cwd(), "strict-migration.json")
);
const projectRoot = dirname(manifestPath);

function fail(message) {
  throw new Error(message);
}

function readManifest() {
  const value = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.modules) ||
    value.modules.length === 0 ||
    !Array.isArray(value.typeFixtures) ||
    !Array.isArray(value.invalidTypeFixtures)
  ) {
    fail("The strict migration manifest has an invalid shape.");
  }
  return value;
}

function governedPath(path) {
  if (typeof path !== "string" || isAbsolute(path) || !path.endsWith(".ts")) {
    fail(`Invalid governed path: ${String(path)}`);
  }
  const absolute = resolve(projectRoot, path);
  const fromRoot = relative(projectRoot, absolute);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    fail(`Governed path escapes the manifest root: ${path}`);
  }
  return absolute;
}

function sourceAt(path) {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function location(source, position) {
  const { line, character } = source.getLineAndCharacterOfPosition(position);
  return `${relative(projectRoot, source.fileName)}:${line + 1}:${character + 1}`;
}

function checkForBypasses(paths) {
  for (const path of paths) {
    const source = sourceAt(path);
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      ts.LanguageVariant.Standard,
      source.text
    );
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      if (
        (token === ts.SyntaxKind.SingleLineCommentTrivia ||
          token === ts.SyntaxKind.MultiLineCommentTrivia) &&
        /@ts-(?:ignore|nocheck|expect-error)\b/i.test(scanner.getTokenText())
      ) {
        fail(
          `${location(source, scanner.getTokenPos())}: forbidden TypeScript suppression`
        );
      }
    }

    function visit(node) {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        fail(
          `${location(source, node.getStart(source))}: explicit \`any\` is forbidden`
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}

function projectCompilerOptions() {
  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists);
  if (!configPath) {
    return {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
    };
  }
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) fail(formatDiagnostics([loaded.error]));
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath
  );
  if (parsed.errors.length > 0) fail(formatDiagnostics(parsed.errors));
  return parsed.options;
}

const compilerOptions = {
  ...projectCompilerOptions(),
  strict: true,
  noEmit: true,
};

function errorsFor(rootNames, options = compilerOptions) {
  const program = ts.createProgram({ rootNames, options });
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
    );
  return { program, diagnostics };
}

function formatDiagnostics(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (path) => path,
    getCurrentDirectory: () => projectRoot,
    getNewLine: () => "\n",
  });
}

function checkDependencyClosure(program, modules, fixtures) {
  const allowed = new Set(
    [...modules, ...fixtures].map((path) => resolve(path))
  );
  for (const source of program.getSourceFiles()) {
    const path = resolve(source.fileName);
    const fromRoot = relative(projectRoot, path);
    const insideProject = fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
    if (
      insideProject &&
      !source.isDeclarationFile &&
      !path.split(sep).includes("node_modules") &&
      !allowed.has(path)
    ) {
      fail(
        `${fromRoot} is a source dependency outside the migrated-module manifest.`
      );
    }
  }
}

function checkDeclarations(modules) {
  const declarations = new Map();
  const options = {
    ...compilerOptions,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const program = ts.createProgram({ rootNames: modules, options });
  const emit = program.emit(undefined, (path, contents) => {
    if (path.endsWith(".d.ts")) declarations.set(path, contents);
  });
  const diagnostics = [
    ...ts.getPreEmitDiagnostics(program),
    ...emit.diagnostics,
  ].filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length > 0) fail(formatDiagnostics(diagnostics));

  for (const [path, contents] of declarations) {
    const source = ts.createSourceFile(
      path,
      contents,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    function visit(node) {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        fail(
          `${relative(projectRoot, path)}:${
            source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          }: declaration contains \`any\``
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}

function checkInvalidFixture(fixture, modules) {
  if (
    !fixture ||
    typeof fixture !== "object" ||
    !Array.isArray(fixture.expectedDiagnostics) ||
    fixture.expectedDiagnostics.length === 0 ||
    !fixture.expectedDiagnostics.every(Number.isInteger)
  ) {
    fail("An invalid type fixture has an invalid shape.");
  }
  const path = governedPath(fixture.path);
  const { program, diagnostics } = errorsFor([...modules, path]);
  checkDependencyClosure(program, modules, [path]);
  if (diagnostics.length === 0) {
    fail(
      `${relative(projectRoot, path)} compiled successfully; expected compiler failure.`
    );
  }
  if (
    diagnostics.some((diagnostic) =>
      /implicit.*\bany\b/i.test(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
      )
    )
  ) {
    fail(`${relative(projectRoot, path)}: implicit \`any\` is forbidden.`);
  }
  const actual = diagnostics
    .map(({ code }) => code)
    .sort((left, right) => left - right);
  const expected = [...fixture.expectedDiagnostics].sort(
    (left, right) => left - right
  );
  if (actual.join(",") !== expected.join(",")) {
    fail(
      `${relative(projectRoot, path)}: expected diagnostics ${expected.join(", ")}, received ${actual.join(", ")}`
    );
  }
}

try {
  const manifest = readManifest();
  const modules = manifest.modules.map(governedPath);
  const fixtures = manifest.typeFixtures.map(governedPath);
  const invalidFixturePaths = manifest.invalidTypeFixtures.map(({ path }) =>
    governedPath(path)
  );
  checkForBypasses([...modules, ...fixtures, ...invalidFixturePaths]);

  const strict = errorsFor([...modules, ...fixtures]);
  if (strict.diagnostics.length > 0)
    fail(formatDiagnostics(strict.diagnostics));
  checkDependencyClosure(strict.program, modules, fixtures);
  checkDeclarations(modules);
  for (const fixture of manifest.invalidTypeFixtures) {
    checkInvalidFixture(fixture, modules);
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
