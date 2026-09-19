// upload-in-claudefler
// Cloudflare Worker. Big files are split into parts by the browser, every part is stored in R2,
// and the parts are stitched back into one stream behind a single permanent link.

const DEVICE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_ID_RE = /^[A-Za-z0-9]{10}$/;
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RISKY_TYPES = /html|xml|svg|javascript|xhtml/i;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

let schemaReady;

// The database is prepared automatically the first time the worker runs.
function ensureSchema(env) {
  schemaReady ??= (async () => {
    await env.DB.batch([
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS uploads (
          id TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          name TEXT NOT NULL,
          size INTEGER NOT NULL,
          type TEXT NOT NULL,
          chunk_size INTEGER NOT NULL,
          chunks INTEGER NOT NULL,
          status TEXT NOT NULL,
          legacy INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        )`
      ),
      env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS idx_uploads_owner ON uploads (owner, status, created_at DESC)"
      ),
    ]);
    // Files from the first version of this project (single object per file) stay reachable.
    const old = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'files'"
    ).first();
    if (old) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO uploads (id, owner, name, size, type, chunk_size, chunks, status, legacy, created_at)
         SELECT id, owner, name, size, type, size, 1, 'ready', 1, created_at FROM files WHERE size > 0`
      ).run();
    }
  })().catch((err) => {
    schemaReady = undefined;
    throw err;
  });
  return schemaReady;
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

function newId(length = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function cleanName(raw) {
  let name = String(raw ?? "");
  name = name.replace(/[\u0000-\u001f\u007f\\/]/g, "").trim().slice(0, 180);
  return name || "file";
}

const maxBytes = (env) => Math.floor((Number(env.MAX_UPLOAD_GB) || 20) * GIB);
// Each part must fit in one Worker request (100 MB limit), so it never goes above 95 MiB.
const chunkBytes = (env) => Math.min(Number(env.CHUNK_BYTES) || 90 * MIB, 95 * MIB);
const partKey = (row, n) => (row.legacy ? row.id : `${row.id}/${String(n).padStart(5, "0")}`);
const fileUrl = (origin, id, name) => `${origin}/f/${id}/${encodeURIComponent(name)}`;

function deviceOf(request) {
  const owner = request.headers.get("x-device-id") || "";
  return DEVICE_RE.test(owner) ? owner : null;
}

const getOwned = (env, id, owner) =>
  env.DB.prepare("SELECT * FROM uploads WHERE id = ?1 AND owner = ?2").bind(id, owner).first();

/* ---------- Upload ---------- */

async function handleStart(request, env) {
  const owner = deviceOf(request);
  if (!owner) return json({ error: "device" }, 400);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const size = Number(body?.size);
  if (!Number.isSafeInteger(size) || size <= 0) return json({ error: "empty" }, 400);
  if (size > maxBytes(env)) return json({ error: "too_big" }, 413);

  await ensureSchema(env);

  const name = cleanName(body.name);
  const type = String(body.type || "application/octet-stream").slice(0, 120);
  const chunkSize = chunkBytes(env);
  const chunks = Math.ceil(size / chunkSize);
  const now = Date.now();

  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newId();
    try {
      await env.DB.prepare(
        `INSERT INTO uploads (id, owner, name, size, type, chunk_size, chunks, status, legacy, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'uploading', 0, ?8)`
      )
        .bind(id, owner, name, size, type, chunkSize, chunks, now)
        .run();
      return json({ id, chunkSize, chunks }, 201);
    } catch (err) {
      if (!/UNIQUE|constraint/i.test(String(err))) throw err;
    }
  }
  return json({ error: "server" }, 500);
}

async function handleChunk(request, env, url) {
  const owner = deviceOf(request);
  if (!owner) return json({ error: "device" }, 400);
  const id = url.searchParams.get("id") || "";
  const n = Number(url.searchParams.get("n"));
  if (!FILE_ID_RE.test(id) || !Number.isInteger(n) || n < 0) return json({ error: "bad_request" }, 400);

  await ensureSchema(env);
  const row = await getOwned(env, id, owner);
  if (!row) return json({ error: "not_found" }, 404);
  if (row.status !== "uploading") return json({ error: "closed" }, 409);
  if (n >= row.chunks) return json({ error: "bad_request" }, 400);

  const expected = n === row.chunks - 1 ? row.size - (row.chunks - 1) * row.chunk_size : row.chunk_size;
  const length = Number(request.headers.get("content-length"));
  if (length !== expected || !request.body) return json({ error: "bad_chunk", expected }, 400);

  await env.BUCKET.put(partKey(row, n), request.body, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return json({ ok: true, n });
}

async function handleFinish(request, env, url, origin) {
  const owner = deviceOf(request);
  if (!owner) return json({ error: "device" }, 400);
  const id = url.searchParams.get("id") || "";
  if (!FILE_ID_RE.test(id)) return json({ error: "bad_request" }, 400);

  await ensureSchema(env);
  const row = await getOwned(env, id, owner);
  if (!row) return json({ error: "not_found" }, 404);

  if (row.status !== "ready") {
    // Every part must exist with exactly the right size before the file is published.
    const found = new Map();
    let cursor;
    do {
      const page = await env.BUCKET.list({ prefix: `${id}/`, cursor });
      for (const o of page.objects) found.set(o.key, o.size);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    const missing = [];
    for (let n = 0; n < row.chunks; n++) {
      const expected = n === row.chunks - 1 ? row.size - (row.chunks - 1) * row.chunk_size : row.chunk_size;
      if (found.get(partKey(row, n)) !== expected) missing.push(n);
    }
    if (missing.length) return json({ error: "incomplete", missing: missing.slice(0, 20) }, 409);

    await env.DB.prepare("UPDATE uploads SET status = 'ready' WHERE id = ?1 AND owner = ?2")
      .bind(id, owner)
      .run();
  }

  return json({
    id,
    name: row.name,
    size: row.size,
    type: row.type,
    created_at: row.created_at,
    url: fileUrl(origin, id, row.name),
  });
}

async function handleAbort(request, env, url) {
  const owner = deviceOf(request);
  if (!owner) return json({ error: "device" }, 400);
  const id = url.searchParams.get("id") || "";
  if (!FILE_ID_RE.test(id)) return json({ error: "bad_request" }, 400);

  await ensureSchema(env);
  const row = await getOwned(env, id, owner);
  // Only unfinished uploads can be cancelled. Finished files are never deleted.
  if (!row || row.status !== "uploading") return json({ ok: true });

  const keys = [];
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix: `${id}/`, cursor });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < keys.length; i += 500) await env.BUCKET.delete(keys.slice(i, i + 500));
  await env.DB.prepare("DELETE FROM uploads WHERE id = ?1 AND owner = ?2 AND status = 'uploading'")
    .bind(id, owner)
    .run();
  return json({ ok: true });
}

