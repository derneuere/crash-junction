import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VehicleSpec, Variant } from '../types';
import type { ModelConfig, VehicleModel } from './types';
import { bakeModel } from './bake';

const CAR = (name: string): ModelConfig => ({
  url: `/models/cars/glb/${name}.glb`,
  rotY: Math.PI,
  paint: ['*biggest*'],
});

// transport-pack palette (FBX materials are all flat grey 0.8)
const BUS_PALETTE: Record<string, number> = {
  Top: 0xf0ece1,
  Bottom: 0x4a5058, // tinted by spawn color via paint below
  Bumper: 0x33373d,
  Windows: 0x1d2733,
  Lights: 0xffc06a,
  Details: 0x6a7077,
  Material: 0x202327,
  Wheel: 0x202327,
};

const TRAFFIC_NAMES = ['NormalCar1', 'NormalCar2', 'Taxi', 'SUV', 'Cop'] as const;
const SEDAN_TRAFFIC = TRAFFIC_NAMES.map(CAR);
const BUS: ModelConfig = {
  url: '/models/transport/glb/Bus.glb',
  rotY: -Math.PI / 2,
  paint: ['Bottom'],
  palette: BUS_PALETTE,
};

// ---------- player car roster ----------
// v1 roster (docs/research/menu-event-picker.md §2.5): OWNED models only, no
// downloads. A car is a body + the engine voice that body implies, B3-style —
// the picker writes both 'cj-car' and 'cj-engine' when one is chosen. Names
// are invented (the research doc's trademark note: no real-brand labels).

export type PlayerCarId = 'compact' | 'wedge' | 'vector' | 'prowler';

export interface PlayerCarDef {
  id: PlayerCarId;
  label: string;
  /** Engine voice for this body (audio/synths.ts flavors). A literal union,
   *  structurally identical to EngineFlavor — models.ts stays audio-free. */
  flavor: 'stock' | 'v10' | 'v8';
  tagline: string;
}

export const PLAYER_CARS: readonly PlayerCarDef[] = [
  { id: 'compact', label: 'COMPACT', flavor: 'stock', tagline: 'THE RENTAL YOU LEARNED TO DRIFT IN' },
  { id: 'wedge', label: 'WEDGE', flavor: 'v10', tagline: 'EXOTIC SCREAM, GLASS JAW' },
  { id: 'vector', label: 'VECTOR', flavor: 'v10', tagline: 'THE OTHER WEDGE — SAME SCREAM, NO SPOILER' },
  { id: 'prowler', label: 'PROWLER', flavor: 'v8', tagline: 'INTERCEPTOR BODY OVER A MUSCLE RUMBLE' },
];

/** = SportsCar2, the pre-roster player car — defaulting here means a tree
 *  with no 'cj-car' key behaves exactly like it did before the roster. */
export const DEFAULT_CAR: PlayerCarId = 'wedge';

/** GLB stem per car (public/models/cars/glb). compact/prowler bodies also
 *  drive in the traffic pool — their bakes are shared (see loadVehicleModels). */
const PLAYER_CAR_MODELS: Record<PlayerCarId, (typeof TRAFFIC_NAMES)[number] | 'SportsCar2' | 'SportsCar'> = {
  compact: 'NormalCar1',
  wedge: 'SportsCar2',
  vector: 'SportsCar', // the cars pack's second wedge, unused until now
  prowler: 'Cop',
};

interface Library {
  sedanTraffic: VehicleModel[];
  playerCars: Record<PlayerCarId, VehicleModel>;
  bus: VehicleModel;
}

let library: Library | null = null;
let trafficPick = 0;
let playerCar: PlayerCarId = DEFAULT_CAR;

/** DETERMINISM: the player template's wheel arches become the suspension
 *  anchors, so the car choice is SIM state, not presentation. It must be
 *  pinned before a Game constructs — App remounts on a car change exactly
 *  like a level change — and never moved mid-take. */
export function setPlayerCar(id: PlayerCarId): void {
  playerCar = id;
}

/** Take boundary: traffic model choice must restart with the actors, or a
 *  replayed take would dress (and hang suspension on) different cars. */
export function resetModelPicker(): void {
  trafficPick = 0;
}

export function getVehicleModel(variant: Variant, isPlayer: boolean): VehicleModel | null {
  if (!library) return null;
  if (variant === 'sedan') {
    if (isPlayer) return library.playerCars[playerCar];
    return library.sedanTraffic[trafficPick++ % library.sedanTraffic.length];
  }
  if (variant === 'bus') return library.bus;
  return null; // tanker stays procedural — no matching model in the packs
}

/** Load + bake every vehicle model. Call once before the Game constructs;
 *  on failure the game falls back to the procedural hulls. */
export async function loadVehicleModels(specs: Record<Variant, VehicleSpec>): Promise<void> {
  const loader = new GLTFLoader();
  const bake = async (cfg: ModelConfig, spec: VehicleSpec) => bakeModel(await loader.loadAsync(cfg.url), cfg, spec);
  const [wedge, vector, bus, ...traffic] = await Promise.all([
    bake(CAR(PLAYER_CAR_MODELS.wedge), specs.sedan),
    bake(CAR(PLAYER_CAR_MODELS.vector), specs.sedan),
    bake(BUS, specs.bus),
    ...SEDAN_TRAFFIC.map((cfg) => bake(cfg, specs.sedan)),
  ]);
  // COMPACT and PROWLER reuse the traffic-pool bakes: templates are read-only
  // at runtime (vehicles.ts/panels.ts clone geometry per actor), so the player
  // and a traffic clone sharing one bake is safe — and the traffic pool stays
  // byte-identical to the pre-roster build, which replay visuals depend on.
  library = {
    sedanTraffic: traffic,
    playerCars: {
      compact: traffic[TRAFFIC_NAMES.indexOf('NormalCar1')],
      wedge,
      vector,
      prowler: traffic[TRAFFIC_NAMES.indexOf('Cop')],
    },
    bus,
  };
}
