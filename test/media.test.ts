import { describe, expect, test } from "bun:test";
import { fileTypeOf, mediaFactsOf } from "../src/media.ts";
import { jpegOfSize, mp4Of, pngOfSize, tinyPng } from "./helpers.ts";

/** A JPEG whose EXIF says to show it turned a quarter (orientation 6), as phones save portrait photos. */
function rotatedJpegOfSize(width: number, height: number): Uint8Array {
  const tiff = [...Buffer.from("MM"), 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
  const exif = [...Buffer.from("Exif\0\0"), ...tiff];
  const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff, ...exif];
  const jpeg = jpegOfSize(width, height);
  return new Uint8Array([...jpeg.subarray(0, 2), ...app1, ...jpeg.subarray(2)]);
}

/** A WebP with an extended (VP8X) header, sizes stored minus one in 24 bits. */
function webpOfSize(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "latin1");
  bytes.write("WEBP", 8, "latin1");
  bytes.write("VP8X", 12, "latin1");
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

describe("reading what a result file is", () => {
  test("reads the pixel size and format of PNG, JPEG and WebP images", () => {
    expect(mediaFactsOf(tinyPng)).toEqual({ width: 1, height: 1, format: "png" });
    expect(mediaFactsOf(pngOfSize(1344, 768))).toEqual({ width: 1344, height: 768, format: "png" });
    expect(mediaFactsOf(jpegOfSize(1024, 768))).toEqual({ width: 1024, height: 768, format: "jpeg" });
    expect(mediaFactsOf(webpOfSize(1920, 1080))).toEqual({ width: 1920, height: 1080, format: "webp" });
  });

  test("reads a JPEG's size as shown, after its EXIF orientation", () => {
    expect(mediaFactsOf(rotatedJpegOfSize(4032, 3024))).toEqual({ width: 3024, height: 4032, format: "jpeg" });
  });

  test("reads an MP4's size and length, and names it a video", () => {
    const clip = mp4Of(1280, 720, 2.02);
    expect(fileTypeOf(clip)).toEqual({ extension: "mp4", mimeType: "video/mp4" });
    expect(mediaFactsOf(clip)).toEqual({ width: 1280, height: 720, seconds: 2.02, format: "mp4" });
  });

  test("leaves out a length the MP4 does not record, as a fragmented MP4's header does not", () => {
    expect(mediaFactsOf(mp4Of(1280, 720, 0))).toEqual({ width: 1280, height: 720, format: "mp4" });
  });

  test("names AVIF and HEIC images as images, though they share MP4's container", () => {
    const isoFile = (brand: string) => new Uint8Array([0, 0, 0, 24, ...Buffer.from(`ftyp${brand}`), 0, 0, 0, 0]);
    expect(fileTypeOf(isoFile("avif"))).toEqual({ extension: "avif", mimeType: "image/avif" });
    expect(fileTypeOf(isoFile("heic"))).toEqual({ extension: "heic", mimeType: "image/heic" });
    expect(fileTypeOf(isoFile("isom"))).toEqual({ extension: "mp4", mimeType: "video/mp4" });
  });

  test("says nothing about bytes it does not recognise or cannot finish reading", () => {
    expect(fileTypeOf(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
    expect(mediaFactsOf(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
    expect(mediaFactsOf(jpegOfSize(10, 10).subarray(0, 12))).toBeUndefined();
  });
});
