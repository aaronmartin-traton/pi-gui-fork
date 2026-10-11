// Ports m365copilotproxy/images.py: image inputs fetched from data: URLs or
// http(s) URLs, then uploaded to the substrate UploadFile endpoint as multipart
// form data. The returned docId is referenced by the chat turn as a message
// annotation.

import * as http from "node:http";
import * as https from "node:https";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { InvalidRequestError, UpstreamError } from "./types.js";
import { tokenClaims, UPLOAD_OPTIONS_SETS } from "./m365.js";

const maxImageBytesEnv = process.env.M365_IMAGE_MAX_BYTES;
const maxImageBytesParsed = maxImageBytesEnv === undefined ? Number.NaN : Number.parseInt(maxImageBytesEnv, 10);
export const MAX_IMAGE_BYTES = Number.isFinite(maxImageBytesParsed) ? maxImageBytesParsed : 20 * 1024 * 1024;

export const DEFAULT_UPLOAD_URL = "https://substrate.office.com/m365Copilot/UploadFile";
export const SUPPORTED_MEDIA_TYPES: Readonly<Record<string, true>> = {
  "image/png": true,
  "image/jpeg": true,
  "image/webp": true,
  "image/gif": true,
};

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const textEncoder = new TextEncoder();

export interface ImageInput {
  mediaType: string;
  data: Uint8Array;
  name?: string | null;
}

export function decodeDataUrl(url: string): readonly [string, Uint8Array] {
  const match = DATA_URL.exec(url.trim());
  if (match === null) {
    throw new InvalidRequestError("image_url must be a data: URL or an http(s) URL");
  }
  let media_type = (match[1] ?? "").toLowerCase();
  if (media_type === "image/jpg") {
    media_type = "image/jpeg";
  }
  const encoded = match[2] ?? "";
  if (!CANONICAL_BASE64.test(encoded)) {
    throw new InvalidRequestError("image data URL is not valid base64");
  }
  const data = new Uint8Array(Buffer.from(encoded, "base64"));
  return [media_type, data];
}

