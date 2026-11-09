import path from "node:path";
import fs from "node:fs";

import ts from "typescript";

import { componentClasses, componentDecoratorNames, findComponentClass } from "./component-scope";

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
  /** The text of `template: "..."` / `` template: `...` `` when it has no `${}` in it, else null. */
  readonly inlineTemplate: string | null;
  readonly inputs: readonly ComponentInput[];
}

const isStatic = (member: ts.ClassElement): boolean => (ts.getCombinedModifierFlags(member as ts.Declaration) & ts.ModifierFlags.Static) !== 0;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const SIGNAL_INPUT_FUNCTIONS = new Set(["input", "model"]);

/** The name under which a module exports its component class, for a parent's template to import. */
export const COMPONENT_EXPORT = "__eventraAngularComponent";

/** A file with several components exports the first as `COMPONENT_EXPORT`, the others under a numbered name. */
export function componentExportName(index: number): string {
  return index === 0 ? COMPONENT_EXPORT : `${COMPONENT_EXPORT}${index}`;
}

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
  const names = componentDecoratorNames(node.getSourceFile());
  for (const decorator of ts.getDecorators(node) ?? []) {
    const call = decorator.expression;
    if (ts.isCallExpression(call) && ts.isIdentifier(call.expression) && names.has(call.expression.text)) return call.arguments[0];
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
export function readComponentInfo(content: string, fileName: string, index = 0): ComponentInfo | null {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const node = findComponentClass(sourceFile, index);
  return node?.name ? describeClass(node) : null;
}

/** Every component a file declares, in source order (a file with none decorated reads as its first class, like `readComponentInfo`). */
export function readComponentInfos(content: string, fileName: string): ComponentInfo[] {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const decorated = componentClasses(sourceFile);
  if (decorated.length === 0) {
    const only = findComponentClass(sourceFile);
    return only?.name ? [describeClass(only)] : [];
  }
  return decorated.filter((node) => node.name).map(describeClass);
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
    inlineTemplate: stringValue(objectProperty(metadata, "template")),
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
export function buildComponentMethod(content: string, fileName: string, index = 0): { readonly name: string; readonly method: string } | null {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const node = findComponentClass(sourceFile, index);
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
  /** The name the module of `templatePath` exports this component's class under. */
  readonly exportName: string;
}

/** Whether an element (its tag and the attribute names on it) is what a component selector like `app-x`, `[appX]` or `b[appX]` picks. */
export function matchesSelector(selector: string, tag: string, attributes: ReadonlySet<string>): boolean {
  return selector.split(",").some((part) => {
    const match = /^\s*([A-Za-z][\w-]*)?(?:\[([\w-]+)\])?\s*$/.exec(part);
    if (!match || (!match[1] && !match[2])) return false;
    return (!match[1] || match[1] === tag) && (!match[2] || attributes.has(match[2]));
  });
}

interface CachedComponentFile {
  readonly mtimeMs: number;
  readonly size: number;
  readonly infos: readonly ComponentInfo[];
}

// Every template looks at the `.ts` files beside it for components it may use. With a thousand components in one
// folder that was a thousand reads and parses of a thousand files (40 s). A file is read and parsed again only
// when its size or modification time changes, which also keeps `watch` right after an edit.
const componentFileCache = new Map<string, CachedComponentFile>();

/** The components a `.ts` file declares (none when it declares none), or null when it cannot be read. */
function componentsOfFile(file: string): readonly ComponentInfo[] | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    componentFileCache.delete(file);
    return null;
  }
  const cached = componentFileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.infos;
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    componentFileCache.delete(file);
    return null;
  }
  const hasComponent = content.includes("@Component") || /\bComponent\s+as\s+[A-Za-z_$]/.test(content);
  const infos = hasComponent ? readComponentInfos(content, file) : [];
  componentFileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, infos });
  return infos;
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
 * Only a component with a template (a `templateUrl`, or an inline `template`) and at least one input counts:
 * its template's virtual module is what holds the component function a call can be resolved to.
 */
export function findChildComponents(
  htmlPath: string,
  componentContent: string,
  tsPath: string = htmlPath.replace(/\.html$/i, ".ts"),
  selfClassName?: string,
): ChildComponent[] {
  const children: ChildComponent[] = [];
  const consider = (file: string, infos: readonly ComponentInfo[] | null): void => {
    // a file may declare several components; each is a candidate under its own export name
    (infos ?? []).forEach((info, index) => {
      if (!info.selector || info.inputs.length === 0 || info.className === selfClassName) return;
      // a component with an inline template keeps its component function in its own file's module; one with a
      // template file keeps it in that file's module, which exports it under the one name whatever its class
      if (info.templateUrl) children.push({ info, templatePath: path.resolve(path.dirname(file), info.templateUrl), exportName: COMPONENT_EXPORT });
      else if (info.inlineTemplate !== null) children.push({ info, templatePath: path.resolve(file), exportName: componentExportName(index) });
    });
  };
  for (const file of candidateFiles(tsPath, componentContent)) consider(file, componentsOfFile(file));
  // the other components of the component's own file (a parent and its child declared together), read from the
  // text in hand: it is what the module is built from, and the file on disk may not be what it was
  if (selfClassName !== undefined) consider(tsPath, readComponentInfos(componentContent, tsPath));
  return children;
}

/** Where a template's component is: its file, the file's content, and which of the file's components it is. */
export interface LocatedComponent {
  readonly tsPath: string;
  readonly content: string;
  readonly classIndex: number;
}

const resolvesTo = (info: ComponentInfo, file: string, htmlPath: string): boolean =>
  info.templateUrl !== null && path.resolve(path.dirname(file), info.templateUrl) === path.resolve(htmlPath);

/**
 * The component a template file belongs to. The one beside it with the same base name when it names this template
 * (the Angular CLI's layout), else the component in the same folder whose `templateUrl` points at it (`app.component.ts`
 * with `templateUrl: "./layout.html"`), else the same-named file's first class as before. Null when there is none.
 */
export function locateComponent(htmlPath: string): LocatedComponent | null {
  const sibling = htmlPath.replace(/\.html$/i, ".ts");
  const claimed = (file: string): number => (componentsOfFile(file) ?? []).findIndex((info) => resolvesTo(info, file, htmlPath));
  const at = (file: string, classIndex: number): LocatedComponent | null => {
    try {
      return { tsPath: file, content: fs.readFileSync(file, "utf8"), classIndex };
    } catch {
      return null;
    }
  };
  if (sibling !== htmlPath) {
    const index = claimed(sibling);
    if (index >= 0) return at(sibling, index);
  }
  try {
    for (const entry of fs.readdirSync(path.dirname(htmlPath))) {
      const file = path.join(path.dirname(htmlPath), entry);
      if (!entry.endsWith(".ts") || entry.endsWith(".d.ts") || entry.endsWith(".spec.ts") || file === sibling) continue;
      const index = claimed(file);
      if (index >= 0) return at(file, index);
    }
  } catch {
    // an unreadable folder has no neighbours
  }
  return sibling !== htmlPath ? at(sibling, 0) : null;
}
