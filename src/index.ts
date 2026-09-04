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
    match: (path) => path.endsWith(".html"),
    transform: transformAngularTemplate,
  };
}

export default createCliPluginAngular();

export { transformAngularTemplate, virtualPath } from "./transform";
export { buildVirtualModule, qualifyWithThis } from "./build-virtual-module";
export { parseAngularTemplate } from "./parse-angular-template";
export { readComponentScope } from "./component-scope";
export type { ComponentScope } from "./component-scope";
export type { ParsedAngularTemplate, TemplateEventBinding } from "./parse-angular-template";
export type {
  CliPluginAngular,
  CliPluginStaticCalleeSink,
  CliPluginTransformInput,
  CliPluginTransformResult,
  CliPluginVirtualModule,
} from "./types";
