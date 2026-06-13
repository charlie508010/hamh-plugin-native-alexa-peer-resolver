import express from "express";
import { CookieJar } from "tough-cookie";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import crypto from "node:crypto";
import path from "node:path";

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  amazonDomain: "amazon.de",
  alexaHost: "alexa.amazon.de",
  proxyHost: "172.20.48.110",
  proxyPort: 36701,
  scanInterval: 30,
  voiceHistoryEnabled: true,
  voiceHistoryShowGeneral: true,
  voiceHistoryShowWakeWordOnly: false,
  voiceHistoryShowRoutines3p: false,
  voiceHistoryLogEntries: true,
  voiceHistoryAfterActionEnabled: true,
  voiceHistoryAfterActionDelaySeconds: 2,
  voiceHistoryActionMatchWindowSeconds: 10,
  uiActions: JSON.stringify(
    [
      {
        id: "startLogin",
        label: "Amazon Login",
        showWhen: "offline",
        variant: "outlined",
        color: "primary",
        tooltip: "Open Amazon browser login"
      },
      {
        id: "scanDevices",
        label: "Scan Alexa Devices",
        showWhen: "connected",
        variant: "outlined",
        color: "primary",
        tooltip: "Refresh sanitized Alexa device list"
      },
      {
        id: "scanVoiceHistory",
        label: "Scan Voice History",
        showWhen: "connected",
        variant: "outlined",
        color: "primary",
        tooltip: "Fetch recent Alexa voice history"
      },
      {
        id: "deleteCookie",
        label: "Delete Verbindung",
        showWhen: "connected",
        variant: "outlined",
        color: "error",
        confirmText: "Alexa Verbindung wirklich löschen?"
      }
    ],
    null,
    2
  ),
  uiTables: JSON.stringify(
    [
      {
        id: "alexa-devices",
        title: "Alexa Devices",
        show: true,
        collapsible: true,
        defaultCollapsed: false,
        emptyText: "No Alexa devices scanned yet",
        source: "device-list",
        columns: [
          { key: "name", label: "Name", width: "minmax(150px, 1.2fr)" },
          { key: "serial", label: "Serial", width: "minmax(170px, 1.15fr)" },
          { key: "deviceTypeLabel", label: "Type", width: "minmax(130px, 0.9fr)" },
          { key: "peer", label: "Peer", width: "minmax(250px, 1.45fr)" },
          { key: "ip", label: "IP", width: "minmax(130px, 0.8fr)" },
          { key: "online", label: "Status", width: "minmax(100px, 0.7fr)", type: "status" }
        ]
      },
      {
        id: "alexa-voice-history",
        title: "Alexa Voice History",
        show: true,
        collapsible: true,
        defaultCollapsed: false,
        emptyText: "No Alexa voice history scanned yet",
        source: "voice-history",
        columns: [
          { key: "time", label: "Time", width: "minmax(170px, 1fr)" },
          { key: "device", label: "Echo", width: "minmax(150px, 1fr)" },
          { key: "utterance", label: "Utterance", width: "minmax(240px, 1.6fr)" },
          { key: "response", label: "Response", width: "minmax(240px, 1.6fr)" },
          { key: "status", label: "Status", width: "minmax(130px, 0.8fr)", type: "chip" }
        ]
      }
    ],
    null,
    2
  )
});

const DATA_ROOT = "/config/data";
const SQLITE_ROOT = path.join(DATA_ROOT, "sqlite");
const STORAGE_BACKEND =
  process.env.HAMH_STORAGE_BACKEND === "file" ? "file" : "sqlite";
const ACTIVE_ROOT = path.join(DATA_ROOT, STORAGE_BACKEND);
const COOKIE_FILE = path.join(ACTIVE_ROOT, "alexa-cookie.json");
const COOKIE_COPY_FILE = path.join(DATA_ROOT, "alexa-cookie.json");
const LOGIN_DEVICE_FILE = path.join(ACTIVE_ROOT, "alexa-login-device.json");
const STATUS_FILE = path.join(ACTIVE_ROOT, "alexa-login-status.json");
const DEVICES_FILE = path.join(ACTIVE_ROOT, "alexa-devices.json");
const VOICE_HISTORY_FILE = path.join(ACTIVE_ROOT, "alexa-voice-history.json");
const VOICE_HISTORY_STATUS_FILE = path.join(ACTIVE_ROOT, "alexa-voice-history-status.json");
const PEER_MAP_FILE = path.join(ACTIVE_ROOT, "alexa-peer-map.json");
const PEER_MAP_COPY_FILE = path.join(DATA_ROOT, "alexa-peer-map.json");
const MATTER_PEERS_FILE = path.join(ACTIVE_ROOT, "matter-peers.json");
const MATTER_PEERS_FALLBACK_FILE = path.join(DATA_ROOT, "matter-peers.json");
const SQLITE_COOKIE_FILE = path.join(SQLITE_ROOT, "alexa-cookie.json");
const SQLITE_STATUS_FILE = path.join(SQLITE_ROOT, "alexa-login-status.json");
const SQLITE_PEER_MAP_FILE = path.join(SQLITE_ROOT, "alexa-peer-map.json");
const SQLITE_MATTER_PEERS_FILE = path.join(SQLITE_ROOT, "matter-peers.json");

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const AMAZON_LOGIN_BASE_DOMAIN = "amazon.com";
const VOICE_HISTORY_AMAZON_DOMAIN = "amazon.com";
const ALEXA_APP_VERSION = "2.2.556530.0";
const ALEXA_DI_OS_VERSION = "16.6";
const ALEXA_DI_SDK_VERSION = "6.12.4";
const ALEXA_APP_UA =
  `AmazonWebView/Amazon Alexa/${ALEXA_APP_VERSION}/iOS/${ALEXA_DI_OS_VERSION}/iPhone`;
const VOICE_HISTORY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const VOICE_HISTORY_MATCH_DEDUPE_MS = 2000;
const KNOWN_LOCAL_ALEXA_PEER_MAP = Object.freeze({
  "dc:91:bf:4f:81:32": { name: "Echo-Plus", serial: "G090XG10024605L7" },
  "68:9a:87:88:d3:94": { name: "Echo Katrin", serial: "G090U50984850PJ5" },
  "e8:4c:4a:11:2a:4e": { name: "Martins Echo Dot", serial: "G0922N06335704V6" },
  "68:f6:3b:e6:9b:b3": { name: "Katrin Echo Dot", serial: "G0922N06335701DM" }
});

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function createProxyLoginState() {
  const serial = crypto.randomBytes(16).toString("hex");
  const deviceId = Buffer.from(`${crypto.randomBytes(16).toString("hex").toUpperCase()}#A2IVLV5VM2W81`).toString("hex");

  return {
    deviceId,
    serial,
    initialCookies: {
      frc: crypto.randomBytes(313).toString("base64"),
      "map-md": Buffer.from(
        '{"device_user_dictionary":[],"device_registration_data":{"software_version":"1"},"app_identifier":{"app_version":"2.2.485407","bundle_id":"com.amazon.echo"}}'
      ).toString("base64")
    }
  };
}

function loadOrCreateProxyLoginState() {
  const existing = readJsonSync(LOGIN_DEVICE_FILE, undefined);
  if (
    existing?.deviceId &&
    existing?.serial &&
    existing?.initialCookies?.frc &&
    existing?.initialCookies?.["map-md"]
  ) {
    return existing;
  }

  const created = createProxyLoginState();
  writeJsonSync(LOGIN_DEVICE_FILE, created);
  return created;
}

function createAndSaveProxyLoginState() {
  const created = createProxyLoginState();
  writeJsonSync(LOGIN_DEVICE_FILE, created);
  return created;
}

function buildAmazonLoginPath(config, loginState) {
  const amazonDomain = VOICE_HISTORY_AMAZON_DOMAIN;
  const params = new URLSearchParams({
    "openid.return_to": `https://www.${amazonDomain}/ap/maplanding`,
    "openid.assoc_handle": "amzn_dp_project_dee_ios",
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    pageId: "amzn_dp_project_dee_ios",
    accountStatusPolicy: "P1",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.mode": "checkid_setup",
    "openid.ns.oa2": `http://www.${amazonDomain}/ap/ext/oauth/2`,
    "openid.oa2.client_id": `device:${loginState.deviceId}`,
    "openid.ns.pape": "http://specs.openid.net/extensions/pape/1.0",
    "openid.oa2.response_type": "token",
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.pape.max_auth_age": "0",
    "openid.oa2.scope": "device_auth_access"
  });

  return `/www.${amazonDomain}/ap/signin?${params.toString()}`;
}

function addInitialCookies(cookieHeader, initialCookies) {
  let result = cookieHeader ?? "";
  for (const [name, value] of Object.entries(initialCookies)) {
    if (!result.includes(`${name}=`)) {
      result += `${result ? "; " : ""}${name}=${value}`;
    }
  }
  return result;
}

function rewriteProxyUrl(value, config) {
  if (!value) {
    return value;
  }

  const amazonDomain = config.amazonDomain.replace(/\./g, "\\.");
  const loginBaseDomain = AMAZON_LOGIN_BASE_DOMAIN.replace(/\./g, "\\.");
  const alexaHost = config.alexaHost.replace(/\./g, "\\.");
  return String(value)
    .replace(new RegExp(`https?://www\\.${loginBaseDomain}/`, "g"), `http://${config.proxyHost}:${config.proxyPort}/www.${AMAZON_LOGIN_BASE_DOMAIN}/`)
    .replace(new RegExp(`https?://www\\.${amazonDomain}/`, "g"), `http://${config.proxyHost}:${config.proxyPort}/www.${config.amazonDomain}/`)
    .replace(new RegExp(`https?://${alexaHost}/`, "g"), `http://${config.proxyHost}:${config.proxyPort}/${config.alexaHost}/`);
}

