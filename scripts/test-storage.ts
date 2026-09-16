import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  signedUpload,
  signedDownload,
  deleteFile,
  headFile,
  readFileBytes,
} from "../src/lib/storage";

const file = {
  pathname: `verification/${randomUUID()}/original.txt`,
  size: 4,
  contentType: "text/plain",
};
async function main() {
  assert.equal(process.env.STORAGE_PROVIDER, "r2");
  const upload = await signedUpload(file, Date.now() + 900_000);
  const put = (headers: Record<string, string>, body = "test") =>
    fetch(upload.url, { method: "PUT", headers, body });
  assert.ok(
    [400, 403].includes(
      (await put({ ...upload.headers, "Content-Type": "text/html" })).status,
    ),
    "MIME tampering must fail",
  );
  const withoutCondition = { ...upload.headers };
  delete withoutCondition["If-None-Match"];
  assert.ok(
    [400, 403].includes((await put(withoutCondition)).status),
    "Removing the overwrite restriction must fail",
  );
  assert.ok(
    [400, 403].includes(
      (await put({ ...upload.headers, "Content-Length": "5" }, "tests")).status,
    ),
    "Size tampering must fail",
  );
  assert.equal((await put(upload.headers)).status, 200);
  assert.equal((await put(upload.headers)).status, 412);
  assert.deepEqual(await headFile(file.pathname), file);
  assert.equal((await readFileBytes(file.pathname))?.toString(), "test");
  const download = await signedDownload(file.pathname, Date.now() + 300_000);
  assert.equal(await (await fetch(download)).text(), "test");
  const unsigned = new URL(download);
  unsigned.search = "";
  assert.ok(
    [400, 403].includes((await fetch(unsigned)).status),
    "Unsigned downloads must fail",
  );
  const cors = await fetch(upload.url, {
    method: "OPTIONS",
    headers: {
      Origin: process.env.APP_URL!,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type,if-none-match",
    },
  });
  assert.equal(
    cors.headers.get("access-control-allow-origin"),
    process.env.APP_URL,
  );
  assert.ok(cors.ok);
  console.log(
    "PASS: private R2 access, signed size/type constraints, overwrite prevention, exact downloads and browser CORS.",
  );
}
main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Storage verification failed",
    );
    process.exitCode = 1;
  })
  .finally(() => deleteFile(file.pathname));
