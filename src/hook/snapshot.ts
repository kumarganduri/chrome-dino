// Serializes the complete game state (Runner scalars + every component object)
// so a run can be checkpointed, replayed from any frame, and hashed.
//
// The walk distinguishes two kinds of references:
//   extern  – environment or constant objects (canvas, ctx, sprite sheet,
//             sprite/obstacle definitions, configs, the Runner as provider).
//             Stored as a name; on restore they resolve to the TARGET game's
//             objects, so a snapshot moves between games and engines.
//   value   – mutable game state (Trex, Horizon, obstacles, clouds, stars…).
//             Stored by value with a class tag; shared references keep their
//             identity via $ref ids.
//
// Restore rebuilds the value graph with Object.create(Class.prototype), so no
// vendored constructor (which would consume random numbers) runs.
export type Json = null | boolean | number | string | Json[] | {[k: string]: Json};

export interface SnapshotContext {
  externs: Map<object, string>;
  externsById: Map<string, object>;
  classes: Map<object, string>; // prototype → tag
  classesByTag: Map<string, object>; // tag → prototype
}

export function registerExterns(ctx: SnapshotContext, prefix: string, root: object): void {
  const seen = new Set<object>();
  const walk = (value: unknown, path: string) => {
    if (value === null || typeof value !== 'object' || seen.has(value as object)) {
      return;
    }
    seen.add(value as object);
    if (!ctx.externs.has(value as object)) {
      ctx.externs.set(value as object, path);
      ctx.externsById.set(path, value as object);
    }
    for (const [k, v] of Object.entries(value as object)) {
      walk(v, `${path}.${k}`);
    }
  };
  walk(root, prefix);
}

export function registerExtern(ctx: SnapshotContext, id: string, obj: object): void {
  ctx.externs.set(obj, id);
  ctx.externsById.set(id, obj);
}

function encodeNumber(n: number): Json {
  if (Number.isFinite(n)) {
    return Object.is(n, -0) ? {$num: '-0'} : n;
  }
  return {$num: String(n)};
}

export function serialize(ctx: SnapshotContext, roots: Record<string, unknown>): Json {
  const ids = new Map<object, number>();
  const encode = (value: unknown): Json => {
    switch (typeof value) {
      case 'number':
        return encodeNumber(value);
      case 'string':
      case 'boolean':
        return value;
      case 'undefined':
        return {$undef: true};
      case 'function':
        throw new Error('snapshot: unexpected function in game state');
    }
    if (value === null) {
      return null;
    }
    const obj = value as object;
    const extern = ctx.externs.get(obj);
    if (extern !== undefined) {
      return {$ext: extern};
    }
    const seenId = ids.get(obj);
    if (seenId !== undefined) {
      return {$ref: seenId};
    }
    const id = ids.size;
    ids.set(obj, id);
    if (Array.isArray(obj)) {
      return {$id: id, $arr: obj.map(encode)};
    }
    const proto = Object.getPrototypeOf(obj);
    const tag = proto === Object.prototype ? 'Object' : ctx.classes.get(proto);
    if (tag === undefined) {
      throw new Error(`snapshot: unregistered class ${proto?.constructor?.name}`);
    }
    const fields: {[k: string]: Json} = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'function') {
        continue; // bound handlers are environment, not state
      }
      fields[k] = encode(v);
    }
    return {$id: id, $class: tag, $fields: fields};
  };
  const out: {[k: string]: Json} = {};
  for (const [k, v] of Object.entries(roots)) {
    out[k] = encode(v);
  }
  return out;
}

export function deserialize(ctx: SnapshotContext, data: Json): Record<string, unknown> {
  const byId = new Map<number, unknown>();
  const decode = (value: Json): unknown => {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      throw new Error('snapshot: bare array');
    }
    if ('$num' in value) {
      return Number(value.$num);
    }
    if ('$undef' in value) {
      return undefined;
    }
    if ('$ext' in value) {
      const ext = ctx.externsById.get(value.$ext as string);
      if (!ext) {
        throw new Error(`snapshot: unknown extern ${value.$ext}`);
      }
      return ext;
    }
    if ('$ref' in value) {
      return byId.get(value.$ref as number);
    }
    if ('$arr' in value) {
      const arr: unknown[] = [];
      byId.set(value.$id as number, arr);
      for (const item of value.$arr as Json[]) {
        arr.push(decode(item));
      }
      return arr;
    }
    const tag = value.$class as string;
    const proto = tag === 'Object' ? Object.prototype : ctx.classesByTag.get(tag);
    if (!proto) {
      throw new Error(`snapshot: unknown class ${tag}`);
    }
    const obj = Object.create(proto);
    byId.set(value.$id as number, obj);
    for (const [k, v] of Object.entries(value.$fields as {[k: string]: Json})) {
      obj[k] = decode(v);
    }
    return obj;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as {[k: string]: Json})) {
    out[k] = decode(v);
  }
  return out;
}