function rewriteProxyUrlBack(value, config) {
  if (!value) {
    return value;
  }

  const localAmazon = `http://${config.proxyHost}:${config.proxyPort}/www.${config.amazonDomain}/`;
  const localLoginAmazon = `http://${config.proxyHost}:${config.proxyPort}/www.${AMAZON_LOGIN_BASE_DOMAIN}/`;
  const localAlexa = `http://${config.proxyHost}:${config.proxyPort}/${config.alexaHost}/`;
  return String(value)
    .replaceAll(localLoginAmazon, `https://www.${AMAZON_LOGIN_BASE_DOMAIN}/`)
    .replaceAll(localAmazon, `https://www.${config.amazonDomain}/`)
    .replaceAll(localAlexa, `https://${config.alexaHost}/`);
}

function removeSecureCookieFlag(cookie) {
  return String(cookie).replace(/;\s*Secure/gi, "");
}

function rewriteSetCookieForLocalProxy(cookie) {
  return removeSecureCookieFlag(cookie)
    .replace(/;\s*Domain=[^;]+/gi, "")
    .replace(/;\s*SameSite=None/gi, "");
}

function shouldRewriteBody(contentType) {
  if (!/(text\/html|application\/javascript|text\/javascript|text\/css|application\/json)/i.test(contentType)) {
    return false;
  }

  return true;
}

async function readRequestBody(request) {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

function targetPathFromRequest(request, mountPath) {
  const originalUrl = request.originalUrl ?? request.url ?? "/";
  if (originalUrl.startsWith(mountPath)) {
    return originalUrl.slice(mountPath.length) || "/";
  }

  return request.url || "/";
}

function copyRequestHeaders(request, config, loginState, targetHost) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (["host", "connection", "content-length", "accept-encoding"].includes(lower)) {
      continue;
    }
    if (Array.isArray(value)) {
      headers.set(name, value.join(", "));
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }

  headers.set("cookie", addInitialCookies(headers.get("cookie") ?? "", loginState.initialCookies));
  headers.set("user-agent", BROWSER_UA);
  headers.set("accept-language", "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7");

  const referer = headers.get("referer");
  if (referer) {
    headers.set("referer", rewriteProxyUrlBack(referer, config));
  }

  if (headers.has("origin")) {
    headers.set("origin", `https://${targetHost}`);
  }

  return headers;
}

function copyResponseHeaders(upstreamResponse, response) {
  for (const [name, value] of upstreamResponse.headers.entries()) {
    const lower = name.toLowerCase();
    if (
      [
        "connection",
        "content-encoding",
        "content-length",
        "set-cookie",
        "transfer-encoding"
      ].includes(lower)
    ) {
      continue;
    }
    response.setHeader(name, value);
  }
}

function upstreamSetCookies(upstreamResponse) {
  if (typeof upstreamResponse.headers.getSetCookie === "function") {
    return upstreamResponse.headers.getSetCookie();
  }

  const setCookie = upstreamResponse.headers.get("set-cookie");
  return setCookie ? [setCookie] : [];
}

function cookieToAmazonPayload(cookie) {
  return {
    Name: cookie.key,
    Value: cookie.value,
    Secure: String(Boolean(cookie.secure)),
    HttpOnly: String(Boolean(cookie.httpOnly))
  };
}

function websiteCookiesForRegister(jar) {
  return jar.getCookiesSync(`https://www.${AMAZON_LOGIN_BASE_DOMAIN}/`).map(cookieToAmazonPayload);
}

function seedLoginCookies(jar, loginState) {
  for (const [name, value] of Object.entries(loginState.initialCookies)) {
    jar.setCookieSync(`${name}=${value}; Path=/`, `https://www.${AMAZON_LOGIN_BASE_DOMAIN}/`, { ignoreError: true });
  }
}

function cookieStringForUrl(jar, url) {
  return jar.getCookiesSync(url).map((cookie) => `${cookie.key}=${cookie.value}`).join("; ");
}

function addAmazonCookiePayload(jar, cookie, domain) {
  if (!cookie?.Name || cookie.Value === undefined) {
    return;
  }

  const parts = [
    `${cookie.Name}=${cookie.Value}`,
    `Domain=${domain}`,
    `Path=${cookie.Path || "/"}`,
    cookie.Secure === "true" || cookie.Secure === true ? "Secure" : "",
    cookie.HttpOnly === "true" || cookie.HttpOnly === true ? "HttpOnly" : ""
  ].filter(Boolean);

  jar.setCookieSync(parts.join("; "), `https://${domain.replace(/^\./, "")}/`, {
    ignoreError: true
  });
}

function extractAccessToken(location) {
  const value = String(location ?? "");
  for (const separator of ["#", "?"]) {
    const index = value.indexOf(separator);
    if (index === -1) {
      continue;
    }

    const params = new URLSearchParams(value.slice(index + 1));
    const token = params.get("openid.oa2.access_token") ?? params.get("access_token");
    if (token) {
      return token;
    }
  }

  return "";
}

async function registerAppAndExchangeCookies(jar, config, loginState, accessToken) {
  const registerPayload = {
    requested_extensions: ["device_info", "customer_info"],
    cookies: {
      website_cookies: websiteCookiesForRegister(jar),
      domain: ".amazon.com"
    },
    registration_data: {
      domain: "Device",
      app_version: ALEXA_APP_VERSION,
      device_type: "A2IVLV5VM2W81",
      device_name: "HAMH Alexa Peer Resolver",
      os_version: ALEXA_DI_OS_VERSION,
      device_serial: loginState.serial,
      device_model: "iPhone",
      app_name: "HAMH Alexa Peer Resolver",
      software_version: "1"
    },
    auth_data: {
      access_token: accessToken
    },
    user_context_map: {
      frc: loginState.initialCookies.frc
    },
    requested_token_type: ["bearer", "mac_dms", "website_cookies"]
  };

  const registerCookieHeader = await cookieStringForUrl(jar, `https://www.${AMAZON_LOGIN_BASE_DOMAIN}/`);
  const registerResponse = await fetch("https://api.amazon.com/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Accept-Language": "en-US",
      "Accept-Charset": "utf-8",
      "Connection": "keep-alive",
      "User-Agent": ALEXA_APP_UA,
      "Cookie": registerCookieHeader,
      "x-amzn-identity-auth-domain": "api.amazon.com"
    },
    body: JSON.stringify(registerPayload)
  });

  if (!registerResponse.ok) {
    const errorText = await registerResponse.text().catch(() => "");
    await rm(LOGIN_DEVICE_FILE, { force: true }).catch(() => {});
    throw new AuthRegisterError(registerResponse.status, errorText);
  }

  const registerJson = await registerResponse.json();
  const refreshToken = registerJson?.response?.success?.tokens?.bearer?.refresh_token;
  const websiteCookies = registerJson?.response?.success?.tokens?.website_cookies ?? [];
  for (const cookie of websiteCookies) {
    addAmazonCookiePayload(jar, cookie, ".amazon.com");
  }

  if (!refreshToken) {
    throw new Error("auth_register_missing_refresh_token");
  }

  const cookieDomain = config.amazonDomain;
  const cookiesBase64 = Buffer.from(JSON.stringify({ cookies: { [`.${cookieDomain}`]: [] } })).toString("base64");
  const form = new URLSearchParams({
    "di.os.name": "iOS",
    app_version: ALEXA_APP_VERSION,
    domain: `.${cookieDomain}`,
    source_token: refreshToken,
    requested_token_type: "auth_cookies",
    source_token_type: "refresh_token",
    "di.hw.version": "iPhone",
    "di.sdk.version": ALEXA_DI_SDK_VERSION,
    cookies: cookiesBase64,
    app_name: "Amazon Alexa",
    "di.os.version": ALEXA_DI_OS_VERSION
  });

  const exchangeResponse = await fetch(`https://www.${cookieDomain}/ap/exchangetoken`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "*/*",
      "Accept-Language": "en-US",
      "Accept-Charset": "utf-8",
      "Connection": "keep-alive",
      "User-Agent": ALEXA_APP_UA,
      "Cookie": "",
      "x-amzn-identity-auth-domain": `api.${cookieDomain}`
    },
    body: form.toString()
  });

  if (!exchangeResponse.ok) {
    throw new Error(`exchange_token_failed_${exchangeResponse.status}`);
  }

  const exchangeJson = await exchangeResponse.json();
  const cookieMap = exchangeJson?.response?.tokens?.cookies ?? {};
  for (const [domain, cookies] of Object.entries(cookieMap)) {
    if (!Array.isArray(cookies)) {
      continue;
    }
    for (const cookie of cookies) {
      addAmazonCookiePayload(jar, cookie, domain);
    }
  }

  await saveCookieJar(jar);
}

function mergeConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    proxyPort: Number(config.proxyPort ?? DEFAULT_CONFIG.proxyPort),
    scanInterval: Number(config.scanInterval ?? DEFAULT_CONFIG.scanInterval),
    voiceHistoryEnabled:
      config.voiceHistoryEnabled ?? DEFAULT_CONFIG.voiceHistoryEnabled,
    voiceHistoryShowGeneral:
      config.voiceHistoryShowGeneral ?? DEFAULT_CONFIG.voiceHistoryShowGeneral,
    voiceHistoryShowWakeWordOnly:
      config.voiceHistoryShowWakeWordOnly ??
      DEFAULT_CONFIG.voiceHistoryShowWakeWordOnly,
    voiceHistoryShowRoutines3p:
      config.voiceHistoryShowRoutines3p ??
      DEFAULT_CONFIG.voiceHistoryShowRoutines3p,
    voiceHistoryLogEntries:
      config.voiceHistoryLogEntries ?? DEFAULT_CONFIG.voiceHistoryLogEntries,
    voiceHistoryAfterActionEnabled:
      config.voiceHistoryAfterActionEnabled ??
      DEFAULT_CONFIG.voiceHistoryAfterActionEnabled,
    voiceHistoryAfterActionDelaySeconds: Number(
      config.voiceHistoryAfterActionDelaySeconds ??
        DEFAULT_CONFIG.voiceHistoryAfterActionDelaySeconds
    ),
    voiceHistoryActionMatchWindowSeconds: Number(
      config.voiceHistoryActionMatchWindowSeconds ??
        DEFAULT_CONFIG.voiceHistoryActionMatchWindowSeconds
    )
  };
}

function parseJsonConfig(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === "object")) {
    return value;
  }

  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

async function ensureDataDirs() {
  await mkdir(ACTIVE_ROOT, { recursive: true });
  await mkdir(DATA_ROOT, { recursive: true });
  await migrateFileBackendDataIfNeeded();
}

async function migrateFileBackendDataIfNeeded() {
  if (STORAGE_BACKEND !== "file") {
    return;
  }

  await copyIfTargetNotUseful(
    SQLITE_COOKIE_FILE,
    COOKIE_FILE,
    "alexa-cookie.json",
    hasAnyJsonValue
  );
  await copyIfTargetNotUseful(
    SQLITE_STATUS_FILE,
    STATUS_FILE,
    "alexa-login-status.json",
    (value) => value?.connected === true
  );
  await copyIfTargetNotUseful(
    SQLITE_PEER_MAP_FILE,
    PEER_MAP_FILE,
    "alexa-peer-map.json",
    hasAnyJsonValue
  );
  await copyIfTargetNotUseful(
    SQLITE_MATTER_PEERS_FILE,
    MATTER_PEERS_FILE,
    "matter-peers.json",
    hasAnyJsonValue
  );
}

async function copyIfTargetNotUseful(source, target, label, isUseful) {
  const sourceValue = readJsonSync(source);
  if (!isUseful(sourceValue) || isUseful(readJsonSync(target))) {
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  console.info(`Migrated ${label} from sqlite to file`);
}

function hasAnyJsonValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return value != null;
}

