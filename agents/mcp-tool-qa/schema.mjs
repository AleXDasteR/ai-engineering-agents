import { isDeepStrictEqual } from 'node:util';

const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems',
  '$schema', '$id', 'title', 'description', 'default', 'examples']);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

export function inspectSchema(schema, path = '$', depth = 0) {
  if (depth > 32) throw new Error('Schema nesting exceeds 32 levels');
  if (typeof schema === 'boolean') return [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Invalid schema at ' + path);
  const unsupported = Object.keys(schema).filter(key => !supported.has(key)).map(key => path + '.' + key);
  const declaredTypes = schema.type == null ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if ((schema.type != null && !declaredTypes.length) || declaredTypes.some(type => !types.has(type))) throw new Error('Unknown schema type at ' + path);
  if (schema.required != null && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'))) {
    throw new Error('Invalid required array at ' + path);
  }
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[key] != null && !Number.isFinite(schema[key])) throw new Error('Invalid ' + key + ' at ' + path);
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[key] != null && (!Number.isInteger(schema[key]) || schema[key] < 0)) throw new Error('Invalid ' + key + ' at ' + path);
  }
  if (schema.enum != null && (!Array.isArray(schema.enum) || !schema.enum.length)) throw new Error('Invalid enum at ' + path);
  if (schema.enum) {
    const seen = [];
    for (const item of schema.enum) {
      if (seen.some(previous => isDeepStrictEqual(previous, item))) throw new Error('Duplicate enum value at ' + path);
      seen.push(item);
    }
  }
  if (schema.properties != null) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) throw new Error('Invalid properties');
    for (const [key, value] of Object.entries(schema.properties)) unsupported.push(...inspectSchema(value, path + '.properties.' + key, depth + 1));
  }
  if (schema.items != null) unsupported.push(...inspectSchema(schema.items, path + '.items', depth + 1));
  if (schema.additionalProperties != null) unsupported.push(...inspectSchema(schema.additionalProperties, path + '.additionalProperties', depth + 1));
  return unsupported;
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

export function validateValue(schema, value, path = '$') {
  if (schema === true) return [];
  if (schema === false) return [path + ': false schema'];
  const errors = [];
  const declaredTypes = schema.type == null ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (declaredTypes.length && !declaredTypes.some(type => matchesType(value, type))) return [path + ': type'];
  if (schema.enum && !schema.enum.some(item => isDeepStrictEqual(item, value))) errors.push(path + ': enum');
  if (Object.hasOwn(schema, 'const') && !isDeepStrictEqual(schema.const, value)) errors.push(path + ': const');
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(path + ': minimum');
    if (schema.maximum != null && value > schema.maximum) errors.push(path + ': maximum');
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength != null && length < schema.minLength) errors.push(path + ': minLength');
    if (schema.maxLength != null && length > schema.maxLength) errors.push(path + ': maxLength');
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(path + ': minItems');
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(path + ': maxItems');
    if (schema.items != null) value.forEach((item, index) => errors.push(...validateValue(schema.items, item, path + '[' + index + ']')));
  } else if (value !== null && typeof value === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(path + '.' + key + ': required');
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) errors.push(...validateValue(schema.properties[key], item, path + '.' + key));
      else if (schema.additionalProperties === false) errors.push(path + '.' + key + ': additionalProperties');
      else if (typeof schema.additionalProperties === 'object') errors.push(...validateValue(schema.additionalProperties, item, path + '.' + key));
    }
  }
  return errors;
}
