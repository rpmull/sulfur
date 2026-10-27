// MessagePort's structured values across the native host's JSON socket/stdin.
// A package may legitimately return an object containing our tag: escape it.
const TAG = '$sulfur-wire-v1';
const arrays = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};
export function encodeExtensionMessage(value) {
  return JSON.stringify(value, function (key, value) {
    const original = this[key];
    if (typeof original === 'bigint') return { [TAG]: 'bigint', value: String(original) };
    if (typeof original === 'number' && !Number.isFinite(original))
      return { [TAG]: 'number', value: String(original) };
    if (original instanceof Date) return { [TAG]: 'date', value: original.toISOString() };
    if (original instanceof ArrayBuffer)
      return { [TAG]: 'buffer', value: [...new Uint8Array(original)] };
    if (original instanceof DataView)
      return {
        [TAG]: 'view',
        value: [...new Uint8Array(original.buffer, original.byteOffset, original.byteLength)],
      };
    if (ArrayBuffer.isView(original))
      return {
        [TAG]: 'typed',
        name: original.constructor.name === 'Buffer' ? 'Uint8Array' : original.constructor.name,
        value: Array.from(original),
      };
    if (original instanceof Map) return { [TAG]: 'map', value: [...original] };
    if (original instanceof Set) return { [TAG]: 'set', value: [...original] };
    if (original && typeof original === 'object' && Object.hasOwn(original, TAG))
      return { [TAG]: 'object', value: Object.entries(original) };
    return value;
  });
}
export function decodeExtensionMessage(text) {
  return JSON.parse(text, (_key, value) => {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, TAG)) return value;
    switch (value[TAG]) {
      case 'bigint':
        return BigInt(value.value);
      case 'number':
        return Number(value.value);
      case 'date':
        return new Date(value.value);
      case 'buffer':
        return Uint8Array.from(value.value).buffer;
      case 'view':
        return new DataView(Uint8Array.from(value.value).buffer);
      case 'typed':
        if (!Object.hasOwn(arrays, value.name)) throw new Error('Unknown extension array type');
        return new arrays[value.name](value.value);
      case 'map':
        return new Map(value.value);
      case 'set':
        return new Set(value.value);
      case 'object':
        return Object.fromEntries(value.value);
      default:
        throw new Error('Unknown extension message value');
    }
  });
}
