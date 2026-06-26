export const GLASS = 0x16202c;

export const smoothstep = (a: number, b: number, x: number): number => {
  x = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return x * x * (3 - 2 * x);
};
