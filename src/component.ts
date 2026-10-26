import path from "node:path";
import fs from "node:fs";

import ts from "typescript";

import { findComponentClass } from "./component-scope";

/** A component input: `@Input() track`, `@Input() set track(v)`, `track = input<string>()`. */
export interface ComponentInput {
  /** The class member's name, which the class body reads as `this.<local>` (or `this.<local>()` for a signal). */
  readonly local: string;
  /** The name a parent binds it by: the `@Input("alias")` / `{ alias }` if given, else the member name. */
  readonly publicName: string;
  readonly signal: boolean;
  /** `@Input() set track(v) { ... }`: the setter body runs with the bound value. */
  readonly setter: ts.SetAccessorDeclaration | null;
}

export interface ComponentInfo {
  readonly className: string;
  readonly selector: string | null;
  readonly templateUrl: string | null;
  readonly inputs: readonly ComponentInput[];
}

const isStatic = (member: ts.ClassElement): boolean => (ts.getCombinedModifierFlags(member as ts.Declaration) & ts.ModifierFlags.Static) !== 0;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const SIGNAL_INPUT_FUNCTIONS = new Set(["input", "model"]);

/** The name under which a module exports its component class, for a parent's template to import. */
export const COMPONENT_EXPORT = "__eventraAngularComponent";

function stringValue(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

function objectProperty(object: ts.Expression | undefined, name: string): ts.Expression | undefined {
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === name) return property.initializer;
  }
  return undefined;
}

function componentMetadata(node: ts.ClassDeclaration): ts.Expression | undefined {
  for (const decorator of ts.getDecorators(node) ?? []) {
    const call = decorator.expression;
    if (ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "Component") return call.arguments[0];
  }
  return undefined;
}

/** `input<T>()` / `input.required<T>()` / `model<T>()`, with the alias from its options when it has one. */
function signalInputAlias(initializer: ts.Expression | undefined): { alias: string | null } | null {
  if (!initializer || !ts.isCallExpression(initializer)) return null;
  const callee = initializer.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && callee.name.text === "required" && ts.isIdentifier(callee.expression) ? callee.expression.text : null;
  if (!name || !SIGNAL_INPUT_FUNCTIONS.has(name)) return null;
  for (const argument of initializer.arguments) {
    const alias = stringValue(objectProperty(argument, "alias"));
    if (alias) return { alias };
  }
  return { alias: null };
}

function decoratorInputAlias(member: ts.ClassElement): { alias: string | null } | null {
  for (const decorator of ts.getDecorators(member as ts.HasDecorators) ?? []) {
    const call = decorator.expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "Input") continue;
    const first = call.arguments[0];
    return { alias: stringValue(first) ?? stringValue(objectProperty(first, "alias")) };
  }
  return null;
}

/** The component this class declares: selector, template file and the inputs a parent can bind. */
export function readComponentInfo(content: string, fileName: string): ComponentInfo | null {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const node = findComponentClass(sourceFile);
  return node?.name ? describeClass(node) : null;
}

