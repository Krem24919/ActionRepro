export function info(msg: string): void {
  console.log(msg);
}

export function warn(msg: string): void {
  console.warn(`warning: ${msg}`);
}

export function error(msg: string): void {
  console.error(`error: ${msg}`);
}
