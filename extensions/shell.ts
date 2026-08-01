export function shellQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
