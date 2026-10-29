// Ambient declaration for Bun's built-in test runner.
// `bun test` runs these files; tsc just needs the module shape to typecheck.
declare module "bun:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export namespace expect { function objectContaining(o: object): unknown; }
  export function expect(actual: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toMatch(pattern: RegExp | string): void;
    toContain(item: unknown): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeCloseTo(expected: number, digits?: number): void;
    toHaveLength(n: number): void;
    not: {
      toBe(expected: unknown): void;
      toEqual(expected: unknown): void;
      toMatch(pattern: RegExp | string): void;
      toContain(item: unknown): void;
      toHaveLength(n: number): void;
    };
  };
}
