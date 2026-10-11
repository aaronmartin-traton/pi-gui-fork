from __future__ import annotations

import base64
import binascii
import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass

from .m365 import UPLOAD_OPTIONS_SETS, token_claims

# M365 accepts an uploaded image as a message annotation. The client uploads the
# bytes to the substrate UploadFile endpoint, then references the returned docId
# from the chat turn. Mirrors the TypeScript proxy (packages/core/src/images.ts).

MAX_IMAGE_BYTES = int(os.environ.get("M365_IMAGE_MAX_BYTES", 20 * 1024 * 1024))
DEFAULT_UPLOAD_URL = "https://substrate.office.com/m365Copilot/UploadFile"
SUPPORTED_MEDIA_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
DATA_URL = re.compile(r"^data:(image/[a-z0-9.+-]+);base64,(.+)$", re.IGNORECASE | re.DOTALL)


@dataclass
class ImageInput:
    media_type: str
    data: bytes
    name: str | None = None


def _decode_data_url(url: str) -> tuple[str, bytes]:
    match = DATA_URL.match(url.strip())
    if not match:
        raise ValueError("image_url must be a data: URL or an http(s) URL")
    media_type = match.group(1).lower()
    if media_type == "image/jpg":
        media_type = "image/jpeg"
    try:
        data = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("image data URL is not valid base64") from None
    return media_type, data


def _fetch_url(url: str) -> tuple[str, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            media_type = (response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            data = response.read(MAX_IMAGE_BYTES + 1)
    except urllib.error.URLError as error:
        raise ValueError(f"could not fetch image: {error}") from None
    if not media_type.startswith("image/"):
        raise ValueError(f"remote image has non-image content type: {media_type or 'unknown'}")
    return media_type, data


def image_from_url(url: str) -> ImageInput:
    if url.startswith("data:"):
        media_type, data = _decode_data_url(url)
    elif url.startswith(("http://", "https://")):
        media_type, data = _fetch_url(url)
    else:
        raise ValueError("image_url must be a data: URL or an http(s) URL")
    if media_type not in SUPPORTED_MEDIA_TYPES:
        raise ValueError(f"unsupported image type: {media_type}")
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError(f"image is larger than the {MAX_IMAGE_BYTES // (1024 * 1024)} MB limit")
    if not data:
        raise ValueError("image is empty")
    return ImageInput(media_type=media_type, data=data)


def images_from_messages(messages: list) -> list[ImageInput]:
    images: list[ImageInput] = []
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict) or part.get("type") != "image_url":
                continue
            image_url = part.get("image_url")
            url = image_url.get("url") if isinstance(image_url, dict) else None
            if not isinstance(url, str) or not url:
                raise ValueError("image_url part is missing a url")
            images.append(image_from_url(url))
    return images


def _file_type(media_type: str) -> str:
    return "jpg" if media_type in {"image/jpeg", "image/jpg"} else media_type.split("/")[-1]


def _multipart(fields: list[tuple[str, str]]) -> tuple[bytes, str]:
    boundary = "----m365copilotproxy" + binascii.hexlify(os.urandom(8)).decode("ascii")
    chunks = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'
        for name, value in fields
    ]
    body = "".join(chunks) + f"--{boundary}--\r\n"
    return body.encode("utf-8"), f"multipart/form-data; boundary={boundary}"


def _upload(token: str, oid: str, tid: str, conversation_id: str, image: ImageInput, name: str) -> dict:
    data_url = f"data:{image.media_type};base64,{base64.b64encode(image.data).decode('ascii')}"
    fields = [("scenario", "UploadImage"), ("conversationId", conversation_id), ("FileBase64", data_url)]
    fields.extend(("optionsSets", value) for value in UPLOAD_OPTIONS_SETS)
    body, content_type = _multipart(fields)
    request = urllib.request.Request(
        os.environ.get("M365_UPLOAD_URL", DEFAULT_UPLOAD_URL), data=body, method="POST",
    )
    # Assign directly: Request.add_header() title-cases header names, which would
    # turn X-AnchorMailbox into X-anchormailbox.
    request.headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": content_type,
        "Accept": "application/json",
        "Origin": "https://m365.cloud.microsoft",
        "X-Variants": "feature.EnableImageSupportInUploadFile",
        "X-Scenario": "OfficeWebIncludedCopilot",
        "X-AnchorMailbox": f"Oid:{oid}@{tid}",
    }
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"M365 image upload failed: HTTP {error.code} {error.read()[:300]!r}") from None
    except urllib.error.URLError as error:
        raise RuntimeError(f"M365 image upload failed: {error}") from None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError("M365 image upload returned invalid JSON") from None
    doc_id = payload.get("docId")
    if (payload.get("result") or {}).get("value") != "Success" or not isinstance(doc_id, str) or not doc_id:
        raise RuntimeError(f"M365 image upload failed: {raw[:300]}")
    return payload


def prepare_image_attachments(token: str, conversation_id: str, images: list[ImageInput]) -> list[dict]:
    if not images:
        return []
    oid, tid = token_claims(token)
    attachments: list[dict] = []
    for index, image in enumerate(images):
        file_type = _file_type(image.media_type)
        name = image.name or f"image-{index + 1}.{file_type}"
        payload = _upload(token, oid, tid, conversation_id, image, name)
        uploaded_type = str(payload.get("fileType") or file_type).lstrip(".").lower()
        if uploaded_type == "jpeg":
            uploaded_type = "jpg"
        file_name = payload.get("fileName") or name
        attachments.append({
            "id": payload["docId"],
            "messageAnnotationMetadata": {
                "@type": "File",
                "annotationType": "File",
                "fileType": uploaded_type,
                "fileName": file_name,
            },
            "messageAnnotationType": "ImageFile",
        })
    return attachments
