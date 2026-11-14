import path from "node:path";

import { buildComponentMethod, COMPONENT_EXPORT, componentExportName, findChildComponents, locateComponent, matchesSelector, readComponentInfo } from "./component";
import { readScopeFromSource } from "./component-scope";
import type { ComponentScope } from "./component-scope";
import type { TemplateComponentUsage, TemplateEventBinding } from "./parse-angular-template";

export const TEMPLATE_EVENT_CALLEE = "__eventra_angular_template_event__";
const DECLARATION = `declare function ${TEMPLATE_EVENT_CALLEE}(name: string): void;`;

const SIMPLE_EXPRESSION_RE = /^[a-zA-Z_$][\w$]*(\??\.[a-zA-Z_$][\w$]*|\[[^\]\r\n]*])*$/;

/**
 * Angular template expressions never write `this` explicitly - it's a
 * compile error in Angular's own template syntax - so a bare `computedName`
 * means "the component instance's own `computedName` field/getter". Only a
 * simple identifier/property-chain shape is rewritten this way; anything
 * else (calls, operators, pipes, literals) is left as-is and, if it doesn't
 * resolve on its own, safely falls back to a dynamic occurrence with no
 * value - the same honest fallback the Vue/Svelte/Astro plugins already rely
 * on for expressions outside what they specifically handle.
 */
export function qualifyWithThis(expression: string): string {
  return SIMPLE_EXPRESSION_RE.test(expression) ? `this.${expression}` : expression;
}

// The value goes between double quotes in generated TypeScript. JSON escaping covers the quote and the backslash and
// also line breaks and other control characters: a raw newline used to end the string early, so the name was
// recorded cut at the newline and nothing reported it.
function escapeString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function renderCall(binding: TemplateEventBinding, qualify: boolean): string {
  if (binding.kind === "literal") {
    return `${TEMPLATE_EVENT_CALLEE}("${escapeString(binding.value)}");`;
  }
  return `${TEMPLATE_EVENT_CALLEE}(${qualify ? qualifyWithThis(binding.value) : binding.value});`;
}

/**
 * A use of a component in the template (`<app-button track="x" [label]="text">`) is a call of that component
 * with its props: `__eventraChild0.prototype.AppButton({ track: "x", label: this.text })`, where the child's own
 * virtual module exports the class that holds the component function (see `buildComponentMethod`). The child is
 * found by its selector, so any input name is followed, not only `event`.
 */
function componentCalls(htmlPath: string, componentContent: string, usages: readonly TemplateComponentUsage[], classIndex = 0, tsPath?: string, selfClassName?: string): { imports: string[]; calls: string[] } {
  const imports: string[] = [];
  const calls: string[] = [];
  if (usages.length === 0) return { imports, calls };
  const children = findChildComponents(htmlPath, componentContent, tsPath, selfClassName);
  const importNames = new Map<string, string>();
  for (const usage of usages) {
    const attributes = new Set(usage.attributes);
    const child = children.find((candidate) => !(candidate.templatePath === htmlPath && candidate.info.className === selfClassName) && matchesSelector(candidate.info.selector!, usage.tag, attributes));
    if (!child) continue;
    const inputs = new Set(child.info.inputs.map((input) => input.publicName));
    // an input is only followed under a name that is a plain identifier, so the props that pass the filter can be keys as they are
    const props = usage.props.filter((prop) => inputs.has(prop.name));
    if (props.length === 0) continue;
    const importKey = `${child.templatePath}\0${child.exportName}`;
    let importName = importNames.get(importKey);
    if (!importName) {
      // the second component of a file is spliced into a module that already has the first one's imports
      importName = `__eventraChild${classIndex === 0 ? "" : `${classIndex}_`}${importNames.size}`;
      importNames.set(importKey, importName);
      // a template file is imported as `./x.html` (its module is `x.html.ts`); a component file as `./x`
      const relative = path.relative(path.dirname(htmlPath), child.templatePath).split(path.sep).join("/").replace(/\.ts$/, "");
      imports.push(`import { ${child.exportName} as ${importName} } from ${JSON.stringify(relative.startsWith(".") ? relative : `./${relative}`)};`);
    }
    const body = props.map((prop) => `${prop.name}: ${prop.kind === "literal" ? JSON.stringify(prop.value) : prop.value}`);
    calls.push(`${importName}.prototype.${child.info.className}({ ${body.join(", ")} });`);
  }
  return { imports, calls };
}

/**
 * Builds one virtual TS module for an Angular template (`.html`) file.
 *
 * - No bindings at all: an empty module stub.
 * - No *dynamic* bindings: a plain top-level function (no need for a
 *   `this`-scope, so the paired component class is never read).
 * - At least one dynamic binding: the paired component class (see
 *   `readComponentScope`) is read from disk and a synthetic method is
 *   spliced into its body, so `this.field`-shaped expressions resolve
 *   through the same checker-based pipeline as any other TS expression.
 *   When no class can be found, falls back to the same plain top-level
 *   function used for the literal-only case - the dynamic bindings are
 *   still reported, just never resolved to a literal.
 * - A component with inputs also gets a method named after its class that takes them as props (see
 *   `buildComponentMethod`), and exports the class so a parent's template can call it; the parent's
 *   uses of such a component are calls of that method.
 */
