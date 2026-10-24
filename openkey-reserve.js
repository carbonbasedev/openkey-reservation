#!/usr/bin/env node
/**
 * OpenKey padel reservation CLI
 *
 * Uses the reservation flow reconstructed from the supplied OpenKey app:
 *   1) GET  /user/reservation/resource/{resource}/time/{start}/{end}/review
 *   2) POST /user/reservation/confirmation/{reservationId}/0
 *
 * Authentication material must be obtained legitimately for your own account.
 * This script does not extract credentials from OpenKey/SecureStore.
 *
 * Node.js 18+ (no npm dependencies).
 */

const crypto = require("crypto");

const API_BASE = process.env.OPENKEY_API_BASE || "https://api.sigese.huayra.com.ar/api/v3";
let TOKEN = process.env.OPENKEY_TOKEN || null;
let HMAC_SECRET = process.env.OPENKEY_HMAC_SECRET || null;

const LOGIN_DOCUMENT_TYPE_ID = process.env.OPENKEY_DOCUMENT_TYPE_ID || "1";
const LOGIN_DOCUMENT = process.env.OPENKEY_DOCUMENT || null;
const LOGIN_EMAIL = process.env.OPENKEY_EMAIL || LOGIN_DOCUMENT;
const LOGIN_PASSWORD = process.env.OPENKEY_PASSWORD || null;

const DEFAULTS = {
  resourceId: process.env.OPENKEY_RESOURCE_ID || "2199", // Q2 PADDLE from supplied captures
  accountId: process.env.OPENKEY_ACCOUNT_ID || "299",
  userId: process.env.OPENKEY_USER_ID || "997547",
  appType: process.env.OPENKEY_APP_TYPE || "openkey",
  appVersion: process.env.OPENKEY_APP_VERSION || "3.17.12",
  device: process.env.OPENKEY_DEVICE || "Android",
  uniqueId: process.env.OPENKEY_UNIQUE_ID || crypto.randomUUID(),
  duration: Number(process.env.OPENKEY_DURATION || 90),
};

function usage(exitCode = 0) {
  console.log(`
Uso:
  node openkey-reserve.js YYYY-MM-DD HH:MM [opciones]
  node openkey-reserve.js --days-from-now N --time HH:MM [opciones]

Ejemplo:
  node openkey-reserve.js 2026-10-27 18:30
  node openkey-reserve.js 2026-10-27 18:30 --duration 90 --dry-run

Opciones:
  --days-from-now N    Fecha objetivo = fecha Argentina + N días
  --time HH:MM          Hora objetivo con --days-from-now
  --duration MIN       Duración. Default: ${DEFAULTS.duration}
  --resource ID        Resource ID. Default: ${DEFAULTS.resourceId}
  --account ID         Account ID. Default: ${DEFAULTS.accountId}
  --user ID            User ID. Default: ${DEFAULTS.userId}
  --dry-run            Hace review pero NO confirma la reserva
  --yes                No pide confirmación interactiva
  --debug              Muestra URL, timestamps y respuesta (nunca imprime secretos)
  --help

Autenticación (elegí una):
  A) Login normal:
     OPENKEY_DOCUMENT
     OPENKEY_PASSWORD
     OPENKEY_EMAIL              opcional; default = OPENKEY_DOCUMENT
     OPENKEY_DOCUMENT_TYPE_ID   opcional; default = 1

  B) Sesión ya provisionada:
     OPENKEY_TOKEN
     OPENKEY_HMAC_SECRET

Variables opcionales:
  OPENKEY_API_BASE
  OPENKEY_RESOURCE_ID
  OPENKEY_ACCOUNT_ID
  OPENKEY_USER_ID
  OPENKEY_APP_VERSION
  OPENKEY_DEVICE
  OPENKEY_UNIQUE_ID

IMPORTANTE:
  OPENKEY_TOKEN y OPENKEY_HMAC_SECRET deben corresponder a tu propia sesión/cuenta
  y haber sido obtenidos por un mecanismo autorizado/provisionado por OpenKey.
`);
  process.exit(exitCode);
}

