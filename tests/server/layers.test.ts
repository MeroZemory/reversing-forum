import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../src/", import.meta.url));
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? files(path)
      : /\.tsx?$/.test(path)
        ? [path]
        : [];
  });
}
function name(path: string) {
  return relative(root, path).replaceAll("\\", "/");
}
const sourceFiles = new Map(
  files(root).map((path) => [
    path,
    ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    ),
  ]),
);
function imports(source: ts.SourceFile) {
  const result: string[] = [];
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      result.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0])
    )
      result.push(node.arguments[0].text);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      result.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}
function localImport(path: string, specifier: string) {
  if (!specifier.startsWith("@/") && !specifier.startsWith(".")) return null;
  const base = specifier.startsWith("@/")
    ? resolve(root, specifier.slice(2))
    : resolve(dirname(path), specifier);
  return (
    [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      resolve(base, "index.ts"),
      resolve(base, "index.tsx"),
    ].find(
      (candidate) => existsSync(candidate) && sourceFiles.has(candidate),
    ) ?? null
  );
}
function dependencyViolations(
  directory: string,
  forbidden: (specifier: string, dependency: string | null) => boolean,
) {
  const violations: string[] = [];
  for (const start of files(resolve(root, directory))) {
    const visited = new Set<string>();
    function inspect(path: string, chain: string[]) {
      if (visited.has(path)) return;
      visited.add(path);
      for (const specifier of imports(sourceFiles.get(path)!)) {
        const target = localImport(path, specifier);
        if (forbidden(specifier, target ? name(target) : null))
          violations.push(
            [...chain, target ? name(target) : specifier].join(" -> "),
          );
        else if (target) inspect(target, [...chain, name(target)]);
      }
    }
    inspect(start, [name(start)]);
  }
  return violations;
}

describe("data and presentation dependency rules", () => {
  it("keeps rendering components free of data, features, credentials and server dependencies, including indirect imports", () => {
    expect(
      dependencyViolations(
        "components",
        (specifier, dependency) =>
          /^(server|client|features|app)\//.test(dependency ?? "") ||
          dependency === "lib/auth-client.ts" ||
          /^(node:|better-auth|better-sqlite3|server-only$|next\/(headers|server|cache)$)/.test(
            specifier,
          ),
      ),
    ).toEqual([]);
  });
  it("keeps rendering code free of network calls, environment reads and business-draft persistence", () => {
    const violations: string[] = [];
    for (const path of files(resolve(root, "components"))) {
      function visit(node: ts.Node) {
        if (
          ts.isCallExpression(node) &&
          /^(fetch|globalThis\.fetch|window\.fetch)$/.test(
            node.expression.getText(),
          )
        )
          violations.push(`${name(path)}: network call`);
        if (
          ts.isPropertyAccessExpression(node) &&
          node.getText() === "process.env"
        )
          violations.push(`${name(path)}: environment access`);
        if (
          ts.isStringLiteralLike(node) &&
          /reversing-all:(draft|comment|resume-reply):/.test(node.text)
        )
          violations.push(`${name(path)}: business draft key`);
        ts.forEachChild(node, visit);
      }
      visit(sourceFiles.get(path)!);
    }
    expect(violations).toEqual([]);
  });
  it("keeps server services independent of screens and browser behavior", () => {
    expect(
      dependencyViolations("server", (_specifier, dependency) =>
        /^(components|features|client|app)\//.test(dependency ?? ""),
      ),
    ).toEqual([]);
  });
  it("keeps screen contracts independent of concrete transport and rendering implementations", () => {
    expect(
      dependencyViolations(
        "contracts",
        (specifier, dependency) =>
          /^(server|client|features|components|app)\//.test(dependency ?? "") ||
          /^(node:|better-auth|better-sqlite3|next\/)/.test(specifier),
      ),
    ).toEqual([]);
  });
});
