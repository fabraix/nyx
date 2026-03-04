export function resolveConfigName(input: string): string {
  return input.replace(/\.ya?ml$/, "");
}
