import {
  npmAdapter,
  pnpmAdapter,
  yarnAdapter,
  pipAdapter,
  uvAdapter,
  cargoAdapter,
  goAdapter,
  mavenAdapter,
  gradleAdapter,
  dotnetAdapter,
  rubyAdapter,
} from "./adapters.js";
import type { EcosystemAdapter } from "./types.js";

/** Registry pattern: add new adapters here to support new ecosystems. */
export const ECOSYSTEM_REGISTRY: EcosystemAdapter[] = [
  npmAdapter,
  pnpmAdapter,
  yarnAdapter,
  pipAdapter,
  uvAdapter,
  cargoAdapter,
  goAdapter,
  mavenAdapter,
  gradleAdapter,
  dotnetAdapter,
  rubyAdapter,
];

export function getAdapter(id: EcosystemAdapter["id"]): EcosystemAdapter | undefined {
  return ECOSYSTEM_REGISTRY.find((a) => a.id === id);
}
