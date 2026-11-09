import fs from "node:fs";
import path from "node:path";

import { buildInlineModule, buildVirtualModule } from "./build-virtual-module";
import { isComponentTemplate } from "./component-scope";
import { locateComponent, readComponentInfos } from "./component";
import { parseAngularTemplate } from "./parse-angular-template";
import type { CliPluginTransformInput, CliPluginTransformResult } from "./types";

// `import { Component as C } from "@angular/core"`: the decorator is then written `@C(...)`
const ALIASED_COMPONENT = /\bComponent\s+as\s+[A-Za-z_$]/;

/** Map `foo.component.html` → `foo.component.html.ts` (single virtual TS module for the compiler). */
export function virtualPath(htmlPath: string): string {
  return `${htmlPath}.ts`;
}

/**
 * A `.ts` file with `@Component({ template: "..." })`: the inline template is read like a `.html` one. The
 * result is the component file itself with the template's calls spliced in; a file without an inline
 * template gets no modules, which leaves it to be read as the plain TypeScript it is.
 */
async function transformComponentFile(input: CliPluginTransformInput): Promise<CliPluginTransformResult> {
  if (!(/@Component\b/.test(input.source) || ALIASED_COMPONENT.test(input.source))) return { modules: [] };
  // a templateUrl that points at no file: not an error (the file may be generated), but its events are not in the scan
  const missing = /\btemplateUrl\s*:/.test(input.source)
    ? readComponentInfos(input.source, input.path).flatMap((info) =>
        info.templateUrl !== null && !fs.existsSync(path.resolve(path.dirname(input.path), info.templateUrl)) ? [`templateUrl "${info.templateUrl}" was not found: what its template holds is not in the scan.`] : [],
      )
    : [];
  if (!/\btemplate\s*:/.test(input.source)) return { modules: [], ...(missing.length > 0 ? { notes: missing } : {}) };

  // a file may declare several components: each one's inline template is spliced into its own class,
  // one after the other, on top of what the previous splice produced
  let content = input.source;
  const notes: string[] = [...missing];
  readComponentInfos(input.source, input.path).forEach((info, index) => {
    if (!info.inlineTemplate) return;
    const { templateEvents, templateCalls, componentUsages, notes: found, errors } = parseAngularTemplate(info.inlineTemplate);
    if (errors.length > 0) {
      throw new Error(`Failed to parse the inline Angular template of ${input.path}: ${errors.join("; ")}`);
    }
    notes.push(...found);
    content = buildInlineModule(input.path, content, templateEvents, templateCalls, componentUsages, index) ?? content;
  });
  return { modules: content === input.source ? [] : [{ path: input.path, content }], ...(notes.length > 0 ? { notes } : {}) };
}

export async function transformAngularTemplate(
  input: CliPluginTransformInput,
): Promise<CliPluginTransformResult> {
  if (/\.[cm]?ts$/i.test(input.path) && !/\.d\.[cm]?ts$/i.test(input.path)) {
    return transformComponentFile(input);
  }
  const { templateEvents, templateCalls, componentUsages, notes, errors } = parseAngularTemplate(input.source);

  if (errors.length > 0 && !isComponentTemplate(input.path)) {
    // Every .html file is offered to this plugin, and most of those in a repository are not templates
    // (generated docs, static pages): one that does not parse and that no component uses holds no events.
    return { modules: [{ path: virtualPath(input.path), content: buildVirtualModule(input.path, [], []) }] };
  }

  if (errors.length > 0) {
    // A parse error means `@angular/compiler` could not build a reliable
    // node tree - continuing would silently under-report (or miss
    // entirely) every event in this file, with nothing telling the user
    // why. Throwing surfaces it through the host CLI's existing per-file
    // "skip: <file> <message>" path (see scanProject) instead of returning
    // a template that looks like a legitimate zero-event file.
    throw new Error(
      `Failed to parse Angular template ${input.path}: ${errors.join("; ")}`,
    );
  }

  // the module holds the component's class: the template is stale when that file changes
  const component = locateComponent(input.path);
  return {
    modules: [
      {
        path: virtualPath(input.path),
        content: buildVirtualModule(input.path, templateEvents, templateCalls, componentUsages),
      },
    ],
    ...(notes.length > 0 ? { notes } : {}),
    ...(component ? { dependsOn: [component.tsPath] } : {}),
  };
}