async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonSync(file, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonSync(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpFile, file);
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/cookie=[^;\s]+/gi, "cookie=<redacted>")
    .replace(/access_token["'=:\s]+[^"',&;\s]+/gi, "access_token=<redacted>")
    .replace(/refresh_token["'=:\s]+[^"',&;\s]+/gi, "refresh_token=<redacted>")
    .replace(/csrf[:=]\s*[^;\s]+/gi, "csrf=<redacted>")
    .replace(/token[:=]\s*[^;\s]+/gi, "token=<redacted>");
}

class AuthRegisterError extends Error {
  constructor(status, body) {
    super(`auth_register_failed_${status}`);
    this.name = "AuthRegisterError";
    this.status = status;
    this.body = sanitizeError(String(body ?? "").slice(0, 500));
  }
}

function isAuthRegisterError(error) {
  return (
    error instanceof AuthRegisterError ||
    String(error?.message ?? error).startsWith("auth_register_failed_")
  );
}

function authRegisterStatus(error) {
  if (Number.isFinite(error?.status)) {
    return Number(error.status);
  }
  const match = /auth_register_failed_(\d+)/.exec(String(error?.message ?? error));
  return match ? Number(match[1]) : 0;
}

function authRegisterBody(error) {
  return typeof error?.body === "string" ? error.body : sanitizeError(error);
}

function logInfo(context, message, fields = {}) {
  const logger = context?.log ?? context?.logger ?? console;
  logger.info?.(message, fields);
}

function logWarn(context, message, fields = {}) {
  const logger = context?.log ?? context?.logger ?? console;
  logger.warn?.(message, fields);
}

async function saveStatus(status) {
  const safeStatus = {
    connected: Boolean(status.connected),
    status: status.status ?? "unknown",
    loginUrl: status.loginUrl ?? "",
    updatedAt: new Date().toISOString()
  };

  if (status.error) {
    safeStatus.error = sanitizeError(status.error);
  }
  if (Array.isArray(status.cookieDiagnostics)) {
    safeStatus.cookieDiagnostics = status.cookieDiagnostics;
  }
  if (typeof status.csrfPresent === "boolean") {
    safeStatus.csrfPresent = status.csrfPresent;
  }

  await writeJson(STATUS_FILE, safeStatus);
  return safeStatus;
}

async function saveVoiceHistoryStatus(status) {
  const safeStatus = {
    ok: Boolean(status.ok),
    status: status.status ?? "unknown",
    recordCount: Number.isFinite(status.recordCount) ? status.recordCount : 0,
    transcriptCount: Number.isFinite(status.transcriptCount)
      ? status.transcriptCount
      : 0,
    updatedAt: new Date().toISOString()
  };

  if (status.error) {
    safeStatus.error = sanitizeError(status.error);
  }
  if (typeof status.httpStatus === "number") {
    safeStatus.httpStatus = status.httpStatus;
  }
  if (typeof status.csrfPresent === "boolean") {
    safeStatus.csrfPresent = status.csrfPresent;
  }
  if (status.payloadSummary && typeof status.payloadSummary === "object") {
    safeStatus.payloadSummary = status.payloadSummary;
  }

  await writeJson(VOICE_HISTORY_STATUS_FILE, safeStatus);
  return safeStatus;
}

async function loadCookieJar() {
  const serialized = await readJson(COOKIE_FILE);
  if (!serialized) {
    return new CookieJar();
  }

  return CookieJar.deserializeSync(serialized);
}

async function saveCookieJar(jar) {
  const serialized = jar.serializeSync();
  await writeJson(COOKIE_FILE, serialized);
  await writeJson(COOKIE_COPY_FILE, serialized);
}

function cookieDiagnostics(jar, config) {
  const cookies = [
    ...jar.getCookiesSync(`https://www.${AMAZON_LOGIN_BASE_DOMAIN}/`),
    ...jar.getCookiesSync(`https://www.${config.amazonDomain}/`),
    ...jar.getCookiesSync(`https://${config.alexaHost}/`)
  ];

  const unique = new Map();
  for (const cookie of cookies) {
    unique.set(`${cookie.domain}:${cookie.key}`, {
      domain: cookie.domain,
      key: cookie.key
    });
  }

  return [...unique.values()].sort((a, b) => `${a.domain}:${a.key}`.localeCompare(`${b.domain}:${b.key}`));
}

function isCookieJarAuthenticated(jar, config) {
  const cookieNames = cookieDiagnostics(jar, config).map((cookie) => cookie.key.toLowerCase());

  return cookieNames.some((name) =>
    ["at-main", "sess-at-main", "ubid-main", "csrf", "x-main"].includes(name)
  );
}

function isStoredLoginConnected(config) {
  const status = readJsonSync(STATUS_FILE, {});
  if (!status?.connected) {
    return false;
  }

  try {
    const jar = CookieJar.deserializeSync(readJsonSync(COOKIE_FILE));
    return isCookieJarAuthenticated(jar, config);
  } catch {
    return false;
  }
}

function mergedCookieString(jar, config) {
  const cookies = new Map();
  for (const url of [
    `https://www.${AMAZON_LOGIN_BASE_DOMAIN}/`,
    `https://www.${config.amazonDomain}/`,
    `https://${config.alexaHost}/`
  ]) {
    for (const cookie of jar.getCookiesSync(url)) {
      cookies.set(cookie.key, cookie.value);
    }
  }

  return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function extractCsrfFromCookies(jar, config) {
  const cookies = [
    ...jar.getCookiesSync(`https://${config.alexaHost}/`),
    ...jar.getCookiesSync(`https://www.${config.amazonDomain}/`),
    ...jar.getCookiesSync(`https://www.${AMAZON_LOGIN_BASE_DOMAIN}/`)
  ];
  const csrfCookie = cookies.find((cookie) =>
    ["csrf", "csrf-token", "csrftoken"].includes(cookie.key.toLowerCase())
  );
  return csrfCookie?.value ?? "";
}

function extractCsrfFromText(text) {
  const patterns = [
    /anti-csrftoken-a2z["']?\s*[:=]\s*["']([^"']+)["']/i,
    /csrfToken["']?\s*[:=]\s*["']([^"']+)["']/i,
    /csrf-token["']?\s*[:=]\s*["']([^"']+)["']/i,
    /data-csrf-token=["']([^"']+)["']/i,
    /meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i,
    /meta\s+content=["']([^"']+)["']\s+name=["']csrf-token["']/i,
    /csrf["']?\s*[:=]\s*["']([^"']+)["']/i,
    /name=["']csrf["'][^>]*value=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*name=["']csrf["']/i
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      return match[1];
    }
  }

  return "";
}

async function fetchAlexaCsrf(jar, config) {
  const cookie = mergedCookieString(jar, config);
  for (const path of ["/spa/index.html", "/api/bootstrap?version=0"]) {
    try {
      const response = await fetch(`https://${config.alexaHost}${path}`, {
        method: "GET",
        redirect: "manual",
        headers: {
          Cookie: cookie,
          "User-Agent": BROWSER_UA,
          "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
          Accept: "text/html,application/json,text/plain,*/*",
          Referer: `https://${config.alexaHost}/spa/index.html`,
          Origin: `https://${config.alexaHost}`
        }
      });

      const setCookie = response.headers.get("set-cookie");
      if (setCookie) {
        jar.setCookieSync(setCookie, `https://${config.alexaHost}/`, { ignoreError: true });
        await saveCookieJar(jar);
      }

      const csrfFromCookie = extractCsrfFromCookies(jar, config);
      if (csrfFromCookie) {
        return csrfFromCookie;
      }

      const text = await response.text().catch(() => "");
      const csrfFromText = extractCsrfFromText(text);
      if (csrfFromText) {
        return csrfFromText;
      }
    } catch {
      // Try next known CSRF source.
    }
  }

  return extractCsrfFromCookies(jar, config);
}

async function fetchAlexaActivityCsrf(jar, config) {
  const cookie = mergedCookieString(jar, config);
  const domains = [
    VOICE_HISTORY_AMAZON_DOMAIN
  ].filter((domain, index, all) => all.indexOf(domain) === index);
  let lastResult = { csrf: "", httpStatus: 0, location: "" };

  for (const domain of domains) {
    const activityUrl = voiceHistoryActivityUrl({ ...config, amazonDomain: domain });
    const response = await fetch(activityUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        Cookie: cookie,
        "User-Agent": BROWSER_UA,
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: `https://www.${domain}/`,
        Origin: `https://www.${domain}`
      }
    });

    for (const setCookie of upstreamSetCookies(response)) {
      jar.setCookieSync(setCookie, `https://www.${domain}/`, {
        ignoreError: true
      });
    }
    await saveCookieJar(jar);

    lastResult = {
      csrf: "",
      httpStatus: response.status,
      location: response.headers.get("location") ?? ""
    };

    const csrfFromCookie = extractCsrfFromCookies(jar, {
      ...config,
      amazonDomain: domain
    });
    if (csrfFromCookie) {
      return { csrf: csrfFromCookie, httpStatus: response.status, location: "" };
    }

    if (!response.ok) {
      continue;
    }

    const text = await response.text().catch(() => "");
    const csrf = extractCsrfFromText(text);
    if (csrf) {
      return { csrf, httpStatus: response.status, location: "" };
    }
  }

  return lastResult;
}

function voiceHistoryActivityUrl(config) {
  return `https://www.${VOICE_HISTORY_AMAZON_DOMAIN}/alexa-privacy/apd/activity?disableGlobalNav=true&ref=activityHistory`;
}

function voiceHistoryRecordsUrl(config, startTime, endTime) {
  const params = new URLSearchParams({
    startTime: String(startTime),
    endTime: String(endTime),
    recordType: "VOICE_HISTORY",
    maxRecordSize: "50"
  });
  return `https://www.${VOICE_HISTORY_AMAZON_DOMAIN}/alexa-privacy/apd/rvh/customer-history-records-v2?${params.toString()}`;
}

function voiceHistoryLegacyRecordsUrl(config, startTime, endTime) {
  const params = new URLSearchParams({
    startTime: String(startTime),
    endTime: String(endTime),
    recordType: "VOICE_HISTORY",
    maxRecordSize: "50"
  });
  return `https://www.${VOICE_HISTORY_AMAZON_DOMAIN}/alexa-privacy/apd/rvh/customer-history-records?${params.toString()}`;
}

function sanitizeAlexaDevice(device) {
  return {
    accountName: device.accountName ?? device.deviceAccountName ?? device.name ?? null,
    deviceSerialNumber: device.deviceSerialNumber ?? null,
    serialNumber: device.serialNumber ?? device.deviceSerialNumber ?? null,
    deviceType: device.deviceType ?? null,
    deviceTypeLabel: formatDeviceTypeLabel(device.deviceType),
    deviceFamily: device.deviceFamily ?? null,
    online: typeof device.online === "boolean" ? device.online : null,
    softwareVersion: device.softwareVersion ?? null,
    macAddress: normalizeMac(device.macAddress ?? device.macAddressWireless ?? device.wifiMacAddress)
  };
}

function normalizeMac(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const hex = value.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  if (hex.length !== 12) {
    return null;
  }

  return hex.match(/.{1,2}/g).join(":");
}

function normalizeMacKey(value) {
  const normalized = normalizeMac(value);
  return normalized ? normalized.toUpperCase() : null;
}


function formatDeviceTypeLabel(type) {
  switch (type) {
    case "A1RABVCI4QCIKC":
      return "Echo Plus";
    case "A2DS1Q2TPDJ48U":
      return "Echo Dot";
    case "A32DOYMUN6DTXA":
      return "Echo";
    case "A3C9PE6TNYLTCH":
      return "Multiroom Group";
    case "A2IVLV5VM2W81":
      return "Alexa App";
    default:
      return type || "";
  }
}

function shouldHideAlexaDevice(device) {
  const type = device?.deviceType || "";
  const name = String(device?.accountName || device?.name || "").trim().toLowerCase();

  return (
    type === "A3C9PE6TNYLTCH" || // Multiroom Group / Überall
    type === "A2IVLV5VM2W81" ||  // Alexa App / This Device
    name === "überall" ||
    name === "uberall" ||
    name === "this device"
  );
}

function normalizeMatterPeerForOutput(matterPeer, mac) {
  if (!matterPeer || typeof matterPeer !== "object") {
    return matterPeer;
  }

  return {
    ...matterPeer,
    mac: normalizeMacKey(matterPeer.mac ?? mac) ?? String(matterPeer.mac ?? mac ?? "").toUpperCase()
  };
}

function collectMatterPeerMacs(value, result = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMatterPeerMacs(item, result);
    }
    return result;
  }

  if (!value || typeof value !== "object") {
    return result;
  }

  const possibleMac = normalizeMac(value.macAddress ?? value.mac ?? value.wifiMacAddress);
  if (possibleMac) {
    result.set(possibleMac, value);
  }

  for (const nested of Object.values(value)) {
    collectMatterPeerMacs(nested, result);
  }

  return result;
}

async function readMatterPeers() {
  return (
    (existsSync(MATTER_PEERS_FILE) ? await readJson(MATTER_PEERS_FILE) : undefined) ??
    (existsSync(MATTER_PEERS_FALLBACK_FILE) ? await readJson(MATTER_PEERS_FALLBACK_FILE) : undefined) ??
    {}
  );
}

function createPeerMap(alexaDevices, matterPeers) {
  const matterMacs = collectMatterPeerMacs(matterPeers);
  const map = {};

  for (const device of alexaDevices) {
    if (!device.macAddress) {
      continue;
    }

    const matterPeer = matterMacs.get(device.macAddress);
    if (!matterPeer) {
      continue;
    }

    const macKey = normalizeMacKey(device.macAddress);
    if (!macKey) {
      continue;
    }

    map[macKey] = {
      name: device.accountName,
      serial: device.serialNumber ?? device.deviceSerialNumber,
      deviceType: device.deviceType,
      deviceTypeLabel: formatDeviceTypeLabel(device.deviceType),
      matterPeer: normalizeMatterPeerForOutput(matterPeer, macKey),
      source: "alexa-mac"
    };
  }

  return map;
}

function createKnownLocalPeerMap(alexaDevices, matterPeers) {
  const matterMacs = collectMatterPeerMacs(matterPeers);
  const devicesBySerial = new Map();
  for (const device of alexaDevices) {
    const serial = device.serialNumber ?? device.deviceSerialNumber;
    if (serial) {
      devicesBySerial.set(serial, device);
    }
  }

  const map = {};
  for (const [mac, known] of Object.entries(KNOWN_LOCAL_ALEXA_PEER_MAP)) {
    const matterPeer = matterMacs.get(mac);
    const device = devicesBySerial.get(known.serial);
    if (!matterPeer || !device) {
      continue;
    }

    const macKey = normalizeMacKey(mac);
    if (!macKey) {
      continue;
    }

    map[macKey] = {
      name: device.accountName ?? known.name,
      serial: known.serial,
      deviceType: device.deviceType,
      deviceTypeLabel: formatDeviceTypeLabel(device.deviceType),
      matterPeer: normalizeMatterPeerForOutput(matterPeer, macKey),
      source: "known-local"
    };
  }

  return map;
}

function buildDeviceList(alexaDevices, peerMap) {
  const entriesBySerial = new Map();
  for (const [mac, entry] of Object.entries(peerMap ?? {})) {
    const serial = entry?.serial;
    if (!serial) {
      continue;
    }
    entriesBySerial.set(serial, { mac: normalizeMacKey(mac) ?? String(mac).toUpperCase(), entry });
  }

  return (Array.isArray(alexaDevices) ? alexaDevices : [])
    .filter((device) => !shouldHideAlexaDevice(device))
    .map((device) => {
    const serial = device.serialNumber ?? device.deviceSerialNumber ?? "";
    const matched = entriesBySerial.get(serial);
    const matterPeer = matched?.entry?.matterPeer ?? {};

    return {
      name: matched?.entry?.name ?? device.accountName ?? "Unknown Alexa Device",
      serial,
      deviceType: matched?.entry?.deviceType ?? device.deviceType ?? "",
      deviceTypeLabel: matched?.entry?.deviceTypeLabel ?? device.deviceTypeLabel ?? formatDeviceTypeLabel(matched?.entry?.deviceType ?? device.deviceType),
      peer: matterPeer.peer ? String(matterPeer.peer) : "not matched",
      ip: matterPeer.ip ?? "",
      mac: matched?.mac ?? "",
      online: typeof device.online === "boolean" ? device.online : null,
      source: matched?.entry?.source ?? "unmatched"
    };
  });
}

function buildDeviceListSync() {
  const alexaDevices = readJsonSync(DEVICES_FILE, []);
  const peerMap = readJsonSync(PEER_MAP_FILE, {});
  return buildDeviceList(alexaDevices, peerMap);
}

function buildAlexaDeviceSerialMap() {
  const devices = readJsonSync(DEVICES_FILE, []);
  const map = new Map();
  for (const device of Array.isArray(devices) ? devices : []) {
    const serial = device.serialNumber ?? device.deviceSerialNumber;
    if (!serial) {
      continue;
    }
    map.set(String(serial), {
      name: device.accountName ?? device.name ?? "Unknown Alexa Device",
      deviceType: device.deviceType ?? "",
      deviceTypeLabel: device.deviceTypeLabel ?? formatDeviceTypeLabel(device.deviceType)
    });
  }

  for (const known of Object.values(KNOWN_LOCAL_ALEXA_PEER_MAP)) {
    if (!map.has(known.serial)) {
      map.set(known.serial, {
        name: known.name,
        deviceType: "",
        deviceTypeLabel: ""
      });
    }
  }

  return map;
}

function transcriptTextFromItems(items, itemTypes) {
  return items
    .filter((item) => itemTypes.includes(item.recordItemType))
    .map((item) => String(item.transcriptText ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

function serialFromVoiceHistoryRecord(record) {
  const parts = String(record?.recordKey ?? "").split("#");
  return parts[3] ?? "";
}

function normalizeVoiceHistoryRecord(record, deviceMap) {
  const items = Array.isArray(record?.voiceHistoryRecordItems)
    ? record.voiceHistoryRecordItems
    : [];
  const utterance = transcriptTextFromItems(items, [
    "CUSTOMER_TRANSCRIPT",
    "ASR_REPLACEMENT_TEXT"
  ]);
  const response = transcriptTextFromItems(items, [
    "ALEXA_RESPONSE",
    "TTS_REPLACEMENT_TEXT"
  ]);

  if (!utterance && record?.utteranceType === "WAKE_WORD_ONLY") {
    return null;
  }

  const serial = serialFromVoiceHistoryRecord(record);
  const device = deviceMap.get(serial);
  const timestamp = Number(record?.timestamp);

  return {
    time: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "",
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    device: device?.name ?? (serial ? `Unknown Echo (${serial})` : "Unknown Echo"),
    serial,
    utterance,
    response,
    status: record?.activityStatus ?? record?.utteranceType ?? "",
    utteranceType: record?.utteranceType ?? "",
    deviceType: device?.deviceType ?? "",
    deviceTypeLabel: device?.deviceTypeLabel ?? ""
  };
}

function shouldIncludeVoiceHistoryRecord(record, config) {
  const status = String(record?.activityStatus ?? "").toUpperCase();
  const utteranceType = String(record?.utteranceType ?? "").toUpperCase();

  if (utteranceType === "WAKE_WORD_ONLY") {
    return config.voiceHistoryShowWakeWordOnly === true;
  }
  if (status === "ROUTINES_3P") {
    return config.voiceHistoryShowRoutines3p === true;
  }
  if (status === "GENERAL") {
    return config.voiceHistoryShowGeneral !== false;
  }

  return true;
}

function normalizeVoiceHistoryRecords(records, config) {
  const deviceMap = buildAlexaDeviceSerialMap();
  return (Array.isArray(records) ? records : [])
    .filter((record) => shouldIncludeVoiceHistoryRecord(record, config))
    .map((record) => normalizeVoiceHistoryRecord(record, deviceMap))
    .filter(Boolean)
    .filter((record) => record.utterance || record.response)
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

function readVoiceHistoryRecordsFromPayload(payload) {
  for (const key of [
    "customerHistoryRecords",
    "customerHistoryRecordList",
    "historyRecords",
    "records",
    "activities",
    "items"
  ]) {
    if (Array.isArray(payload?.[key])) {
      return payload[key];
    }
  }

  const nested =
    payload?.response?.customerHistoryRecords ??
    payload?.data?.customerHistoryRecords ??
    payload?.customerHistory?.records;
  return Array.isArray(nested) ? nested : [];
}

function voiceHistoryPayloadSummary(payload) {
  return {
    payloadKeys:
      payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20) : [],
    hasCustomerHistoryRecords: Array.isArray(payload?.customerHistoryRecords),
    hasRecords: Array.isArray(payload?.records),
    hasActivities: Array.isArray(payload?.activities)
  };
}

async function fetchVoiceHistoryV2(cookie, csrf, config, startTime, endTime) {
  const response = await fetch(
    voiceHistoryRecordsUrl(config, startTime, endTime),
    {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: cookie,
        "anti-csrftoken-a2z": csrf,
        "User-Agent": BROWSER_UA,
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        Referer: voiceHistoryActivityUrl(config),
        Origin: `https://www.${VOICE_HISTORY_AMAZON_DOMAIN}`,
        "X-Requested-With": "XMLHttpRequest"
      },
      body: JSON.stringify({ previousRequestToken: null })
    }
  );
  return readVoiceHistoryResponse(response, "v2");
}

async function fetchVoiceHistoryLegacy(cookie, csrf, config, startTime, endTime) {
  const response = await fetch(
    voiceHistoryLegacyRecordsUrl(config, startTime, endTime),
    {
      method: "GET",
      redirect: "manual",
      headers: {
        Cookie: cookie,
        "anti-csrftoken-a2z": csrf,
        "User-Agent": BROWSER_UA,
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        Accept: "application/json, text/plain, */*",
        Referer: voiceHistoryActivityUrl(config),
        Origin: `https://www.${VOICE_HISTORY_AMAZON_DOMAIN}`,
        "X-Requested-With": "XMLHttpRequest"
      }
    }
  );
  return readVoiceHistoryResponse(response, "legacy");
}

async function readVoiceHistoryResponse(response, source) {
  if (!response.ok) {
    return {
      ok: false,
      source,
      httpStatus: response.status,
      payload: null,
      rawRecords: []
    };
  }

  const payload = await response.json();
  return {
    ok: true,
    source,
    httpStatus: response.status,
    payload,
    rawRecords: readVoiceHistoryRecordsFromPayload(payload)
  };
}

function logVoiceHistoryRecords(context, records) {
  for (const record of records) {
    logInfo(context, "Alexa voice history entry", {
      time: record.time,
      device: record.device,
      status: record.status,
      utterance: record.utterance || "-",
      response: record.response || "-"
    });
  }
}

function numericConfig(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function detailsFromDiagnosticEvent(event) {
  const details = event?.details && typeof event.details === "object"
    ? event.details
    : {};
  return {
    action: String(details.action ?? ""),
    entityId: String(event?.entityId ?? details.entityId ?? ""),
    data: details.data && typeof details.data === "object" ? details.data : {},
    timestamp: Number.isFinite(event?.timestamp) ? Number(event.timestamp) : Date.now()
  };
}

function findNearestVoiceHistoryRecord(action, records, windowMs) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const record of records) {
    if (!Number.isFinite(record?.timestamp)) {
      continue;
    }
    const distance = Math.abs(Number(record.timestamp) - action.timestamp);
    if (distance > windowMs || distance >= bestDistance) {
      continue;
    }
    best = record;
    bestDistance = distance;
  }
  return best;
}

function voiceHistoryActionMatchKey(action, record) {
  return [
    action.entityId,
    action.action,
    record.time,
    record.device,
    record.utterance
  ].join("|");
}

function labelForTableColumn(key) {
  return {
    time: "Time",
    device: "Echo",
    utterance: "Utterance",
    response: "Response",
    status: "Status",
    name: "Name",
    serial: "Serial",
    deviceSerialNumber: "Device Serial",
    accountName: "Name",
    deviceType: "Device Type",
    deviceTypeLabel: "Type",
    deviceFamily: "Family",
    peer: "Peer",
    ip: "IP",
    mac: "MAC",
    online: "Status",
    source: "Source",
    softwareVersion: "Software"
  }[key] ?? key;
}

function typeForTableColumn(key) {
  if (key === "online") {
    return "status";
  }
  if (key === "source" || key === "deviceFamily" || key === "status") {
    return "chip";
  }
  return "text";
}

function rowsForTableFile(tableFile) {
  switch (tableFile) {
    case "voice-history":
    case "alexa-voice-history.json":
      return readJsonSync(VOICE_HISTORY_FILE, []);
    case "alexa-devices.json":
      return readJsonSync(DEVICES_FILE, []);
    case "alexa-peer-map.json":
      return Object.entries(readJsonSync(PEER_MAP_FILE, {})).map(([mac, entry]) => ({
        mac,
        ...(entry && typeof entry === "object" ? entry : {})
      }));
    case "device-list":
    default:
      return buildDeviceListSync();
  }
}

function buildPluginTables(config) {
  const tables = parseJsonConfig(config.uiTables, parseJsonConfig(DEFAULT_CONFIG.uiTables, []));
  if (!Array.isArray(tables)) {
    return [];
  }

  return tables
    .filter((table) => table && table.show !== false)
    .filter(
      (table) =>
        config.voiceHistoryEnabled !== false ||
        !["voice-history", "alexa-voice-history.json"].includes(
          table.source ?? table.file
        )
    )
    .map((table) => {
      const columns = Array.isArray(table.columns) ? table.columns : [];
      const source = table.source ?? table.file ?? "device-list";
      return {
        id: table.id,
        title: table.title,
        show: table.show,
        collapsible: table.collapsible,
        defaultCollapsed: table.defaultCollapsed,
        emptyText: table.emptyText,
        columns: columns
          .filter((column) => column?.key)
          .map((column) => ({
            key: String(column.key),
            label: String(column.label ?? labelForTableColumn(column.key)),
            width: column.width,
            type: column.type ?? typeForTableColumn(column.key)
          })),
        rows: rowsForTableFile(source)
      };
    })
    .filter((table) => table.columns.length > 0);
}

function buildPluginActions(config, connected, loginUrl) {
  const actions = parseJsonConfig(config.uiActions, parseJsonConfig(DEFAULT_CONFIG.uiActions, []));
  if (!Array.isArray(actions)) {
    return [];
  }

  return actions
    .filter((action) => action && action.show !== false)
    .filter(
      (action) =>
        config.voiceHistoryEnabled !== false ||
        action.id !== "scanVoiceHistory"
    )
    .filter((action) => {
      if (action.showWhen === "connected") {
        return connected;
      }
      if (action.showWhen === "offline") {
        return !connected;
      }
      return true;
    })
    .map((action) => ({
      id: String(action.id),
      label: String(action.label ?? action.id),
      variant: action.variant,
      color: action.color,
      disabled: action.disabled,
      tooltip: action.tooltip,
      confirmText: action.confirmText,
      refreshAfterAction: action.refreshAfterAction,
      externalPopupUrl: action.externalPopupUrl ?? (action.id === "startLogin" ? loginUrl : undefined),
      externalPopupMode: action.externalPopupMode ?? (action.id === "startLogin" ? "open" : undefined)
    }));
}

async function countPeerStatus() {
  const [matterPeers, peerMap] = await Promise.all([
    readMatterPeers(),
    readJson(PEER_MAP_FILE, {})
  ]);
  return {
    totalDevices: collectMatterPeerMacs(matterPeers).size,
    matchedDevices: Object.keys(peerMap ?? {}).length
  };
}

function countPeerStatusSync() {
  const matterPeers =
    (existsSync(MATTER_PEERS_FILE) ? readJsonSync(MATTER_PEERS_FILE) : undefined) ??
    (existsSync(MATTER_PEERS_FALLBACK_FILE) ? readJsonSync(MATTER_PEERS_FALLBACK_FILE) : undefined) ??
    {};
  const peerMap = readJsonSync(PEER_MAP_FILE, {});

  return {
    totalDevices: collectMatterPeerMacs(matterPeers).size,
    matchedDevices: Object.keys(peerMap ?? {}).length
  };
}

export default class NativeAlexaPeerResolverPlugin {
  static hamhPluginApiVersion = 1;
  static id = "hamh-plugin-native-alexa-peer-resolver";
  static name = "Native Alexa Peer Resolver";
  static version = "0.1.43";

  name = "hamh-plugin-native-alexa-peer-resolver";
  version = "0.1.43";

  constructor(config = {}) {
    this.context = {};
    this.config = mergeConfig(config);
    this.server = null;
    this.proxyRunning = false;
    this.unsubscribeDiagnostics = null;
    this.voiceHistoryActionTimer = null;
    this.pendingVoiceHistoryActions = [];
    this.recentVoiceHistoryMatches = new Map();
    this.voiceHistoryActionScanRunning = false;
  }

  async onStart(context) {
    this.context = context;
    await ensureDataDirs();
    this.subscribeToHomeAssistantActions();
  }

  getConfigSchema() {
    return {
      type: "object",
      properties: {
        enabled: { type: "boolean", default: true, title: "Enabled" },
        amazonDomain: {
          type: "select",
          default: "amazon.de",
          options: [
            { label: "amazon.de", value: "amazon.de" },
            { label: "amazon.com", value: "amazon.com" },
            { label: "amazon.co.uk", value: "amazon.co.uk" }
          ],
          title: "Amazon Domain"
        },
        alexaHost: { type: "string", default: "alexa.amazon.de", title: "Alexa API Host" },
        proxyHost: { type: "string", default: "172.20.48.110", title: "Proxy Host" },
        proxyPort: { type: "number", default: 36701, title: "Proxy Port" },
        scanInterval: { type: "number", default: 30, title: "Scan Interval" },
        voiceHistoryEnabled: {
          type: "boolean",
          default: true,
          title: "Voice History aktiv"
        },
        voiceHistoryShowGeneral: {
          type: "boolean",
          default: true,
          title: "Voice History: GENERAL anzeigen"
        },
        voiceHistoryShowWakeWordOnly: {
          type: "boolean",
          default: false,
          title: "Voice History: WAKE_WORD_ONLY anzeigen"
        },
        voiceHistoryShowRoutines3p: {
          type: "boolean",
          default: false,
          title: "Voice History: ROUTINES_3P anzeigen"
        },
        voiceHistoryLogEntries: {
          type: "boolean",
          default: true,
          title: "Voice History ins Log schreiben"
        },
        voiceHistoryAfterActionEnabled: {
          type: "boolean",
          default: true,
          title: "Voice History nach Schaltbefehl abfragen",
          description: "Nach einem Matter-Schaltbefehl wird die Alexa Voice History kurz danach einmal abgefragt und mit dem geschalteten Entity im Log verknüpft."
        },
        voiceHistoryAfterActionDelaySeconds: {
          type: "number",
          default: 2,
          title: "Voice History Abfrageverzögerung Sekunden"
        },
        voiceHistoryActionMatchWindowSeconds: {
          type: "number",
          default: 10,
          title: "Voice History Zuordnungsfenster Sekunden"
        },
        uiActions: {
          type: "string",
          default: DEFAULT_CONFIG.uiActions,
          title: "UI actions JSON",
          description: "Buttons shown on the HAMH plugin page. Supports id, label, show, showWhen, variant, color."
        },
        uiTables: {
          type: "string",
          default: DEFAULT_CONFIG.uiTables,
          title: "UI tables JSON",
          description: "Tables shown on the HAMH plugin page. Supports id, title, show, source, columns with key/label/type/width."
        }
      },
      required: ["enabled", "amazonDomain", "alexaHost", "proxyHost", "proxyPort", "scanInterval"]
    };
  }

  getUiStatus() {
    const connected = existsSync(COOKIE_FILE) && isStoredLoginConnected(this.config);
    const counts = countPeerStatusSync();
    const loginUrl = `http://${this.config.proxyHost}:${this.config.proxyPort}/`;

    return {
      statusText: connected ? "Verbunden" : "Offline",
      statusColor: connected ? "success" : "warning",
      matchedDevices: counts.matchedDevices,
      totalDevices: counts.totalDevices,
      deviceList: buildDeviceListSync(),
      tables: buildPluginTables(this.config),
      actions: buildPluginActions(this.config, connected, loginUrl)
    };
  }

  async onAction(action) {
    await ensureDataDirs();

    const actionId = String(action);

    switch (actionId) {
      case "startLogin":
        return this.startLoginProxy();
      case "scanDevices":
        return this.scanDevices();
      case "scanVoiceHistory":
        return this.scanVoiceHistory();
      case "deleteCookie":
        return this.deleteCookie();
      default:
        return { ok: false, error: `Unknown action: ${actionId}` };
    }
  }

  subscribeToHomeAssistantActions() {
    this.unsubscribeFromHomeAssistantActions();
    if (
      this.config.voiceHistoryEnabled === false ||
      this.config.voiceHistoryAfterActionEnabled === false
    ) {
      return;
    }

    if (typeof this.context?.subscribeDiagnosticEvents !== "function") {
      logWarn(this.context, "Alexa voice history action trigger unavailable", {
        reason: "plugin_context_no_diagnostic_subscription"
      });
      return;
    }

    this.unsubscribeDiagnostics = this.context.subscribeDiagnosticEvents((event) => {
      this.handleDiagnosticEvent(event);
    });
    logInfo(this.context, "Alexa voice history action trigger enabled", {
      delaySeconds: numericConfig(
        this.config.voiceHistoryAfterActionDelaySeconds,
        DEFAULT_CONFIG.voiceHistoryAfterActionDelaySeconds,
        0,
        30
      ),
      matchWindowSeconds: numericConfig(
        this.config.voiceHistoryActionMatchWindowSeconds,
        DEFAULT_CONFIG.voiceHistoryActionMatchWindowSeconds,
        1,
        60
      )
    });
  }

  unsubscribeFromHomeAssistantActions() {
    if (typeof this.unsubscribeDiagnostics === "function") {
      this.unsubscribeDiagnostics();
    }
    this.unsubscribeDiagnostics = null;
    if (this.voiceHistoryActionTimer) {
      clearTimeout(this.voiceHistoryActionTimer);
      this.voiceHistoryActionTimer = null;
    }
  }

  handleDiagnosticEvent(event) {
    if (
      event?.type !== "command_received" ||
      this.config.voiceHistoryEnabled === false ||
      this.config.voiceHistoryAfterActionEnabled === false
    ) {
      return;
    }

    const action = detailsFromDiagnosticEvent(event);
    if (!action.action || !action.entityId) {
      return;
    }

    this.pendingVoiceHistoryActions.push(action);
    this.pendingVoiceHistoryActions = this.pendingVoiceHistoryActions.slice(-20);
    const delaySeconds = numericConfig(
      this.config.voiceHistoryAfterActionDelaySeconds,
      DEFAULT_CONFIG.voiceHistoryAfterActionDelaySeconds,
      0,
      30
    );

    if (this.voiceHistoryActionTimer) {
      clearTimeout(this.voiceHistoryActionTimer);
    }
    this.voiceHistoryActionTimer = setTimeout(() => {
      this.scanVoiceHistoryForPendingActions().catch((error) => {
        logWarn(this.context, "Alexa voice history action scan failed", {
          error: sanitizeError(error)
        });
      });
    }, delaySeconds * 1000);
  }

  async scanVoiceHistoryForPendingActions() {
    if (this.voiceHistoryActionScanRunning) {
      return;
    }

    const actions = this.pendingVoiceHistoryActions.splice(0);
    this.voiceHistoryActionTimer = null;
    if (actions.length === 0) {
      return;
    }

    this.voiceHistoryActionScanRunning = true;
    try {
      const result = await this.performVoiceHistoryScan({ logEntries: false });
      if (!result.ok) {
        logWarn(this.context, "Alexa voice history action scan skipped", {
          status: result.status
        });
        return;
      }

      this.logVoiceHistoryActionMatches(actions, result.records ?? []);
    } finally {
      this.voiceHistoryActionScanRunning = false;
    }
  }

  logVoiceHistoryActionMatches(actions, records) {
    const windowMs =
      numericConfig(
        this.config.voiceHistoryActionMatchWindowSeconds,
        DEFAULT_CONFIG.voiceHistoryActionMatchWindowSeconds,
        1,
        60
      ) * 1000;

    for (const action of actions) {
      const record = findNearestVoiceHistoryRecord(action, records, windowMs);
      if (!record) {
        logInfo(this.context, "Alexa voice history action match missing", {
          actionTime: new Date(action.timestamp).toISOString(),
          entityId: action.entityId,
          action: action.action,
          windowSeconds: windowMs / 1000
        });
        continue;
      }

      const matchKey = voiceHistoryActionMatchKey(action, record);
      if (this.isRecentVoiceHistoryMatch(matchKey, action.timestamp)) {
        continue;
      }

      logInfo(this.context, "Alexa voice history action match", {
        actionTime: new Date(action.timestamp).toISOString(),
        entityId: action.entityId,
        action: action.action,
        voiceTime: record.time,
        device: record.device,
        status: record.status,
        utterance: record.utterance || "-",
        response: record.response || "-"
      });
    }
  }

  isRecentVoiceHistoryMatch(matchKey, timestamp) {
    for (const [key, lastTimestamp] of this.recentVoiceHistoryMatches) {
      if (timestamp - lastTimestamp > VOICE_HISTORY_MATCH_DEDUPE_MS) {
        this.recentVoiceHistoryMatches.delete(key);
      }
    }

    const lastTimestamp = this.recentVoiceHistoryMatches.get(matchKey);
    if (
      typeof lastTimestamp === "number" &&
      Math.abs(timestamp - lastTimestamp) <= VOICE_HISTORY_MATCH_DEDUPE_MS
    ) {
      return true;
    }

    this.recentVoiceHistoryMatches.set(matchKey, timestamp);
    return false;
  }

  async startLoginProxy() {
    if (this.proxyRunning) {
      const loginUrl = `http://${this.config.proxyHost}:${this.config.proxyPort}/`;
      await saveStatus({ connected: false, status: "login_already_running", loginUrl });
      return { ok: true, status: "login_already_running", externalPopupUrl: loginUrl };
    }

    const app = express();
    const jar = new CookieJar();
    const loginUrl = `http://${this.config.proxyHost}:${this.config.proxyPort}/`;
    const loginState = createAndSaveProxyLoginState();
    seedLoginCookies(jar, loginState);
    await saveStatus({ connected: false, status: "proxy_login_required", loginUrl });

    app.get("/health", (_request, response) => response.json({ ok: true }));
    app.get("/", (_request, response) => response.redirect(buildAmazonLoginPath(this.config, loginState)));
    app.get("/login", (_request, response) => response.redirect(buildAmazonLoginPath(this.config, loginState)));
    app.get("/cookie-success", (_request, response) =>
      response
        .type("html")
        .send("<!doctype html><html><body><h3>Amazon Login gespeichert.</h3><p>Dieses Fenster kann geschlossen werden.</p></body></html>")
    );

    const proxyHandler = (targetHost, mountPath) => async (request, response) => {
      const targetPath = targetPathFromRequest(request, mountPath);
      const targetUrl = new URL(targetPath, `https://${targetHost}`);

      try {
        const upstreamResponse = await fetch(targetUrl, {
          method: request.method,
          headers: copyRequestHeaders(request, this.config, loginState, targetHost),
          body: await readRequestBody(request),
          redirect: "manual"
        });

        const setCookies = upstreamSetCookies(upstreamResponse).map(rewriteSetCookieForLocalProxy);
        if (setCookies.length > 0) {
          response.setHeader("set-cookie", setCookies);
          for (const cookie of setCookies) {
            jar.setCookieSync(cookie, `https://www.${AMAZON_LOGIN_BASE_DOMAIN}/`, { ignoreError: true });
            jar.setCookieSync(cookie, `https://www.${this.config.amazonDomain}/`, { ignoreError: true });
            jar.setCookieSync(cookie, `https://${this.config.alexaHost}/`, { ignoreError: true });
          }
          await saveCookieJar(jar);
          await saveStatus({
            connected: false,
            status: "login_cookie_seen",
            loginUrl
          });
        }

        const location = upstreamResponse.headers.get("location");
        if (location) {
          const accessToken = extractAccessToken(location);
          if (location.includes("/ap/maplanding") && accessToken) {
            await saveCookieJar(jar);
            response.status(302).setHeader("location", `http://${this.config.proxyHost}:${this.config.proxyPort}/cookie-success`);
            await saveStatus({ connected: true, status: "cookie_saved_browser_only", loginUrl });
            response.end();
            return;
          }

          if (location.includes("/spa/index.html")) {
            response.status(302).setHeader("location", `http://${this.config.proxyHost}:${this.config.proxyPort}/cookie-success`);
            await saveStatus({ connected: true, status: "cookie_saved_without_token_exchange", loginUrl });
            response.end();
            return;
          }

          response.status(upstreamResponse.status).setHeader("location", rewriteProxyUrl(location, this.config));
          response.end();
          return;
        }

        copyResponseHeaders(upstreamResponse, response);
        const contentType = upstreamResponse.headers.get("content-type") ?? "";
        const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
        const body = shouldRewriteBody(contentType) ? rewriteProxyUrl(buffer.toString("utf8"), this.config) : buffer;

        response.status(upstreamResponse.status).send(body);
      } catch (error) {
        if (isAuthRegisterError(error)) {
          const status = authRegisterStatus(error);
          await saveCookieJar(jar);
          await saveStatus({
            connected: true,
            status: `cookie_saved_register_fallback_${status || "unknown"}`,
            loginUrl,
            httpStatus: status,
            error: authRegisterBody(error),
            method: request.method,
            targetHost,
            targetPath
          });
          logWarn(this.context, "Alexa auth/register failed in proxy handler, using browser cookies fallback", {
            httpStatus: status
          });
          response.status(302).setHeader("location", `http://${this.config.proxyHost}:${this.config.proxyPort}/cookie-success`);
          response.end();
          return;
        }
        const safeError = sanitizeError(error);
        await saveStatus({
          connected: false,
          status: "proxy_request_failed",
          loginUrl,
          error: safeError,
          method: request.method,
          targetHost,
          targetPath
        });
        response.status(502).type("text/plain").send(`Proxy request failed: ${safeError}`);
      }
    };

    app.use(`/www.${AMAZON_LOGIN_BASE_DOMAIN}`, proxyHandler(`www.${AMAZON_LOGIN_BASE_DOMAIN}`, `/www.${AMAZON_LOGIN_BASE_DOMAIN}`));
    app.use(`/www.${this.config.amazonDomain}`, proxyHandler(`www.${this.config.amazonDomain}`, `/www.${this.config.amazonDomain}`));
    app.use(`/${this.config.alexaHost}`, proxyHandler(this.config.alexaHost, `/${this.config.alexaHost}`));

    try {
      this.server = createServer(app);
      await new Promise((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.config.proxyPort, "0.0.0.0", resolve);
      });
      this.proxyRunning = true;
      await saveStatus({ connected: false, status: "proxy_login_required", loginUrl });
      logInfo(this.context, "Alexa login proxy started", {
        proxyHost: this.config.proxyHost,
        proxyPort: this.config.proxyPort,
        amazonDomain: this.config.amazonDomain
      });
      return { ok: true, status: "proxy_login_required", externalPopupUrl: loginUrl };
    } catch (error) {
      const isPortInUse = error?.code === "EADDRINUSE";
      await saveStatus({
        connected: false,
        status: isPortInUse ? "login_already_running" : "proxy_start_failed",
        loginUrl,
        error: sanitizeError(error)
      });

      if (isPortInUse) {
        return { ok: true, status: "login_already_running", externalPopupUrl: loginUrl };
      }

      throw error;
    }
  }

  async scanDevices() {
    const jar = await loadCookieJar();
    const cookie = mergedCookieString(jar, this.config);

    if (!cookie) {
      await saveStatus({ connected: false, status: "login_required", loginUrl: "", cookieDiagnostics: [] });
      return { ok: false, status: "login_required" };
    }

    const csrf = await fetchAlexaCsrf(jar, this.config);
    const diagnostics = cookieDiagnostics(jar, this.config);
    const response = await fetch(`https://${this.config.alexaHost}/api/devices-v2/device?cached=false`, {
      method: "GET",
      redirect: "manual",
      headers: {
        Cookie: cookie,
        ...(csrf ? { csrf } : {}),
        "User-Agent": BROWSER_UA,
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        Accept: "application/json, text/plain, */*",
        Referer: `https://${this.config.alexaHost}/spa/index.html`,
        Origin: `https://${this.config.alexaHost}`,
        "X-Requested-With": "XMLHttpRequest"
      }
    });

    if (!response.ok) {
      const status = `scan_failed_${response.status}`;
      await saveStatus({
        connected: isCookieJarAuthenticated(jar, this.config),
        status,
        loginUrl: "",
        error: status,
        cookieDiagnostics: diagnostics,
        csrfPresent: Boolean(csrf)
      });
      return { ok: false, status, httpStatus: response.status };
    }

    const payload = await response.json();
    const rawDevices = Array.isArray(payload.devices) ? payload.devices : [];
    const devices = rawDevices.map(sanitizeAlexaDevice).filter((device) => !shouldHideAlexaDevice(device));
    await writeJson(DEVICES_FILE, devices);

    const matterPeers = await readMatterPeers();
    const peerMap = createPeerMap(devices, matterPeers);
    const knownLocalPeerMap = createKnownLocalPeerMap(devices, matterPeers);
    const macCount = devices.filter((device) => device.macAddress).length;

    if (macCount > 0) {
      await writeJson(PEER_MAP_FILE, peerMap);
      await writeJson(PEER_MAP_COPY_FILE, peerMap);
    } else if (Object.keys(knownLocalPeerMap).length > 0) {
      await writeJson(PEER_MAP_FILE, knownLocalPeerMap);
      await writeJson(PEER_MAP_COPY_FILE, knownLocalPeerMap);
    }

    const status =
      macCount > 0
        ? "devices_scanned"
        : Object.keys(knownLocalPeerMap).length > 0
          ? "devices_scanned_known_local_map"
          : "devices_scanned_manual_mapping_needed";
    await saveStatus({
      connected: true,
      status,
      loginUrl: "",
      cookieDiagnostics: diagnostics,
      csrfPresent: Boolean(csrf)
    });
    logInfo(this.context, "Alexa devices scanned", {
      devices: devices.length,
      devicesWithMac: macCount,
      matches: Object.keys(macCount > 0 ? peerMap : knownLocalPeerMap).length
    });

    return {
      ok: true,
      status,
      totalDevices: devices.length,
      devicesWithMac: macCount,
      matchedDevices: Object.keys(macCount > 0 ? peerMap : knownLocalPeerMap).length
    };
  }

  async scanVoiceHistory() {
    const result = await this.performVoiceHistoryScan({
      logEntries: this.config.voiceHistoryLogEntries !== false
    });
    return {
      ok: result.ok,
      status: result.status,
      totalRecords: result.totalRecords,
      transcriptRecords: result.transcriptRecords,
      httpStatus: result.httpStatus
    };
  }

  async performVoiceHistoryScan(options = {}) {
    const logEntries = options.logEntries !== false;
    if (this.config.voiceHistoryEnabled === false) {
      await saveVoiceHistoryStatus({
        ok: false,
        status: "voice_history_disabled",
        recordCount: 0,
        transcriptCount: 0
      });
      return { ok: false, status: "voice_history_disabled", records: [] };
    }

    const jar = await loadCookieJar();
    const cookie = mergedCookieString(jar, this.config);
    const diagnostics = cookieDiagnostics(jar, this.config);

    if (!cookie || !isCookieJarAuthenticated(jar, this.config)) {
      await saveVoiceHistoryStatus({
        ok: false,
        status: "voice_history_login_required",
        recordCount: 0,
        transcriptCount: 0
      });
      await saveStatus({
        connected: false,
        status: "voice_history_login_required",
        loginUrl: "",
        cookieDiagnostics: diagnostics
      });
      return { ok: false, status: "voice_history_login_required", records: [] };
    }

    const csrfResult = await fetchAlexaActivityCsrf(jar, this.config);
    if (!csrfResult.csrf) {
      const status = "voice_history_csrf_failed";
      await saveVoiceHistoryStatus({
        ok: false,
        status,
        recordCount: 0,
        transcriptCount: 0,
        httpStatus: csrfResult.httpStatus,
        csrfPresent: false
      });
      await saveStatus({
        connected: true,
        status,
        loginUrl: "",
        error: status,
        cookieDiagnostics: diagnostics,
        csrfPresent: false
      });
      return { ok: false, status, httpStatus: csrfResult.httpStatus, records: [] };
    }

    const endTime = Date.now();
    const startTime = endTime - VOICE_HISTORY_LOOKBACK_MS;
    let voiceHistoryResult = await fetchVoiceHistoryV2(
      cookie,
      csrfResult.csrf,
      this.config,
      startTime,
      endTime
    );
    let fallbackSummary = null;

    if (voiceHistoryResult.ok && voiceHistoryResult.rawRecords.length === 0) {
      const legacyResult = await fetchVoiceHistoryLegacy(
        cookie,
        csrfResult.csrf,
        this.config,
        startTime,
        endTime
      );
      fallbackSummary = {
        source: legacyResult.source,
        ok: legacyResult.ok,
        httpStatus: legacyResult.httpStatus,
        recordCount: legacyResult.rawRecords.length,
        payloadSummary: legacyResult.payload
          ? voiceHistoryPayloadSummary(legacyResult.payload)
          : null
      };
      if (legacyResult.ok && legacyResult.rawRecords.length > 0) {
        voiceHistoryResult = legacyResult;
      }
    }

    if (!voiceHistoryResult.ok) {
      const status = `voice_history_failed_${voiceHistoryResult.httpStatus}`;
      await saveVoiceHistoryStatus({
        ok: false,
        status,
        recordCount: 0,
        transcriptCount: 0,
        httpStatus: voiceHistoryResult.httpStatus,
        csrfPresent: true
      });
      await saveStatus({
        connected: true,
        status,
        loginUrl: "",
        error: status,
        cookieDiagnostics: diagnostics,
        csrfPresent: true
      });
      return { ok: false, status, httpStatus: voiceHistoryResult.httpStatus, records: [] };
    }

    const payload = voiceHistoryResult.payload;
    const rawRecords = voiceHistoryResult.rawRecords;
    const payloadSummary = voiceHistoryPayloadSummary(payload);
    payloadSummary.source = voiceHistoryResult.source;
    if (fallbackSummary) {
      payloadSummary.fallback = fallbackSummary;
    }
    const records = normalizeVoiceHistoryRecords(rawRecords, this.config);
    await writeJson(VOICE_HISTORY_FILE, records);
    await saveVoiceHistoryStatus({
      ok: true,
      status: "voice_history_scanned",
      recordCount: rawRecords.length,
      transcriptCount: records.length,
      httpStatus: voiceHistoryResult.httpStatus,
      csrfPresent: true,
      payloadSummary
    });
    await saveStatus({
      connected: true,
      status: "voice_history_scanned",
      loginUrl: "",
      cookieDiagnostics: diagnostics,
      csrfPresent: true
    });
    logInfo(this.context, "Alexa voice history scanned", {
      records: rawRecords.length,
      transcripts: records.length,
      source: voiceHistoryResult.source,
      payloadKeys: payloadSummary.payloadKeys
    });
    if (logEntries) {
      logVoiceHistoryRecords(this.context, records);
    }

    return {
      ok: true,
      status: "voice_history_scanned",
      totalRecords: rawRecords.length,
      transcriptRecords: records.length,
      httpStatus: voiceHistoryResult.httpStatus,
      records
    };
  }

  async deleteCookie() {
    for (const file of [
      COOKIE_FILE,
      COOKIE_COPY_FILE,
      PEER_MAP_FILE,
      PEER_MAP_COPY_FILE,
      VOICE_HISTORY_FILE,
      VOICE_HISTORY_STATUS_FILE
    ]) {
      await rm(file, { force: true });
    }

    await saveStatus({ connected: false, status: "login_required", loginUrl: "" });
    logWarn(this.context, "Alexa cookie deleted");
    return { ok: true, status: "login_required" };
  }

  async stop() {
    if (!this.server) {
      return;
    }

    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    this.proxyRunning = false;
  }

  async onConfigChanged(config) {
    this.config = mergeConfig(config);
    this.subscribeToHomeAssistantActions();
  }

  async onShutdown() {
    this.unsubscribeFromHomeAssistantActions();
    await this.stop();
  }
}
