// The LevelDef schema — the editor's single source of truth for what a level
// contains and how each field edits (src/game/types/level.ts is the type it
// mirrors). Hidden fields (coast/patches/decals/padDecals, race internals)
// are preserved verbatim through load→edit→save so the editor can open any
// hand-authored level without shredding what it doesn't render yet.

import type { LevelSchema, RecordSchema } from './types';

const vehicleSpawn = (name: string, label: string): RecordSchema => ({
  name,
  label,
  fields: {
    variant: { kind: 'enum', options: ['sedan', 'bus', 'tanker'] },
    color: { kind: 'color' },
    x: { kind: 'number', step: 0.5 },
    z: { kind: 'number', step: 0.5 },
    dir: { kind: 'dir' },
    speed: { kind: 'number', step: 0.5, min: 0, max: 60 },
    delay: { kind: 'number', step: 0.5, min: 0 },
  },
  fieldMetadata: {
    dir: { label: 'heading' },
    speed: { description: 'cruise speed, m/s' },
    delay: { optional: true, description: 'seconds after launch before this car moves' },
  },
});

export const LEVEL_SCHEMA: LevelSchema = {
  rootType: 'level',
  registry: {
    level: {
      name: 'level',
      label: 'Level',
      fields: {
        name: { kind: 'string' },
        ground: { kind: 'enum', options: ['junction', 'pad', 'field'] },
        mode: { kind: 'record', type: 'mode' },
        player: { kind: 'record', type: 'playerSpawn' },
        traffic: {
          kind: 'list', item: 'trafficSpawn', addable: true, removable: true,
          itemLabel: (v, i) => {
            const s = v as { variant?: string; speed?: number };
            return `${i}: ${s.variant ?? '?'}${(s.speed ?? 0) === 0 ? ' (parked)' : ''}`;
          },
        },
        poles: {
          kind: 'list', item: 'pole', addable: true, removable: true,
          itemLabel: (v, i) => { const p = v as { x: number; z: number }; return `${i}: (${p.x}, ${p.z})`; },
        },
        barrels: {
          kind: 'list', item: 'barrel', addable: true, removable: true,
          itemLabel: (v, i) => { const p = v as { x: number; z: number }; return `${i}: (${p.x}, ${p.z})`; },
        },
        ramps: {
          kind: 'list', item: 'ramp', addable: true, removable: true,
          itemLabel: (v, i) => { const r = v as { height: number }; return `${i}: h ${r.height} m`; },
        },
        buildings: {
          kind: 'list', item: 'building', addable: true, removable: true,
          itemLabel: (v, i) => { const b = v as { h: number }; return `${i}: h ${b.h} m`; },
        },
        pickups: {
          kind: 'list', item: 'pickup', addable: true, removable: true,
          itemLabel: (v, i) => { const p = v as { mult: number }; return `${i}: ×${p.mult}`; },
        },
        props: {
          kind: 'list', item: 'prop', addable: true, removable: true,
          itemLabel: (v, i) => {
            const p = v as { url: string };
            const short = (p.url ?? '').replace(/^builtin:/, '').split('/').pop()?.replace(/\.glb$/, '');
            return `${i}: ${short || '?'}`;
          },
        },
        // authored-but-not-yet-editable layers: kept for round-trip
        padDecals: { kind: 'record', type: 'opaque' },
        coast: { kind: 'record', type: 'opaque' },
        patches: { kind: 'record', type: 'opaque' },
        decals: { kind: 'record', type: 'opaque' },
      },
      fieldMetadata: {
        ground: { optional: true, description: "junction = crossroad · pad = practice asphalt · field = grass" },
        padDecals: { hidden: true, optional: true },
        coast: { hidden: true, optional: true },
        patches: { hidden: true, optional: true },
        decals: { hidden: true, optional: true },
      },
    },

    /** Placeholder for preserved-verbatim sub-objects. */
    opaque: { name: 'opaque', fields: {} },

    mode: {
      name: 'mode',
      label: 'Mode',
      // `kind` is a discriminated union — the ModeEditor component swaps the
      // arms; the schema only describes the crash arm's medals record.
      fields: {
        kind: { kind: 'enum', options: ['crash', 'practice', 'race'] },
        medals: { kind: 'record', type: 'medals' },
        race: { kind: 'record', type: 'race' },
      },
      fieldMetadata: {
        medals: { optional: true },
        race: { optional: true },
      },
    },

    medals: {
      name: 'medals',
      label: 'Medal targets ($)',
      fields: {
        bronze: { kind: 'number', step: 5000, min: 0, int: true },
        silver: { kind: 'number', step: 5000, min: 0, int: true },
        gold: { kind: 'number', step: 5000, min: 0, int: true },
      },
    },

    race: {
      name: 'race',
      label: 'Race',
      fields: {
        laps: { kind: 'number', step: 1, min: 1, max: 20, int: true },
        width: { kind: 'number', step: 0.5, min: 4 },
        rivals: {
          kind: 'list', item: 'rival', addable: true, removable: true,
          itemLabel: (v, i) => { const r = v as { skill: number }; return `${i}: skill ${r.skill}`; },
        },
        sections: { kind: 'record', type: 'opaque' },
        shortcuts: { kind: 'record', type: 'opaque' },
        signatures: { kind: 'record', type: 'opaque' },
        wallStyles: { kind: 'record', type: 'opaque' },
      },
      fieldMetadata: {
        width: { description: 'track ribbon width, m' },
        sections: { hidden: true },
        shortcuts: { hidden: true, optional: true },
        signatures: { hidden: true, optional: true },
        wallStyles: { hidden: true, optional: true },
      },
    },

    rival: {
      name: 'rival',
      label: 'Rival',
      fields: {
        color: { kind: 'color' },
        skill: { kind: 'number', step: 0.01, min: 0.5, max: 1 },
        aggression: { kind: 'number', step: 0.05, min: 0, max: 1 },
      },
      fieldMetadata: {
        skill: { description: 'corner-speed multiplier < 1' },
        aggression: { description: '0 clean … 1 bully' },
      },
    },

    playerSpawn: vehicleSpawn('playerSpawn', 'Player'),
    trafficSpawn: vehicleSpawn('trafficSpawn', 'Traffic car'),

    pole: {
      name: 'pole',
      label: 'Pole',
      fields: { x: { kind: 'number', step: 0.5 }, z: { kind: 'number', step: 0.5 } },
    },

    barrel: {
      name: 'barrel',
      label: 'Barrel',
      fields: { x: { kind: 'number', step: 0.5 }, z: { kind: 'number', step: 0.5 } },
    },

    ramp: {
      name: 'ramp',
      label: 'Ramp',
      fields: {
        x: { kind: 'number', step: 0.5 },
        zStart: { kind: 'number', step: 0.5 },
        length: { kind: 'number', step: 0.5, min: 1 },
        width: { kind: 'number', step: 0.2, min: 1 },
        height: { kind: 'number', step: 0.05, min: 0.1 },
      },
      fieldMetadata: {
        zStart: { description: 'ramp ascends from zStart toward +z' },
      },
    },

    building: {
      name: 'building',
      label: 'Building',
      fields: {
        x: { kind: 'number', step: 1 },
        z: { kind: 'number', step: 1 },
        h: { kind: 'number', step: 1, min: 2 },
        color: { kind: 'color' },
      },
      fieldMetadata: { h: { label: 'height (m)' } },
    },

    pickup: {
      name: 'pickup',
      label: 'Multiplier ring',
      fields: {
        x: { kind: 'number', step: 0.5 },
        y: { kind: 'number', step: 0.1, min: 0.5 },
        z: { kind: 'number', step: 0.5 },
        mult: { kind: 'number', step: 1, min: 2, max: 5, int: true },
      },
      fieldMetadata: { y: { description: 'air height — collect mid-jump' } },
    },

    prop: {
      name: 'prop',
      label: 'Prop',
      fields: {
        url: { kind: 'string' },
        x: { kind: 'number', step: 0.5 },
        z: { kind: 'number', step: 0.5 },
        y: { kind: 'number', step: 0.1 },
        yaw: { kind: 'number', step: 0.1 },
        scale: { kind: 'number', step: 0.1, min: 0.05 },
        tint: { kind: 'color' },
        collider: { kind: 'record', type: 'colliderBox' },
      },
      fieldMetadata: {
        url: { description: "GLB path or builtin:<name> (gantry-crane, floodlight-mast, bollard, lamp-post)" },
        y: { optional: true, description: 'visual-only lift; collider stays ground-planted' },
        tint: { optional: true },
        collider: { optional: true, description: "absent = pure decor, no physics body" },
      },
    },

    colliderBox: {
      name: 'colliderBox',
      label: 'Collider half-extents',
      fields: {
        hx: { kind: 'number', step: 0.1, min: 0.05 },
        hy: { kind: 'number', step: 0.1, min: 0.05 },
        hz: { kind: 'number', step: 0.1, min: 0.05 },
      },
    },
  },
};