export function buildVirtualModule(
  htmlPath: string,
  templateEvents: readonly TemplateEventBinding[],
  templateCalls: readonly string[] = [],
  componentUsages: readonly TemplateComponentUsage[] = [],
): string {
  const located = locateComponent(htmlPath);
  const tsPath = located?.tsPath ?? htmlPath.replace(/\.html$/i, ".ts");
  const scope = located ? readScopeFromSource(located.content, located.tsPath, located.classIndex) : null;
  return compose(htmlPath, tsPath, scope, templateEvents, templateCalls, componentUsages, false, located?.classIndex ?? 0);
}

/**
 * The module for a component whose template is written inline (`template: "..."`): the component file
 * itself with the template's calls spliced into the class, under the file's own path, so the class keeps
 * its lines and every call in it is read exactly once. Returns null when the template holds nothing to add.
 */
export function buildInlineModule(
  tsPath: string,
  source: string,
  templateEvents: readonly TemplateEventBinding[],
  templateCalls: readonly string[] = [],
  componentUsages: readonly TemplateComponentUsage[] = [],
  classIndex = 0,
): string | null {
  const scope = readScopeFromSource(source, tsPath, classIndex);
  const content = compose(tsPath, tsPath, scope, templateEvents, templateCalls, componentUsages, true, classIndex);
  return content === source ? null : content;
}

function compose(
  basePath: string,
  tsPath: string,
  scope: ComponentScope | null,
  templateEvents: readonly TemplateEventBinding[],
  templateCalls: readonly string[],
  componentUsages: readonly TemplateComponentUsage[],
  inline: boolean,
  classIndex = 0,
): string {
  const hasClass = scope !== null && scope.classEndOffset !== null;
  const hasInputs = hasClass && (readComponentInfo(scope.content, tsPath, classIndex)?.inputs.length ?? 0) > 0;
  const selfClassName = hasClass ? readComponentInfo(scope.content, tsPath, classIndex)?.className : undefined;
  const children = hasClass ? componentCalls(basePath, scope.content, componentUsages, classIndex, tsPath, selfClassName) : { imports: [], calls: [] };

  if (templateEvents.length === 0 && templateCalls.length === 0 && children.calls.length === 0 && !hasInputs) {
    return inline && scope ? scope.content : "export {}\n";
  }

  // one line, so the lines of the component's own code keep their place below it; an inline component
  // is the real file, so there the line goes after the code instead
  // a file already spliced for an earlier component of it carries this declaration
  const declared = inline && scope !== null && scope.content.includes(DECLARATION);
  const declaration = [...(declared ? [] : [DECLARATION]), ...children.imports].join(" ");
  // template calls are written against the component (`this.track(...)`), so they need its class too
  const needsClass = templateCalls.length > 0 || children.calls.length > 0 || hasInputs || templateEvents.some((binding) => binding.kind === "dynamic");
  // the CLI reads this line as "the code below was generated from the template"; the end line
  // keeps the rest of the component file, which follows the method, out of that region
  const generated = templateCalls.length > 0 || children.calls.length > 0 || hasInputs;
  const regionStart = generated ? [`// --- angular template (auto-generated) ---`] : [];
  const regionEnd = generated ? [`// --- end template ---`] : [];

  if (needsClass && scope && scope.classEndOffset !== null) {
    const hasBody = templateEvents.length > 0 || templateCalls.length > 0 || children.calls.length > 0;
    const method = [
      "",
      ...regionStart.map((line) => `  ${line}`),
      ...(hasBody
        ? [
            "  __eventraAngularTemplate() {",
            ...templateEvents.map((binding) => `    ${renderCall(binding, true)}`),
            ...templateCalls.map((call) => `    ${call}`),
            ...children.calls.map((call) => `    ${call}`),
            "  }",
          ]
        : []),
    ].join("\n");
    const before = scope.content.slice(0, scope.classEndOffset);
    const after = scope.content.slice(scope.classEndOffset);
    const component = hasInputs ? buildComponentMethod(before + method + "\n" + after, tsPath, classIndex) : null;
    const tail = [...(component ? ["", component.method] : []), ...regionEnd.map((line) => `  ${line}`)];
    const closing = tail.length > 0 ? `\n${tail.join("\n")}` : "";
    const spliced = before + method + closing + "\n" + after;
    // a template file's module exports its component under one name, whichever class of its file it is
    const exported = component ? `\nexport { ${component.name} as ${inline ? componentExportName(classIndex) : COMPONENT_EXPORT} };` : "";
    return (inline ? [spliced.replace(/\n*$/, ""), declaration] : [declaration, spliced]).filter(Boolean).join("\n") + exported + "\n";
  }

  const lines = [
    ...(inline ? [] : [declaration]),
    ...regionStart,
    "function __eventraAngularTemplate() {",
    ...templateEvents.map((binding) => `  ${renderCall(binding, false)}`),
    ...templateCalls.map((call) => `  ${call}`),
    "}",
    ...regionEnd,
    ...(inline && declaration ? [declaration] : []),
  ];
  // an inline component is a real file: its own code stays, the template's calls follow it
  return (inline && scope ? `${scope.content.replace(/\n*$/, "")}\n\n` : "") + lines.join("\n") + "\n";
}
