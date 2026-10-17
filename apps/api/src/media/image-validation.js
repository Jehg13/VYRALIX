import { inflateSync } from 'node:zlib';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 18 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 33 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function isValidPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 58 || buffer.length > MAX_PNG_BYTES ||
    !buffer.subarray(0, 8).equals(pngSignature)) return false;
  let offset = 8;
  let chunks = 0;
  let hasImageData = false;
  let imageDataEnded = false;
  let imageWidth = 0;
  let imageHeight = 0;
  let imageChannels = 0;
  const imageDataChunks = [];
  let imageDataSize = 0;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) return false;
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    const typeAndData = buffer.subarray(offset + 4, offset + 8 + length);
    if (crc32(typeAndData) !== buffer.readUInt32BE(offset + 8 + length)) return false;
    if (chunks === 0) {
      if (type !== 'IHDR' || length !== 13) return false;
      const width = buffer.readUInt32BE(offset + 8);
      const height = buffer.readUInt32BE(offset + 12);
      const bitDepth = buffer[offset + 16];
      const colorType = buffer[offset + 17];
      const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
      if (!width || !height || width > 4096 || height > 4096 || width * height > 8_000_000 ||
        bitDepth !== 8 || !channels || buffer[offset + 18] !== 0 ||
        buffer[offset + 19] !== 0 || buffer[offset + 20] !== 0) return false;
      imageWidth = width;
      imageHeight = height;
      imageChannels = channels;
    } else if (type === 'IHDR') return false;
    if (type === 'IDAT') {
      if (imageDataEnded || !length) return false;
      hasImageData = true;
      imageDataSize += length;
      if (imageDataSize > MAX_PNG_BYTES) return false;
      imageDataChunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    } else if (hasImageData && type !== 'IEND') imageDataEnded = true;
    if (type === 'IEND') {
      if (length !== 0 || !hasImageData || end !== buffer.length) return false;
      try {
        const decoded = inflateSync(Buffer.concat(imageDataChunks, imageDataSize), {
          maxOutputLength: MAX_DECOMPRESSED_BYTES,
        });
        const rowLength = imageWidth * imageChannels + 1;
        if (decoded.length !== rowLength * imageHeight) return false;
        for (let row = 0; row < imageHeight; row += 1) {
          if (decoded[row * rowLength] > 4) return false;
        }
        return true;
      } catch {
        return false;
      }
    }
    chunks += 1;
    offset = end;
  }
  return false;
}