function argentinaDatePlusDays(days) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Cordoba",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const v = type => Number(parts.find(p => p.type === type).value);
  const d = new Date(Date.UTC(v("year"), v("month") - 1, v("day")));
  d.setUTCDate(d.getUTCDate() + days);
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function parseArgs(argv) {
  if (argv.includes("--help")) usage(0);
  const out = {
    date: null, time: null, daysFromNow: null,
    duration: DEFAULTS.duration, resourceId: DEFAULTS.resourceId,
    accountId: DEFAULTS.accountId, userId: DEFAULTS.userId,
    dryRun: false, yes: false, debug: false,
  };

  let i = 0;
  if (argv[0] && !argv[0].startsWith("--")) {
    out.date = argv[0];
    out.time = argv[1];
    i = 2;
  }

  for (; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--days-from-now") out.daysFromNow = Number(argv[++i]);
    else if (x === "--time") out.time = argv[++i];
    else if (x === "--duration") out.duration = Number(argv[++i]);
    else if (x === "--resource") out.resourceId = argv[++i];
    else if (x === "--account") out.accountId = argv[++i];
    else if (x === "--user") out.userId = argv[++i];
    else if (x === "--dry-run") out.dryRun = true;
    else if (x === "--yes") out.yes = true;
    else if (x === "--debug") out.debug = true;
    else throw new Error(`Opción desconocida: ${x}`);
  }

  if (out.daysFromNow !== null) {
    if (!Number.isInteger(out.daysFromNow) || out.daysFromNow < 0 || out.daysFromNow > 365)
      throw new Error("--days-from-now debe ser un entero entre 0 y 365.");
    if (!out.time) throw new Error("Con --days-from-now necesitás --time HH:MM.");
    out.date = argentinaDatePlusDays(out.daysFromNow);
  }

  if (!out.date || !out.time) usage(1);
  return out;
}

function cordobaEpochSeconds(date, time) {
  // Córdoba/Argentina is UTC-03 and has no current DST.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Fecha inválida. Usá YYYY-MM-DD.");
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error("Hora inválida. Usá HH:MM.");

  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  if (hh > 23 || mm > 59) throw new Error("Hora inválida.");

  const ms = Date.parse(
    `${String(y).padStart(4,"0")}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}T` +
    `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:00-03:00`
  );
  if (!Number.isFinite(ms)) throw new Error("Fecha/hora inválida.");
  return Math.floor(ms / 1000);
}

/**
 * Exact HMAC canonicalization reconstructed from buildHmacHeaders:
 *
 * salt + "\n" +
 * method + "\n" +
 * pathname without first "/" + "\n" +
 * query sorted by key, values encodeURIComponent() + "\n" +
 * timestamp
 */
function buildHmacHeaders(hmacSecret, method, urlString) {
  const salt = crypto.randomBytes(16).toString("hex");
  const timestamp = Date.now().toString();
  const url = new URL(urlString);

  const pathname = url.pathname.replace(/^\//, "");

  const params = [];
  url.searchParams.forEach((value, key) => {
    params.push({ key, value: encodeURIComponent(value) });
  });

  params.sort((a, b) => a.key.localeCompare(b.key));
  const canonicalQuery = params.map(({key, value}) => `${key}=${value}`).join("&");

  const message = [salt, method, pathname, canonicalQuery, timestamp].join("\n");
  const signature = crypto
    .createHmac("sha256", hmacSecret)
    .update(message, "utf8")
    .digest("hex");

  return {
    "X-Signature": signature,
    "X-Salt": salt,
    "X-Timestamp": timestamp,
  };
}

async function loginIfNeeded(debug = false) {
  if (TOKEN && HMAC_SECRET) return;

  if (!LOGIN_DOCUMENT || !LOGIN_PASSWORD) {
    throw new Error(
      "Faltan credenciales. Configurá OPENKEY_DOCUMENT + OPENKEY_PASSWORD " +
      "o bien OPENKEY_TOKEN + OPENKEY_HMAC_SECRET."
    );
  }

  const url = `${API_BASE}/login`;
  const body = {
    document_type_id: LOGIN_DOCUMENT_TYPE_ID,
    document: LOGIN_DOCUMENT,
    email: LOGIN_EMAIL,
    password: LOGIN_PASSWORD,
    account_id: Number(DEFAULTS.accountId),
  };

  // Login occurs before the server provisions the per-session HMAC secret,
  // so it is intentionally not HMAC-signed.
  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "x-client-app-type": DEFAULTS.appType,
    "x-client-slug": DEFAULTS.appType,
    "x-client-version": DEFAULTS.appVersion,
    "x-client-device": DEFAULTS.device,
    "x-client-unique-id": DEFAULTS.uniqueId,
  };

  if (debug) console.error(`[debug] POST ${url} (login)`);

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; }
  catch { json = { raw: text }; }

  if (!res.ok || !json?.success) {
    const err = new Error(`Login OpenKey falló: HTTP ${res.status}`);
    err.status = res.status;
    err.data = json;
    throw err;
  }

  TOKEN = json?.data?.token;
  HMAC_SECRET = json?.data?.hmac_secret;

  if (!TOKEN || !HMAC_SECRET) {
    throw new Error("El login respondió OK pero no devolvió token/hmac_secret.");
  }

  if (debug) {
    console.error(`[debug] login OK; user_id=${json?.data?.user_id ?? "?"}`);
    console.error("[debug] token y hmac_secret recibidos (valores ocultos)");
  }
}

