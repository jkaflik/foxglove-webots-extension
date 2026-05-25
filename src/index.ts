import { ExtensionContext } from "@foxglove/extension";

import { initWebotsPanel } from "./WebotsPanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "Webots", initPanel: initWebotsPanel });
}
