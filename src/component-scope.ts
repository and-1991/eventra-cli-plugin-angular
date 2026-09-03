import fs from "node:fs";

import ts from "typescript";

export interface ComponentScope {
  /** The sibling `.ts` file's raw source. */
  readonly content: string;
  /** Offset of the matched component class's closing `}`, or `null` if no class was found at all. */
  readonly classEndOffset: number | null;
}

function hasComponentDecorator(node: ts.ClassDeclaration): boolean {
  // A ts.ClassDeclaration can always carry decorators structurally, so
  // ts.getDecorators (which requires a HasDecorators-narrowed node) never
  // needs the ts.canHaveDecorators guard here - unlike a node whose kind is
  // unknown at the call site.
  return (ts.getDecorators(node) ?? []).some((decorator) => {
    const expression = decorator.expression;
    return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === "Component";
  });
}

/**
 * Finds the class this template belongs to: the (first) class decorated with
 * `@Component`, falling back to the file's first class declaration if none
 * carries that exact decorator (e.g. an aliased `Component` import). Returns
 * the offset of its closing `}` so a synthetic method can be spliced in right
 * before it - `null` when the file has no class at all.
 */
function findComponentClassEnd(content: string, fileName: string): number | null {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  let decoratedClass: ts.ClassDeclaration | null = null;
  let firstClass: ts.ClassDeclaration | null = null;

  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement)) {
      continue;
    }
    if (!firstClass) {
      firstClass = statement;
    }
    if (hasComponentDecorator(statement)) {
      decoratedClass = statement;
      break;
    }
  }

  const target = decoratedClass ?? firstClass;
  return target ? target.end - 1 : null;
}

/**
 * Angular CLI's default schematic pairs `foo.component.html` with
 * `foo.component.ts` in the same directory - swap the extension and read it
 * from disk (mirrors `@eventra_dev/cli-plugin-vue`'s `readSrcFile` for
 * `<script src="...">`/`<template src="...">`, same "best effort, null on
 * failure" contract). Any other pairing convention (a `templateUrl` pointing
 * somewhere else, or a `.html` file with no component at all) falls back to
 * `null` - dynamic bindings still get reported, just never resolved to a
 * literal, since there is no `this`-scope to check them against.
 */
export function readComponentScope(htmlPath: string): ComponentScope | null {
  const tsPath = htmlPath.replace(/\.html$/i, ".ts");
  if (tsPath === htmlPath) {
    return null;
  }
  let content: string;
  try {
    content = fs.readFileSync(tsPath, "utf8");
  } catch {
    return null;
  }
  return { content, classEndOffset: findComponentClassEnd(content, tsPath) };
}