function headersFor(method, url) {
  const hmac = buildHmacHeaders(HMAC_SECRET, method, url);

  return {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Authorization": `Bearer ${TOKEN}`,
    "x-client-app-type": DEFAULTS.appType,
    "x-client-slug": DEFAULTS.appType,
    "x-client-version": DEFAULTS.appVersion,
    "x-client-device": DEFAULTS.device,
    "x-client-unique-id": DEFAULTS.uniqueId,
    ...hmac,
  };
}

async function requestJson(method, url, body, debug = false) {
  const headers = headersFor(method, url);

  if (debug) {
    console.error(`[debug] ${method} ${url}`);
    console.error(`[debug] X-Timestamp=${headers["X-Timestamp"]}`);
    console.error(`[debug] X-Salt=${headers["X-Salt"]}`);
    // Deliberately don't print Authorization, HMAC secret, or signature.
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { data = { raw: text }; }

  if (!res.ok) {
    const err = new Error(`OpenKey respondió HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  if (debug) console.error("[debug] respuesta:", JSON.stringify(data, null, 2));
  return data;
}

function findReservationId(data) {
  const candidates = [
    data?.reservation?.id,
    data?.data?.reservation?.id,
    data?.data?.id,
    data?.id,
  ];
  return candidates.find(v => v !== undefined && v !== null);
}

async function askYesNo(question) {
  process.stdout.write(question);
  return await new Promise(resolve => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", d => resolve(/^s(i)?\b|^y(es)?\b/i.test(d.trim())));
  });
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));

  await loginIfNeeded(opt.debug);

  if (!Number.isFinite(opt.duration) || opt.duration <= 0 || opt.duration > 360) {
    throw new Error("--duration debe ser un número razonable de minutos.");
  }

  const start = cordobaEpochSeconds(opt.date, opt.time);
  const end = start + Math.round(opt.duration * 60);

  const reviewUrl =
    `${API_BASE}/user/reservation/resource/${encodeURIComponent(opt.resourceId)}` +
    `/time/${start}/${end}/review`;

  console.log(`\nOpenKey / Padel`);
  console.log(`Fecha:    ${opt.date}`);
  console.log(`Hora:     ${opt.time}`);
  console.log(`Duración: ${opt.duration} min`);
  console.log(`Resource: ${opt.resourceId}`);
  console.log(`Epoch:    ${start} → ${end}`);

  console.log("\n1/2 Consultando disponibilidad / creando hold...");
  const review = await requestJson("GET", reviewUrl, undefined, opt.debug);

  const reservationId = findReservationId(review);
  if (!reservationId) {
    console.log("\nNo encontré un reservation.id en la respuesta.");
    console.log(JSON.stringify(review, null, 2));
    process.exit(3);
  }

  console.log(`Hold creado. Reservation ID: ${reservationId}`);

  if (opt.dryRun) {
    console.log("DRY RUN: no se enviará la confirmación.");
    return;
  }

  if (!opt.yes) {
    const ok = await askYesNo(`¿Confirmar la reserva ${opt.date} ${opt.time}? [s/N] `);
    if (!ok) {
      console.log("Cancelado. No se envió la confirmación.");
      return;
    }
  }

  const confirmationUrl =
    `${API_BASE}/user/reservation/confirmation/${encodeURIComponent(reservationId)}/0`;

  const body = {
    terms: true,
    shifts: 0,
    quota: 1,
    comments: "",
    doubles: false,
    isWaitingList: false,
    reservationIdsToCancel: [],
  };

  console.log("\n2/2 Confirmando reserva...");
  const confirmation = await requestJson("POST", confirmationUrl, body, opt.debug);

  console.log("\n✓ Solicitud de reserva confirmada por la API.");
  console.log(`Reservation ID: ${reservationId}`);

  const status =
    confirmation?.reservation?.status ??
    confirmation?.data?.reservation?.status ??
    confirmation?.data?.status ??
    confirmation?.status;

  if (status !== undefined) console.log(`Status: ${status}`);

  if (opt.debug) console.log(JSON.stringify(confirmation, null, 2));
}

main().catch(err => {
  console.error(`\nERROR: ${err.message}`);
  if (err.data) console.error(JSON.stringify(err.data, null, 2));

  if (err.status === 401 || err.status === 403) {
    console.error(
      "\nLa sesión/firma fue rechazada. Verificá que TOKEN y HMAC_SECRET sean " +
      "credenciales vigentes y legítimamente provisionadas para la misma cuenta/sesión."
    );
  }
  process.exit(1);
});
