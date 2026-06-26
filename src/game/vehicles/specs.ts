import type { VehicleSpec, Variant } from '../types';

export const SPECS: Record<Variant, VehicleSpec> = {
  sedan: {
    variant: 'sedan', mass: 1450, width: 1.9, height: 1.35, length: 4.6, halfY: 0.72,
    rideHeight: 0.8, hullY: 0.14, wheelRadius: 0.34, wheelX: 0.82, wheelZFront: -1.5, wheelZRear: 1.45,
    valueMult: 1, cashCap: 12000,
  },
  bus: {
    variant: 'bus', mass: 11500, width: 2.3, height: 2.4, length: 8.8, halfY: 1.05,
    rideHeight: 1.13, hullY: 0.15, wheelRadius: 0.42, wheelX: 0.95, wheelZFront: -2.9, wheelZRear: 2.9,
    valueMult: 1.6, cashCap: 22000,
  },
  tanker: {
    variant: 'tanker', mass: 15000, width: 2.35, height: 2.5, length: 9.2, halfY: 1.0,
    rideHeight: 1.06, hullY: 0, wheelRadius: 0.45, wheelX: 0.95, wheelZFront: -3.2, wheelZRear: 3.0,
    valueMult: 2, cashCap: 30000,
    explosive: { power: 2.4, fuseDamage: 16 },
  },
};