export async function fetchUrl(url: string): Promise<readonly [string, Uint8Array]> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new InvalidRequestError(`could not fetch image: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new InvalidRequestError(`could not fetch image: HTTP ${response.status}`);
  }
  const header = response.headers.get("Content-Type") ?? "";
  const media_type = (header.split(";")[0] ?? "").trim().toLowerCase();
  const buffer = await response.arrayBuffer();
  const data = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, MAX_IMAGE_BYTES + 1));
  if (!media_type.startsWith("image/")) {
    throw new InvalidRequestError(`remote image has non-image content type: ${media_type || "unknown"}`);
  }
  return [media_type, data];
}

export async function imageFromUrl(url: string): Promise<ImageInput> {
  let media_type: string;
  let data: Uint8Array;
  if (url.startsWith("data:")) {
    [media_type, data] = decodeDataUrl(url);
  } else if (url.startsWith("http://") || url.startsWith("https://")) {
    [media_type, data] = await fetchUrl(url);
  } else {
    throw new InvalidRequestError("image_url must be a data: URL or an http(s) URL");
  }
  if (!Object.hasOwn(SUPPORTED_MEDIA_TYPES, media_type)) {
    throw new InvalidRequestError(`unsupported image type: ${media_type}`);
  }
  if (data.length > MAX_IMAGE_BYTES) {
    throw new InvalidRequestError(`image is larger than the ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB limit`);
  }
  if (data.length === 0) {
    throw new InvalidRequestError("image is empty");
  }
  return { mediaType: media_type, data };
}

export async function imagesFromMessages(messages: readonly Record<string, unknown>[]): Promise<ImageInput[]> {
  const images: ImageInput[] = [];
  for (const message of messages) {
    if (message["role"] !== "user") {
      continue;
    }
    const content = message["content"];
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content as readonly unknown[]) {
      if (typeof part !== "object" || part === null) {
        continue;
      }
      const record = part as Record<string, unknown>;
      if (record["type"] !== "image_url") {
        continue;
      }
      const image_url = record["image_url"];
      let url: unknown;
      if (typeof image_url === "object" && image_url !== null && "url" in image_url) {
        url = image_url.url;
      }
      if (typeof url !== "string" || url === "") {
        throw new InvalidRequestError("image_url part is missing a url");
      }
      images.push(await imageFromUrl(url));
    }
  }
  return images;
}

export function fileType(media_type: string): string {
  if (media_type === "image/jpeg" || media_type === "image/jpg") {
    return "jpg";
  }
  return media_type.split("/").slice(-1)[0] ?? "";
}

export function multipart(fields: readonly (readonly [string, string])[]): readonly [Uint8Array<ArrayBuffer>, string] {
  const boundary = "----m365copilotproxy" + randomBytes(8).toString("hex");
  const chunks: string[] = [];
  for (const [name, value] of fields) {
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  const body = chunks.join("") + `--${boundary}--\r\n`;
  return [textEncoder.encode(body), `multipart/form-data; boundary=${boundary}`];
}

export async function upload(
  token: string,
  oid: string,
  tid: string,
  conversation_id: string,
  image: ImageInput,
  name: string,
): Promise<Record<string, unknown>> {
  const data_url = `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`;
  const fields: Array<[string, string]> = [
    ["scenario", "UploadImage"],
    ["conversationId", conversation_id],
    ["FileBase64", data_url],
  ];
  for (const value of UPLOAD_OPTIONS_SETS) {
    fields.push(["optionsSets", value]);
  }
  const [body, content_type] = multipart(fields);
  const target = new URL(process.env.M365_UPLOAD_URL ?? DEFAULT_UPLOAD_URL);
  // Headers are assigned verbatim: fetch's Headers would lowercase every name,
  // and M365 expects the exact spellings below (e.g. X-AnchorMailbox).
  const send: (
    url: URL,
    options: http.RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => http.ClientRequest = target.protocol === "http:" ? http.request : https.request;
  const response = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const request = send(
      target,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": content_type,
          "Content-Length": String(body.byteLength),
          "Accept": "application/json",
          "Accept-Encoding": "identity",
          "Connection": "close",
          "Origin": "https://m365.cloud.microsoft",
          "X-Variants": "feature.EnableImageSupportInUploadFile",
          "X-Scenario": "OfficeWebIncludedCopilot",
          "X-AnchorMailbox": `Oid:${oid}@${tid}`,
        },
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
        response.on("error", reject);
      },
    );
    request.setTimeout(60000, () => request.destroy(new Error("M365 image upload timed out")));
    request.on("error", reject);
    request.write(body);
    request.end();
  });
  const raw = response.body.toString("utf-8");
  if (response.status < 200 || response.status >= 300) {
    throw new UpstreamError(`M365 image upload failed: HTTP ${response.status} ${raw.slice(0, 300)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UpstreamError("M365 image upload returned invalid JSON");
  }
  const payload = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const doc_id = payload["docId"];
  const result = payload["result"];
  let result_value: unknown;
  if (typeof result === "object" && result !== null && "value" in result) {
    result_value = result.value;
  }
  if (result_value !== "Success" || typeof doc_id !== "string" || doc_id === "") {
    throw new UpstreamError(`M365 image upload failed: ${raw.slice(0, 300)}`);
  }
  return payload;
}

export async function prepareImageAttachments(
  token: string,
  conversation_id: string,
  images: readonly ImageInput[],
): Promise<Record<string, unknown>[]> {
  if (images.length === 0) {
    return [];
  }
  const [oid, tid] = tokenClaims(token);
  const attachments: Record<string, unknown>[] = [];
  for (const [index, image] of images.entries()) {
    const file_type = fileType(image.mediaType);
    const name = image.name ? image.name : `image-${index + 1}.${file_type}`;
    const payload = await upload(token, oid, tid, conversation_id, image, name);
    const raw_file_type = payload["fileType"];
    let uploaded_type = (typeof raw_file_type === "string" && raw_file_type !== "" ? raw_file_type : file_type)
      .replace(/^\.+/, "")
      .toLowerCase();
    if (uploaded_type === "jpeg") {
      uploaded_type = "jpg";
    }
    const raw_file_name = payload["fileName"];
    const file_name = typeof raw_file_name === "string" && raw_file_name !== "" ? raw_file_name : name;
    // upload() already verified that docId is a non-empty string.
    const doc_id = payload["docId"];
    if (typeof doc_id !== "string" || doc_id === "") {
      throw new UpstreamError(`M365 image upload failed: ${JSON.stringify(payload).slice(0, 300)}`);
    }
    attachments.push({
      "id": doc_id,
      "messageAnnotationMetadata": {
        "@type": "File",
        "annotationType": "File",
        "fileType": uploaded_type,
        "fileName": file_name,
      },
      "messageAnnotationType": "ImageFile",
    });
  }
  return attachments;
}
