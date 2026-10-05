import type { EcosystemInfo } from "../core/ecosystems.js";

/**
 * Per-ecosystem adapter (modular extension point).
 * New ecosystems: add a file here + register in `registry.ts`,
 * then wire detection in `core/ecosystems.ts` and install blocks in `core/bundle.ts`.
 */
export interface EcosystemAdapter {
  id: EcosystemInfo["id"];
  installCommand: string;
  testCommand: string;
  runHint: string;
  manifests: string[];
}
