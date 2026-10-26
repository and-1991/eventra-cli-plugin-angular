import path from "node:path";

import { buildComponentMethod, COMPONENT_EXPORT, findChildComponents, matchesSelector, readComponentInfo } from "./component";
import { readComponentScope } from "./component-scope";
import type { TemplateComponentUsage, TemplateEventBinding } from "./parse-angular-template";

export const TEMPLATE_EVENT_CALLEE = "__eventra_angular_template_event__";

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

function escapeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
function componentCalls(htmlPath: string, componentContent: string, usages: readonly TemplateComponentUsage[]): { imports: string[]; calls: string[] } {
  const imports: string[] = [];
  const calls: string[] = [];
  if (usages.length === 0) return { imports, calls };
  const children = findChildComponents(htmlPath, componentContent);
  const importNames = new Map<string, string>();
  for (const usage of usages) {
    const attributes = new Set(usage.attributes);
    const child = children.find((candidate) => candidate.templatePath !== htmlPath && matchesSelector(candidate.info.selector!, usage.tag, attributes));
    if (!child) continue;
    const inputs = new Set(child.info.inputs.map((input) => input.publicName));
    // an input is only followed under a name that is a plain identifier, so the props that pass the filter can be keys as they are
    const props = usage.props.filter((prop) => inputs.has(prop.name));
    if (props.length === 0) continue;
    let importName = importNames.get(child.templatePath);
    if (!importName) {
      importName = `__eventraChild${importNames.size}`;
      importNames.set(child.templatePath, importName);
      const relative = path.relative(path.dirname(htmlPath), child.templatePath).split(path.sep).join("/");
      imports.push(`import { ${COMPONENT_EXPORT} as ${importName} } from ${JSON.stringify(relative.startsWith(".") ? relative : `./${relative}`)};`);
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
  const tsPath = htmlPath.replace(/\.html$/i, ".ts");
  const scope = readComponentScope(htmlPath);
  const hasClass = scope !== null && scope.classEndOffset !== null;
  const hasInputs = hasClass && (readComponentInfo(scope.content, tsPath)?.inputs.length ?? 0) > 0;
  const children = hasClass ? componentCalls(htmlPath, scope.content, componentUsages) : { imports: [], calls: [] };

  if (templateEvents.length === 0 && templateCalls.length === 0 && children.calls.length === 0 && !hasInputs) {
    return "export {}\n";
  }

  // one line, so the lines of the component's own code keep their place below it
  const declaration = [`declare function ${TEMPLATE_EVENT_CALLEE}(name: string): void;`, ...children.imports].join(" ");
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
    const component = hasInputs ? buildComponentMethod(before + method + "\n" + after, tsPath) : null;
    const tail = [...(component ? ["", component.method] : []), ...regionEnd.map((line) => `  ${line}`)];
    const closing = tail.length > 0 ? `\n${tail.join("\n")}` : "";
    const spliced = before + method + closing + "\n" + after;
    const exported = component ? `\nexport { ${component.name} as ${COMPONENT_EXPORT} };` : "";
    return [declaration, spliced].join("\n") + exported + "\n";
  }

  const lines = [
    declaration,
    ...regionStart,
    "function __eventraAngularTemplate() {",
    ...templateEvents.map((binding) => `  ${renderCall(binding, false)}`),
    ...templateCalls.map((call) => `  ${call}`),
    "}",
    ...regionEnd,
  ];
  return lines.join("\n") + "\n";
}
