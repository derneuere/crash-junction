import { useEffect, useRef, useState } from 'react';
import { GarageScene, GARAGE_DEFAULT_COLOR, GARAGE_LINEUP_COLORS } from '../game/garageScene';
import type { PlayerCarDef, PlayerCarId } from '../game/models';

// ────────────────────────────────────────────────────────────────────────────
// CarSelect — the B3-Takedown-style garage. Mounts a GarageScene on its own
// canvas (every roster car parked in its own bay, the camera gliding between
// them), and lays a slim HUD over it that NEVER covers the hero car: a top
// bar (GARAGE wordmark + SELECT CAR), side cyclers, and a bottom band with
// the car's name plate, segmented TOP SPEED / WEIGHT tick bars, the engine
// voice, a paint swatch row, and a BACK / SELECT legend along the screen edge.
//
// Paint is remembered PER CAR while browsing (B3 behaviour — recolouring the
// wedge doesn't repaint the compact), starting from each car's lineup colour.
//
// This component is SELF-CONTAINED and owns the GarageScene lifecycle (mount →
// start, unmount → dispose). The scene is decoupled from the game sim —
// mounting it loads no level and touches no physics/RNG/replay.
// ────────────────────────────────────────────────────────────────────────────

/** The garage paint palette — B3-ish showroom colours. Contains every
 *  GARAGE_LINEUP_COLORS value so the active swatch always highlights. */
export const CAR_COLORS: readonly number[] = [
  GARAGE_DEFAULT_COLOR, // spawn red
  0xf2b01e, // gold
  0xe8e8ec, // pearl white
  0x1c1f26, // gunmetal
  0x2266dd, // electric blue
  0x22bb55, // racing green
  0xc23a8f, // magenta
  0xff6a1a, // hazard orange
];

/** Display stats per car, 0..1 of the class max — derived from the roster's
 *  body/engine archetype (the SPECS.sedan physics are shared, so the BARS are a
 *  presentation read of each body's character, B3-style). Top speed tracks the
 *  engine voice (V10 screamers > V8 muscle > stock rental); weight is the body
 *  mass feel (the compact is light, the cop interceptor heavy). */
const CAR_STATS: Record<PlayerCarId, { topSpeed: number; weight: number }> = {
  compact: { topSpeed: 0.52, weight: 0.34 },
  wedge: { topSpeed: 0.96, weight: 0.46 },
  vector: { topSpeed: 0.92, weight: 0.5 },
  prowler: { topSpeed: 0.74, weight: 0.82 },
};

/** Engine-voice label shown beside the stats (matches audio/synths flavors). */
const ENGINE_LABEL: Record<PlayerCarDef['flavor'], string> = {
  stock: 'STOCK INLINE-4',
  v10: 'V10 SCREAMER',
  v8: 'V8 MUSCLE',
};

export interface CarSelectProps {
  /** The roster to choose from — pass PLAYER_CARS (or a subset/owned set). */
  cars: readonly PlayerCarDef[];
  /** Which car is focused on open. Falls back to the first car if unknown. */
  initialCarId: PlayerCarId;
  /** Optional initial paint for the focused car (hex). Defaults to that
   *  car's garage lineup colour. */
  initialColor?: number;
  /** Confirm: the player picked `carId` painted `color` (hex 0xRRGGBB). */
  onSelect: (carId: PlayerCarId, color: number) => void;
  /** Cancel: return to the previous menu without changing the car. */
  onBack: () => void;
}

