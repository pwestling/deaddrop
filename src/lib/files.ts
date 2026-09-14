import { randomUUID } from "node:crypto";
import { head, put, issueSignedToken, presignUrl, get } from "@vercel/blob";
import { db } from "./db";
import { AppError } from "./errors";
import { MAX_INLINE_BYTES } from "./config";
import { requireScope, requireSpace, type Principal } from "./security";
import { fileInput } from "./validation";
import { store, type Attachment } from "./store";

async function reserve(principal: Principal, raw: unknown) {
  requireScope(principal, "deaddrop:write");
  const input = fileInput.parse(raw);
  requireSpace(principal, input.space);
  const spaces = await db.query("SELECT slug FROM dd_spaces WHERE slug=$1", [
    input.space,
  ]);
  if (!spaces.rows.length)
    throw new AppError(404, "not_found", "Space not found.");
  const id = randomUUID();
  const pathname = `attachments/${id}/${input.name}`;
  await db.query(
    `INSERT INTO dd_files(id,space,name,content_type,size,pathname,principal_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      input.space,
      input.name,
      input.content_type,
      input.size,
      pathname,
      principal.id,
    ],
  );
  return { id, pathname, ...input };
}

export async function createUpload(principal: Principal, raw: unknown) {
  const file = await reserve(principal, raw);
  const validUntil = Date.now() + 15 * 60 * 1000;
  const constraints = {
    pathname: file.pathname,
    maximumSizeInBytes: file.size,
    allowedContentTypes: [file.content_type],
    validUntil,
  };
  const signed = await issueSignedToken({
    ...constraints,
    operations: ["put"],
  });
  const { presignedUrl } = await presignUrl(signed, {
    ...constraints,
    operation: "put",
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
  });
  return {
    file_id: file.id,
    upload_url: presignedUrl,
    method: "PUT",
    headers: { "Content-Type": file.content_type },
    expires_at: new Date(validUntil).toISOString(),
    complete_url: `/api/v1/files/${file.id}/complete`,
  };
}

export async function completeUpload(principal: Principal, id: string) {
  requireScope(principal, "deaddrop:write");
  const result = await db.query<Attachment>(
    "SELECT * FROM dd_files WHERE id=$1 AND principal_id=$2",
    [id, principal.id],
  );
  const file = result.rows[0];
  if (!file) throw new AppError(404, "not_found", "Upload not found.");
  requireSpace(principal, file.space);
  if (file.status === "ready") return { file_id: id, status: "ready" };
  let blob;
  try {
    blob = await head(file.pathname);
  } catch {
    throw new AppError(
      409,
      "upload_incomplete",
      "Upload the file before completing it.",
    );
  }
  if (
    blob.pathname !== file.pathname ||
    blob.size !== Number(file.size) ||
    blob.contentType !== file.content_type
  ) {
    throw new AppError(
      409,
      "upload_mismatch",
      "The uploaded file does not match its reserved size and content type.",
    );
  }
  await db.query(
    "UPDATE dd_files SET status='ready',ready_at=now() WHERE id=$1",
    [id],
  );
  return { file_id: id, status: "ready" };
}

export async function uploadInline(
  principal: Principal,
  metadata: unknown,
  content: string,
) {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      content,
    ) ||
    !content
  )
    throw new AppError(
      400,
      "invalid_base64",
      "Provide standard base64-encoded file bytes.",
    );
  if (content.length > Math.ceil(MAX_INLINE_BYTES / 3) * 4)
    throw new AppError(
      413,
      "file_too_large",
      "JSON uploads are limited to 2 MiB; use a direct upload URL.",
    );
  const bytes = Buffer.from(content, "base64");
  const input = fileInput.parse(metadata);
  if (input.size !== bytes.length)
    throw new AppError(
      400,
      "size_mismatch",
      "The declared size does not match the file bytes.",
    );
  const file = await reserve(principal, input);
  await put(file.pathname, bytes, {
    access: "private",
    contentType: file.content_type,
    addRandomSuffix: false,
    allowOverwrite: false,
  });
  return completeUpload(principal, file.id);
}

export async function downloadLink(principal: Principal, id: string) {
  const file = await store.file(principal, id);
  if (file.status !== "ready")
    throw new AppError(409, "upload_incomplete", "This upload is not ready.");
  const signed = await issueSignedToken({
    pathname: file.pathname,
    operations: ["get"],
    validUntil: Date.now() + 5 * 60 * 1000,
  });
  const { presignedUrl } = await presignUrl(signed, {
    pathname: file.pathname,
    operation: "get",
    access: "private",
  });
  return {
    url: presignedUrl,
    name: file.name,
    content_type: file.content_type,
    size: Number(file.size),
    expires_at: new Date(signed.validUntil).toISOString(),
  };
}

export async function imageContent(principal: Principal, id: string) {
  const file = await store.file(principal, id);
  if (
    file.status !== "ready" ||
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
      file.content_type,
    )
  )
    throw new AppError(
      400,
      "not_image",
      "Use this tool for a ready PNG, JPEG, WebP, or GIF.",
    );
  if (Number(file.size) > MAX_INLINE_BYTES)
    throw new AppError(
      413,
      "image_too_large",
      "Use a download link for images larger than 2 MiB.",
    );
  const blob = await get(file.pathname, { access: "private" });
  if (!blob || blob.statusCode !== 200 || !blob.stream)
    throw new AppError(404, "not_found", "Image unavailable.");
  const buffer = await new Response(blob.stream).arrayBuffer();
  return {
    type: "image" as const,
    mimeType: file.content_type,
    data: Buffer.from(buffer).toString("base64"),
  };
}
