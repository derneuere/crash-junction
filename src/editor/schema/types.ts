// Schema type system for the level editor — the steward-style pattern: a
// registry of named record schemas whose field kinds drive a generic form
// renderer (Fields.tsx) and a generic path walker (walk.ts). The editor's
// entire inspector UI is data, not code: adding a field to a LevelDef list
// item means adding one entry to levelSchema.ts, nothing else.

/** A path into the level object: e.g. ['barrels', 3, 'x']. The tree, the
 *  3D viewport and the inspector all speak this — it IS the selection. */
export type NodePath = (string | number)[];

export interface NumberFieldSchema {
  kind: 'number';
  step?: number;
  min?: number;
  max?: number;
  int?: boolean;
}

export interface StringFieldSchema { kind: 'string' }
export interface BoolFieldSchema { kind: 'bool' }

/** 0xRRGGBB stored as a plain number (LevelDef convention). */
export interface ColorFieldSchema { kind: 'color' }

export interface EnumFieldSchema {
  kind: 'enum';
  options: readonly string[];
  labels?: Record<string, string>;
}

/** A unit heading { x, z } — rendered as a compass widget. */
export interface DirFieldSchema { kind: 'dir' }

/** Nested record by registry type name. */
export interface RecordFieldSchema { kind: 'record'; type: string }

export interface ListFieldSchema {
  kind: 'list';
  /** Item type name in the registry (list items are always records here). */
  item: string;
  addable?: boolean;
  removable?: boolean;
  /** Factory for a freshly added item. */
  makeEmpty?: () => unknown;
  /** Short label for a list row in the hierarchy. */
  itemLabel?: (value: unknown, index: number) => string;
}

export type FieldSchema =
  | NumberFieldSchema
  | StringFieldSchema
  | BoolFieldSchema
  | ColorFieldSchema
  | EnumFieldSchema
  | DirFieldSchema
  | RecordFieldSchema
  | ListFieldSchema;

export interface FieldMetadata {
  label?: string;
  description?: string;
  /** Rendered greyed-out; the walker refuses writes. */
  readOnly?: boolean;
  /** Not rendered at all — preserved verbatim for JSON round-trip. */
  hidden?: boolean;
  /** Field may be absent from the object (optional in LevelDef). */
  optional?: boolean;
}

export interface RecordSchema {
  name: string;
  label?: string;
  /** Insertion order drives render order. */
  fields: Record<string, FieldSchema>;
  fieldMetadata?: Record<string, FieldMetadata>;
}

export type SchemaRegistry = Record<string, RecordSchema>;

export interface LevelSchema {
  rootType: string;
  registry: SchemaRegistry;
}