function describeClass(node: ts.ClassDeclaration): ComponentInfo {
  const metadata = componentMetadata(node);
  const inputs: ComponentInput[] = [];
  for (const member of node.members) {
    if (isStatic(member) || !member.name || !ts.isIdentifier(member.name)) continue;
    const local = member.name.text;
    if (ts.isPropertyDeclaration(member)) {
      const found = decoratorInputAlias(member) ?? signalInputAlias(member.initializer);
      if (found) inputs.push({ local, publicName: found.alias ?? local, signal: !decoratorInputAlias(member), setter: null });
    } else if (ts.isSetAccessorDeclaration(member)) {
      const found = decoratorInputAlias(member);
      if (found) inputs.push({ local, publicName: found.alias ?? local, signal: false, setter: member });
    }
  }
  return {
    className: node.name!.text,
    selector: stringValue(objectProperty(metadata, "selector")),
    templateUrl: stringValue(objectProperty(metadata, "templateUrl")),
    inputs: inputs.filter((input) => IDENTIFIER.test(input.local) && IDENTIFIER.test(input.publicName)),
  };
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** `this.track` -> `track`, and `this.track()` -> `track` for a signal input, inside one class member. */
function inputEdits(root: ts.Node, inputs: ReadonlyMap<string, ComponentInput>): Edit[] {
  const edits: Edit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length === 0 && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const input = inputs.get(node.expression.name.text);
      if (input?.signal) {
        edits.push({ start: node.getStart(), end: node.end, text: input.local });
        return;
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const input = inputs.get(node.name.text);
      if (input && !input.signal) {
        edits.push({ start: node.getStart(), end: node.end, text: input.local });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return edits;
}

function rewritten(sourceText: string, node: ts.Node, edits: readonly Edit[]): string {
  let text = sourceText.slice(node.getStart(), node.end);
  const base = node.getStart();
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start - base) + edit.text + text.slice(edit.end - base);
  }
  return text;
}

/**
 * The component as a method taking its inputs: `Name({ track, label }: any) { ... }`, declared in the class
 * itself so `this.tracker` keeps its type. Every method of the class is copied into it as an arrow function
 * statement with `this.track` replaced by the `track` parameter, so a call to a tracking function that
 * reads an input is a function parameter flowing into a track() call, which the compiler already follows.
 * Returns null when the component has no inputs.
 */
export function buildComponentMethod(content: string, fileName: string): { readonly name: string; readonly method: string } | null {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const node = findComponentClass(sourceFile);
  if (!node?.name) return null;
  const info = describeClass(node);
  if (info.inputs.length === 0) return null;
  const byLocal = new Map(info.inputs.map((input) => [input.local, input]));

  const statements: string[] = [];
  for (const member of node.members) {
    if (isStatic(member)) continue;
    if (ts.isMethodDeclaration(member) && member.body && !member.asteriskToken && ts.isIdentifier(member.name)) {
      const typeParameters = member.typeParameters ? `<${member.typeParameters.map((parameter) => parameter.getText()).join(", ")}>` : "";
      const parameters = member.parameters.map((parameter) => parameter.getText()).join(", ");
      const isAsync = member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ? "async " : "";
      statements.push(`(${isAsync}${typeParameters}(${parameters}) => ${rewritten(content, member.body, inputEdits(member.body, byLocal))});`);
    } else if (ts.isPropertyDeclaration(member) && member.initializer && ts.isArrowFunction(member.initializer)) {
      statements.push(`(${rewritten(content, member.initializer, inputEdits(member.initializer, byLocal))});`);
    } else if (ts.isSetAccessorDeclaration(member) && member.body) {
      const input = byLocal.get(member.name.getText());
      // the setter of an input runs with the bound value: its parameter is that input
      const parameter = member.parameters[0];
      if (input?.setter === member && parameter && ts.isIdentifier(parameter.name)) {
        statements.push(`{ const ${parameter.name.text}: any = ${input.local}; ${rewritten(content, member.body, inputEdits(member.body, byLocal)).slice(1)}`);
      }
    }
  }

  const keys = info.inputs.map((input) => (input.publicName === input.local ? input.local : `${input.publicName}: ${input.local}`));
  const isAsync = statements.some((statement) => /\bawait\b/.test(statement)) ? "async " : "";
  const method = [`  ${isAsync}${info.className}({ ${keys.join(", ")} }: any) {`, ...statements.map((statement) => `    ${statement}`), "  }"].join("\n");
  return { name: info.className, method };
}

/** A child component a template can use: its description, and where the module holding its function is. */
export interface ChildComponent {
  readonly info: ComponentInfo;
  /** Absolute path of the child's template (`.html`), whose virtual module holds the component function. */
  readonly templatePath: string;
}

/** Whether an element (its tag and the attribute names on it) is what a component selector like `app-x`, `[appX]` or `b[appX]` picks. */
export function matchesSelector(selector: string, tag: string, attributes: ReadonlySet<string>): boolean {
  return selector.split(",").some((part) => {
    const match = /^\s*([A-Za-z][\w-]*)?(?:\[([\w-]+)\])?\s*$/.exec(part);
    if (!match || (!match[1] && !match[2])) return false;
    return (!match[1] || match[1] === tag) && (!match[2] || attributes.has(match[2]));
  });
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The `.ts` files a component's imports point at (`./x`, `../y/z`) plus its neighbours in the same folder. */
function candidateFiles(tsPath: string, content: string): string[] {
  const dir = path.dirname(tsPath);
  const found = new Set<string>();
  const sourceFile = ts.createSourceFile(tsPath, content, ts.ScriptTarget.Latest);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith(".")) continue;
    const target = path.resolve(dir, statement.moduleSpecifier.text);
    found.add(`${target}.ts`);
    found.add(path.join(target, "index.ts"));
  }
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith(".spec.ts")) found.add(path.join(dir, entry));
    }
  } catch {
    // an unreadable folder has no neighbours
  }
  found.delete(tsPath);
  return [...found];
}

/**
 * The components a template may use, found among the files its own component imports and the files beside it.
 * Only a component with a `templateUrl` and at least one input counts: its template's virtual module is what
 * holds the component function a call can be resolved to.
 */
export function findChildComponents(htmlPath: string, componentContent: string): ChildComponent[] {
  const tsPath = htmlPath.replace(/\.html$/i, ".ts");
  const children: ChildComponent[] = [];
  for (const file of candidateFiles(tsPath, componentContent)) {
    const content = readIfExists(file);
    if (content === null || !content.includes("@Component")) continue;
    const info = readComponentInfo(content, file);
    if (!info?.selector || !info.templateUrl || info.inputs.length === 0) continue;
    children.push({ info, templatePath: path.resolve(path.dirname(file), info.templateUrl) });
  }
  return children;
}
