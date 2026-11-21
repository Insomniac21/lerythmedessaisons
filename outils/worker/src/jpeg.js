export function decodeBase64(value) {
  if (typeof value !== "string") fail();
  const clean = value.replace(/\s/g, "");
  if (!clean || clean.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) fail();
  let binary;
  try {
    binary = atob(clean);
  } catch {
    fail();
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodeBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 4096, bytes.length)));
  }
  return btoa(binary);
}

function fail() {
  const error = new Error("photo");
  error.code = "photo";
  throw error;
}

export function stripJpegMetadata(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail();
  const chunks = [bytes.subarray(0, 2)];
  let i = 2;

  while (i < bytes.length) {
    if (bytes[i] !== 0xff) fail();
    const start = i;
    do {
      i += 1;
    } while (i < bytes.length && bytes[i] === 0xff);
    if (i >= bytes.length) fail();
    const marker = bytes[i];
    i += 1;
    if (marker === 0xd9) {
      chunks.push(Uint8Array.of(0xff, 0xd9));
      return concat(chunks);
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(Uint8Array.of(0xff, marker));
      continue;
    }
    if (i + 1 >= bytes.length) fail();
    const length = (bytes[i] << 8) | bytes[i + 1];
    if (length < 2 || i + length > bytes.length) fail();
    const end = i + length;
    const drop = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!drop) chunks.push(bytes.subarray(start, end));
    i = end;
    if (marker === 0xda) {
      const scanStart = i;
      while (i + 1 < bytes.length && !(bytes[i] === 0xff && bytes[i + 1] === 0xd9)) i += 1;
      if (i + 1 >= bytes.length) fail();
      chunks.push(bytes.subarray(scanStart, i));
      chunks.push(Uint8Array.of(0xff, 0xd9));
      return concat(chunks);
    }
  }
  fail();
}

function concat(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