/* ---------- List ---------- */

async function handleList(request, env, origin) {
  const owner = deviceOf(request);
  if (!owner) return json({ error: "device" }, 400);
  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    `SELECT id, name, size, type, created_at FROM uploads
     WHERE owner = ?1 AND status = 'ready' ORDER BY created_at DESC LIMIT 500`
  )
    .bind(owner)
    .all();
  return json({ files: results.map((f) => ({ ...f, url: fileUrl(origin, f.id, f.name) })) });
}

/* ---------- Download: stitch the parts into one stream ---------- */

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (!suffix) return "bad";
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "bad";
  return { start, end };
}

function stitch(env, row, start, end) {
  const cs = row.chunk_size;
  const first = Math.floor(start / cs);
  const last = Math.floor(end / cs);
  let n = first;
  let reader = null;

  return new ReadableStream({
    async pull(controller) {
      try {
        for (;;) {
          if (!reader) {
            if (n > last) return controller.close();
            const from = Math.max(start, n * cs);
            const to = Math.min(end, (n + 1) * cs - 1);
            const obj = await env.BUCKET.get(partKey(row, n), {
              range: { offset: from - n * cs, length: to - from + 1 },
            });
            if (!obj || !obj.body) throw new Error(`missing part ${n} of ${row.id}`);
            reader = obj.body.getReader();
            n++;
          }
          const { done, value } = await reader.read();
          if (done) {
            reader = null;
            continue;
          }
          controller.enqueue(value);
          return;
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader?.cancel(reason);
    },
  });
}

async function handleFile(request, env, ctx, url) {
  const [, , id] = url.pathname.split("/");
  if (!FILE_ID_RE.test(id || "")) return new Response("Not found", { status: 404 });

  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT * FROM uploads WHERE id = ?1 AND status = 'ready'").bind(id).first();
  if (!row) return new Response("Not found", { status: 404 });

  const etag = `"${row.id}"`;
  const headers = new Headers({
    "content-type": row.type || "application/octet-stream",
    etag,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000, immutable",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
  });
  // Pages uploaded by users are isolated so they can never touch this site.
  if (RISKY_TYPES.test(row.type)) headers.set("content-security-policy", "sandbox");
  const dispo = url.searchParams.has("download") ? "attachment" : "inline";
  headers.set("content-disposition", `${dispo}; filename*=UTF-8''${encodeURIComponent(row.name)}`);

  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  let start = 0;
  let end = row.size - 1;
  let status = 200;
  const rangeHeader = request.headers.get("range");
  if (rangeHeader) {
    const r = parseRange(rangeHeader, row.size);
    if (r === "bad") return new Response(null, { status: 416, headers: { "content-range": `bytes */${row.size}` } });
    if (r) {
      ({ start, end } = r);
      status = 206;
      headers.set("content-range", `bytes ${start}-${end}/${row.size}`);
    }
  }
  const length = end - start + 1;
  headers.set("content-length", String(length));

  if (request.method === "HEAD") return new Response(null, { status, headers });

  const source = stitch(env, row, start, end);
  const { readable, writable } = new FixedLengthStream(length);
  ctx.waitUntil(source.pipeTo(writable).catch(() => {}));
  return new Response(readable, { status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    try {
      if (pathname === "/api/config" && method === "GET") {
        return json({ repo: env.REPO_URL || "", maxGb: Number(env.MAX_UPLOAD_GB) || 20 });
      }
      if (pathname === "/api/files" && method === "GET") return await handleList(request, env, url.origin);
      if (pathname === "/api/upload/start" && method === "POST") return await handleStart(request, env);
      if (pathname === "/api/upload/chunk" && method === "PUT") return await handleChunk(request, env, url);
      if (pathname === "/api/upload/finish" && method === "POST") {
        return await handleFinish(request, env, url, url.origin);
      }
      if (pathname === "/api/upload/abort" && method === "POST") return await handleAbort(request, env, url);
      if (pathname.startsWith("/f/") && (method === "GET" || method === "HEAD")) {
        return await handleFile(request, env, ctx, url);
      }
      if (pathname.startsWith("/api/") || pathname.startsWith("/f/")) return json({ error: "not_found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: "server" }, 500);
    }
  },
};
