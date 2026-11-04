import { imageTypeOf, type ImageType } from "./images.ts";

/**
 * What a saved result file turned out to be, read from its own bytes, so litevision can tell the Agent what it got
 * rather than what it asked for (ADR 0006).
 */

/** What litevision could read from a result file's header. */
export interface MediaFacts {
  width: number;
  height: number;
  /** Videos only, when the container says. */
  seconds?: number;
}

/** Recognises an image or a video by its leading bytes; undefined when it is neither. */
export function fileTypeOf(bytes: Uint8Array): ImageType | undefined {
  const image = imageTypeOf(bytes);
  if (image !== undefined) return image;
  if (ascii(bytes, 4, 8) === "ftyp") {
    // AVIF and HEIC images use the same container as MP4; its brand tells them apart.
    const brand = ascii(bytes, 8, 12);
    if (brand === "avif" || brand === "avis") return { extension: "avif", mimeType: "image/avif" };
    if (["heic", "heix", "heim", "heis", "mif1", "msf1"].includes(brand)) return { extension: "heic", mimeType: "image/heic" };
    return brand.startsWith("qt") ? { extension: "mov", mimeType: "video/quicktime" } : { extension: "mp4", mimeType: "video/mp4" };
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { extension: "webm", mimeType: "video/webm" };
  return undefined;
}

/** The pixel size, and for a video its length, of a PNG, JPEG, WebP, GIF or MP4 file; undefined when it cannot be read. */
export function mediaFactsOf(bytes: Uint8Array): MediaFacts | undefined {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (fileTypeOf(bytes)?.extension) {
      case "png":
        return { width: view.getUint32(16), height: view.getUint32(20) };
      case "gif":
        return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
      case "jpg":
        return jpegSize(bytes, view);
      case "webp":
        return webpSize(bytes, view);
      case "mp4":
      case "mov":
        return mp4Facts(bytes, view);
      default:
        return undefined;
    }
  } catch {
    // A truncated or odd header: litevision simply does not know.
    return undefined;
  }
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** The first start-of-frame marker carries the size. */
/** A JPEG's size as shown: phones store portrait photos landscape and say so in EXIF, so a quarter turn swaps the sides. */
function jpegSize(bytes: Uint8Array, view: DataView): MediaFacts | undefined {
  let offset = 2;
  let turned = false;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xe1 && ascii(bytes, offset + 4, offset + 10) === "Exif\0\0") turned = exifTurnsQuarter(view, offset + 10);
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const width = view.getUint16(offset + 7);
      const height = view.getUint16(offset + 5);
      return turned ? { width: height, height: width } : { width, height };
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return undefined;
}

/** Whether the EXIF block at `tiff` says to show the image turned a quarter: Orientation (tag 0x0112) 5 to 8. */
function exifTurnsQuarter(view: DataView, tiff: number): boolean {
  try {
    const little = view.getUint16(tiff) === 0x4949; // "II"
    const ifd = tiff + view.getUint32(tiff + 4, little);
    const entries = view.getUint16(ifd, little);
    for (let index = 0; index < entries; index++) {
      const entry = ifd + 2 + index * 12;
      if (view.getUint16(entry, little) !== 0x0112) continue;
      const orientation = view.getUint16(entry + 8, little);
      return orientation >= 5 && orientation <= 8;
    }
  } catch {
    // A truncated EXIF block says nothing about orientation.
  }
  return false;
}

function webpSize(bytes: Uint8Array, view: DataView): MediaFacts | undefined {
  const chunk = ascii(bytes, 12, 16);
  if (chunk === "VP8X") {
    const read24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
    return { width: read24(24) + 1, height: read24(27) + 1 };
  }
  if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

/** The movie header gives the length; the first track header with a size is the picture. */
function mp4Facts(bytes: Uint8Array, view: DataView): MediaFacts | undefined {
  let seconds: number | undefined;
  let size: { width: number; height: number } | undefined;
  const walk = (start: number, end: number) => {
    let offset = start;
    while (offset + 8 <= end) {
      let length = view.getUint32(offset);
      const type = ascii(bytes, offset + 4, offset + 8);
      let header = 8;
      if (length === 1) {
        length = Number(view.getBigUint64(offset + 8));
        header = 16;
      } else if (length === 0) {
        length = end - offset;
      }
      if (length < header) return;
      const body = offset + header;
      if (type === "moov" || type === "trak") walk(body, Math.min(offset + length, end));
      if (type === "mvhd") {
        const version = bytes[body];
        const timescale = view.getUint32(body + (version === 1 ? 20 : 12));
        const duration = version === 1 ? Number(view.getBigUint64(body + 24)) : view.getUint32(body + 16);
        // A fragmented MP4 records 0 here; its length is then unknown, not zero.
        if (timescale > 0 && duration > 0) seconds = duration / timescale;
      }
      if (type === "tkhd" && size === undefined) {
        const at = body + (bytes[body] === 1 ? 88 : 76);
        const width = view.getUint32(at) / 65536;
        const height = view.getUint32(at + 4) / 65536;
        if (width >= 1 && height >= 1) size = { width: Math.round(width), height: Math.round(height) };
      }
      offset += length;
    }
  };
  walk(0, bytes.length);
  if (size === undefined) return undefined;
  return { ...size, ...(seconds === undefined ? {} : { seconds: Math.round(seconds * 100) / 100 }) };
}
