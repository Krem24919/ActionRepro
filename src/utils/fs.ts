import fs from "node:fs";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Entries of the current working directory, used as lowercase-insensitive
 * project hints by ecosystem detection. Never throws.
 */
export function listCwdFiles(): string[] {
  try {
    return fs.readdirSync(process.cwd());
  } catch {
    return [];
  }
}
