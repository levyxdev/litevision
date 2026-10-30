import { randomUUID } from "node:crypto";

export interface MultipartFile {
  name: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * Encodes a multipart/form-data body by hand. `FormData` rewrites every line break in a text field to CRLF while
 * encoding, which would change the prompt; this keeps text fields byte for byte.
 */
export function multipartBody(
  fields: Array<[string, string]>,
  files: MultipartFile[],
): { body: Uint8Array; contentType: string } {
  const boundary = `litevision-${randomUUID()}`;
  const encoder = new TextEncoder();
  const quote = (value: string) => value.replace(/["\r\n\\]/g, (char) => encodeURIComponent(char));
  const parts: Uint8Array[] = [];

  for (const [name, value] of fields) {
    parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    parts.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${quote(file.name)}"; filename="${quote(file.fileName)}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
      ),
      file.bytes,
      encoder.encode("\r\n"),
    );
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
