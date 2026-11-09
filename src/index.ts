// first: on a Node that cannot load the Angular compiler this fails with a clear message before anything else is required
import "./node-version";
import pkg from "../package.json";
import { TEMPLATE_EVENT_CALLEE } from "./build-virtual-module";
import { transformAngularTemplate } from "./transform";
import type { CliPluginAngular } from "./types";

export function createCliPluginAngular(): CliPluginAngular {
  return {
    id: "angular",
    version: pkg.version,
    includeGlobs: ["**/*.html"],
    staticSinks: [
      {
        id: "angular-template-event",
        callee: TEMPLATE_EVENT_CALLEE,
        eventNameArgumentIndex: 0,
      },
    ],
    // a .ts file is offered too, for the components whose template is written inline; it is only
    // read if the project's own include already covers it, so this does not widen the scan
    match: (path) => path.endsWith(".html") || (/\.[cm]?ts$/i.test(path) && !/\.d\.[cm]?ts$/i.test(path)),
    transform: transformAngularTemplate,
  };
}

export default createCliPluginAngular();

export { transformAngularTemplate, virtualPath } from "./transform";
export { buildInlineModule, buildVirtualModule, qualifyWithThis } from "./build-virtual-module";
export { parseAngularTemplate } from "./parse-angular-template";
export { readComponentScope } from "./component-scope";
export { buildComponentMethod, findChildComponents, matchesSelector, readComponentInfo, readComponentInfos } from "./component";
export type { ChildComponent, ComponentInfo, ComponentInput } from "./component";
export type { ComponentScope } from "./component-scope";
export type { ParsedAngularTemplate, TemplateComponentProp, TemplateComponentUsage, TemplateEventBinding } from "./parse-angular-template";
export type {
  CliPluginAngular,
  CliPluginStaticCalleeSink,
  CliPluginTransformInput,
  CliPluginTransformResult,
  CliPluginVirtualModule,
} from "./types";
