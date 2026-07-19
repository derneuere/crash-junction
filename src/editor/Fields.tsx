// The generic form renderer — steward's FieldRenderer kind-dispatch pattern.
// RecordForm walks a RecordSchema's fields in insertion order and renders one
// widget per field kind; every edit funnels through onEdit(path, value) so
// the state layer owns commits/undo.

import type { ChangeEvent } from 'react';
import type { FieldMetadata, FieldSchema, NodePath, RecordSchema } from './schema/types';

export interface FieldEditProps {
  path: NodePath;
  field: FieldSchema;
  meta?: FieldMetadata;
  value: unknown;
  onEdit: (path: NodePath, value: unknown) => void;
}

const numToHex = (n: number) => `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
const hexToNum = (s: string) => parseInt(s.replace('#', ''), 16) >>> 0;

function NumberField({ path, field, meta, value, onEdit }: FieldEditProps) {
  const f = field as Extract<FieldSchema, { kind: 'number' }>;
  const num = typeof value === 'number' ? value : undefined;
  return (
    <input
      className="edNum"
      type="number"
      value={num ?? ''}
      placeholder={meta?.optional ? '—' : undefined}
      step={f.step ?? 1}
      min={f.min}
      max={f.max}
      disabled={meta?.readOnly}
      onChange={(e: ChangeEvent<HTMLInputElement>) => {
        const raw = e.target.value;
        if (raw === '') {
          if (meta?.optional) onEdit(path, undefined);
          return;
        }
        let v = Number(raw);
        if (!Number.isFinite(v)) return;
        if (f.int) v = Math.round(v);
        if (f.min !== undefined) v = Math.max(f.min, v);
        if (f.max !== undefined) v = Math.min(f.max, v);
        onEdit(path, v);
      }}
    />
  );
}

function StringField({ path, meta, value, onEdit }: FieldEditProps) {
  return (
    <input
      className="edText"
      type="text"
      value={typeof value === 'string' ? value : ''}
      disabled={meta?.readOnly}
      onChange={(e) => onEdit(path, e.target.value)}
    />
  );
}

function BoolField({ path, meta, value, onEdit }: FieldEditProps) {
  return (
    <input
      type="checkbox"
      checked={!!value}
      disabled={meta?.readOnly}
      onChange={(e) => onEdit(path, e.target.checked)}
    />
  );
}

function ColorField({ path, meta, value, onEdit }: FieldEditProps) {
  const num = typeof value === 'number' ? value : undefined;
  return (
    <span className="edColorWrap">
      <input
        type="color"
        value={num !== undefined ? numToHex(num) : '#888888'}
        disabled={meta?.readOnly}
        onChange={(e) => onEdit(path, hexToNum(e.target.value))}
      />
      <span className="edColorHex">{num !== undefined ? numToHex(num) : (meta?.optional ? '—' : '')}</span>
      {meta?.optional && num !== undefined && (
        <button className="edMini" title="clear" onClick={() => onEdit(path, undefined)}>×</button>
      )}
      {meta?.optional && num === undefined && (
        <button className="edMini" title="set" onClick={() => onEdit(path, 0x888888)}>+</button>
      )}
    </span>
  );
}

function EnumField({ path, field, meta, value, onEdit }: FieldEditProps) {
  const f = field as Extract<FieldSchema, { kind: 'enum' }>;
  return (
    <select
      className="edSelect"
      value={typeof value === 'string' ? value : ''}
      disabled={meta?.readOnly}
      onChange={(e) => onEdit(path, e.target.value === '' ? undefined : e.target.value)}
    >
      {meta?.optional && <option value="">—</option>}
      {f.options.map((o) => (
        <option key={o} value={o}>{f.labels?.[o] ?? o}</option>
      ))}
    </select>
  );
}

/** Unit heading { x, z } as a compass: 8 quick buttons + free angle. */
function DirField({ path, meta, value, onEdit }: FieldEditProps) {
  const dir = (value as { x: number; z: number } | undefined) ?? { x: 0, z: 1 };
  const angle = Math.round((Math.atan2(dir.x, dir.z) * 180) / Math.PI);
  const set = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    // 3-decimal rounding keeps the JSON tidy; the sim normalizes anyway
    onEdit(path, { x: Math.round(Math.sin(rad) * 1000) / 1000, z: Math.round(Math.cos(rad) * 1000) / 1000 });
  };
  const COMPASS: [string, number][] = [
    ['+Z', 0], ['NE', 45], ['+X', 90], ['SE', 135], ['−Z', 180], ['SW', -135], ['−X', -90], ['NW', -45],
  ];
  return (
    <span className="edDir">
      {COMPASS.map(([label, deg]) => (
        <button
          key={label}
          className={`edMini${angle === deg || (angle === -180 && deg === 180) ? ' on' : ''}`}
          disabled={meta?.readOnly}
          onClick={() => set(deg)}
        >
          {label}
        </button>
      ))}
      <input
        className="edNum edDirDeg"
        type="number"
        value={angle}
        step={5}
        disabled={meta?.readOnly}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) set(v);
        }}
        title="heading, degrees from +Z"
      />
    </span>
  );
}

export function FieldRenderer(props: FieldEditProps) {
  switch (props.field.kind) {
    case 'number': return <NumberField {...props} />;
    case 'string': return <StringField {...props} />;
    case 'bool': return <BoolField {...props} />;
    case 'color': return <ColorField {...props} />;
    case 'enum': return <EnumField {...props} />;
    case 'dir': return <DirField {...props} />;
    default: return null; // record/list rows are navigation, handled by RecordForm
  }
}

export interface RecordFormProps {
  record: RecordSchema;
  recordPath: NodePath;
  data: unknown;
  onEdit: (path: NodePath, value: unknown) => void;
  /** Navigate into a nested record/list (inspector breadcrumb descent). */
  onDescend?: (path: NodePath) => void;
  /** Field names the caller renders itself (e.g. mode's discriminated arms). */
  skip?: string[];
}

export function RecordForm({ record, recordPath, data, onEdit, onDescend, skip }: RecordFormProps) {
  const obj = (data ?? {}) as Record<string, unknown>;
  return (
    <div className="edForm">
      {Object.entries(record.fields).map(([name, field]) => {
        const meta = record.fieldMetadata?.[name];
        if (meta?.hidden || skip?.includes(name)) return null;
        const value = obj[name];
        if (meta?.optional && value === undefined && (field.kind === 'record' || field.kind === 'list')) {
          return null; // absent optional sub-object — nothing to show
        }
        const path = [...recordPath, name];
        if (field.kind === 'record' || field.kind === 'list') {
          const count = field.kind === 'list' && Array.isArray(value) ? ` (${value.length})` : '';
          return (
            <div className="edRow" key={name}>
              <label className="edLabel">{meta?.label ?? name}</label>
              <button className="edNav" onClick={() => onDescend?.(path)}>
                {field.kind === 'list' ? `open list${count}` : 'open'} ▸
              </button>
            </div>
          );
        }
        return (
          <div className="edRow" key={name} title={meta?.description}>
            <label className="edLabel">{meta?.label ?? name}</label>
            <FieldRenderer path={path} field={field} meta={meta} value={value} onEdit={onEdit} />
          </div>
        );
      })}
    </div>
  );
}