export function CarSelect({ cars, initialCarId, initialColor, onSelect, onBack }: CarSelectProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<GarageScene | null>(null);

  const startIndex = Math.max(0, cars.findIndex((c) => c.id === initialCarId));
  const [index, setIndex] = useState(startIndex);
  // per-car paint memory — browsing never repaints the OTHER cars (B3 rule)
  const [colors, setColors] = useState<Partial<Record<PlayerCarId, number>>>(
    initialColor !== undefined ? { [initialCarId]: initialColor } : {},
  );

  const car = cars[index] ?? cars[0];
  const color = colors[car.id] ?? GARAGE_LINEUP_COLORS[car.id] ?? GARAGE_DEFAULT_COLOR;
  const stats = CAR_STATS[car.id] ?? { topSpeed: 0.6, weight: 0.5 };

  // mount the garage scene once; the canvas lives for the component's life
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = new GarageScene(canvas);
    sceneRef.current = scene;
    scene.start();
    const onResize = () => scene.resize();
    addEventListener('resize', onResize);
    // a frame after layout settles, fit to the real canvas box
    const id = requestAnimationFrame(() => scene.resize());
    return () => {
      cancelAnimationFrame(id);
      removeEventListener('resize', onResize);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  // glide the camera to the current car + push its paint whenever they change
  useEffect(() => {
    sceneRef.current?.setCar(car.id, color);
  }, [car.id, color]);

  const cycle = (dir: -1 | 1) => setIndex((i) => (i + dir + cars.length) % cars.length);
  const paint = (hex: number) => setColors((c) => ({ ...c, [car.id]: hex }));
  const cyclePaint = () => {
    const at = CAR_COLORS.indexOf(color);
    paint(CAR_COLORS[(at + 1) % CAR_COLORS.length]);
  };

  // keyboard: ←/→ cycle car, C cycles paint, Enter selects, Esc backs out
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') cycle(-1);
      else if (e.code === 'ArrowRight' || e.code === 'KeyD') cycle(1);
      else if (e.code === 'KeyC') cyclePaint();
      else if (e.code === 'Enter') onSelect(car.id, color);
      else if (e.code === 'Escape') onBack();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [car.id, color, cars.length, onSelect, onBack]);

  return (
    <div className="garageSel">
      <canvas ref={canvasRef} className="garageCanvas" />
      {/* top + bottom gradients so the HUD reads over the concrete */}
      <div className="garageVig" />

      {/* top bar — B3 "TIME ATTACK … SELECT CAR" */}
      <div className="garageTopBar">
        <span className="garageLogo">GARAGE</span>
        <span className="garageMode">SELECT CAR</span>
      </div>

      {/* left / right car cyclers flanking the parked hero */}
      <button className="garageArrow left" onClick={() => cycle(-1)} aria-label="Previous car">
        &#8249;
      </button>
      <button className="garageArrow right" onClick={() => cycle(1)} aria-label="Next car">
        &#8250;
      </button>

      {/* bottom band — name plate, stats, paint. Never overlaps the car. */}
      <div className="garageBand">
        <div className="garageNamePlate">
          <span className="garageName">{car.label}</span>
          <span className="garageTagline">{car.tagline}</span>
        </div>

        <div className="garageInfoRow">
          <StatBar label="TOP SPEED" value={stats.topSpeed} />
          <StatBar label="WEIGHT" value={stats.weight} />
          <div className="garageEngine">
            <span className="garageEngLbl">ENGINE</span>
            <span className="garageEngVal">{ENGINE_LABEL[car.flavor]}</span>
          </div>
        </div>

        <div className="garagePaintRow">
          <span className="garageColorLbl">PAINT</span>
          <div className="garageSwatches">
            {CAR_COLORS.map((hex) => (
              <button
                key={hex}
                className={`garageSwatch${hex === color ? ' active' : ''}`}
                style={{ background: `#${hex.toString(16).padStart(6, '0')}` }}
                onClick={() => paint(hex)}
                aria-label={`Paint #${hex.toString(16).padStart(6, '0')}`}
              />
            ))}
          </div>
          <div className="garageDots">
            {cars.map((c, i) => (
              <button
                key={c.id}
                className={`garageDot${i === index ? ' active' : ''}`}
                onClick={() => setIndex(i)}
                aria-label={c.label}
              />
            ))}
          </div>
        </div>
      </div>

      {/* screen-edge legend — B3's "△ Back … Select ✕" strip */}
      <div className="garageLegend">
        <button className="garageBtn back" onClick={onBack}>
          ◀ BACK
        </button>
        <span className="garageHint">◀ ▶ CHANGE CAR · C PAINT</span>
        <button className="garageBtn select" onClick={() => onSelect(car.id, color)}>
          SELECT ▶
        </button>
      </div>
    </div>
  );
}

/** A B3 stat bar: a segmented tick strip, the lit span gold over a dark track. */
function StatBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="garageStat">
      <span className="garageStatLbl">{label}</span>
      <div className="garageStatTrack">
        <div className="garageStatFill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
