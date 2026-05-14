import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";

import { data as dataDir } from "./folders";

const deviceIdFilePath = join(dataDir, "device_id.json");
const successfulDeviceIdFilePath = join(dataDir, "anonymous_device_id.json");
const SUCCESSFUL_DEVICE_ID_VERSION = 1;

let deviceId = "";
let ADDeviceId = "";

type DeviceIdentity = {
  deviceId: string;
  ADDeviceId: string;
};

type SuccessfulDeviceIdMemory = {
  version?: number;
  deviceId?: string;
};

type DeviceIdentityOptions = {
  rotateDeviceId?: boolean;
};

export function getDeviceId() {
  return deviceId;
}

export function getADDeviceId() {
  return ADDeviceId;
}

function generateHexString(length = 52) {
  const byteLength = Math.ceil(length / 2);
  return randomBytes(byteLength).toString("hex").slice(0, length).toUpperCase();
}

function isValidDeviceIdCandidate(value: string | undefined) {
  return Boolean(value && /^[\dA-F]{52}$/.test(value));
}

function generateMACAddress() {
  // Generate a legal host MAC address: unicast and universally administered.
  const macBytes = randomBytes(6);
  macBytes[0] = macBytes[0] & 0xfc;
  return Array.from(macBytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join(":")
    .toUpperCase();
}

function toLegacyEncodedToken(value: string) {
  return Buffer.from(value, "utf8").toString("hex").toUpperCase();
}

function buildLegacyHardwareToken(seed: string) {
  const digest = createHash("sha256")
    .update(seed, "utf8")
    .digest("hex")
    .toUpperCase();
  const raw = digest.slice(0, 32);
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += 4) {
    groups.push(raw.slice(i, i + 4));
  }
  return groups.join("_");
}

async function readSuccessfulDeviceId() {
  try {
    const memory: SuccessfulDeviceIdMemory = JSON.parse(
      await readFile(successfulDeviceIdFilePath, "utf-8")
    );
    if (
      memory.version === SUCCESSFUL_DEVICE_ID_VERSION &&
      isValidDeviceIdCandidate(memory.deviceId)
    ) {
      return memory.deviceId ?? "";
    }
  } catch {
    return "";
  }

  return "";
}

export async function rememberSuccessfulDeviceId(nextDeviceId = deviceId) {
  if (!isValidDeviceIdCandidate(nextDeviceId)) return;

  try {
    await writeFile(
      successfulDeviceIdFilePath,
      JSON.stringify(
        {
          version: SUCCESSFUL_DEVICE_ID_VERSION,
          deviceId: nextDeviceId,
        } satisfies SuccessfulDeviceIdMemory,
        null,
        2
      ),
      "utf-8"
    );
  } catch (error) {
    console.warn(
      `[device] Failed to remember successful anonymous device ID: ${(error as Error)?.message || String(error)}`
    );
  }
}

export async function forgetSuccessfulDeviceId(rejectedDeviceId = deviceId) {
  const successfulDeviceId = await readSuccessfulDeviceId();
  if (successfulDeviceId !== rejectedDeviceId) return;

  try {
    await unlink(successfulDeviceIdFilePath);
  } catch {
    // It is fine if another startup already removed it.
  }
}

async function createDeviceIdentity(
  options: DeviceIdentityOptions = {}
): Promise<DeviceIdentity> {
  const nextDeviceId = options.rotateDeviceId
    ? generateHexString()
    : (await readSuccessfulDeviceId()) || generateHexString();
  const randomMACAddress = generateMACAddress();
  const legacyToken = buildLegacyHardwareToken(
    `${nextDeviceId}:${randomMACAddress}`
  );
  const encodedToken = toLegacyEncodedToken(legacyToken);
  const signStr = `${randomMACAddress}@@@${encodedToken}`;

  return {
    deviceId: nextDeviceId,
    ADDeviceId: `${signStr}@@@@@@${createHash("sha256").update(signStr, "utf8").digest("hex")}`,
  };
}

async function saveDeviceIdentity(identity: DeviceIdentity) {
  deviceId = identity.deviceId;
  ADDeviceId = identity.ADDeviceId;

  try {
    await writeFile(
      deviceIdFilePath,
      JSON.stringify(identity, null, 2),
      "utf-8"
    );
  } catch (e) {
    console.error("Failed to write device ID to file.", e);
  }
}

export async function useDeviceId(nextDeviceId: string) {
  if (!isValidDeviceIdCandidate(nextDeviceId) || !ADDeviceId) return false;

  await saveDeviceIdentity({
    deviceId: nextDeviceId,
    ADDeviceId,
  });
  return true;
}

export async function refreshDeviceId(
  reason?: string,
  options: DeviceIdentityOptions = {}
) {
  await saveDeviceIdentity(await createDeviceIdentity(options));
  console.warn(
    `[device] Regenerated device identity${reason ? `: ${reason}` : ""}`
  );
}

export async function prepareDeviceId() {
  if (existsSync(deviceIdFilePath)) {
    try {
      const savedDeviceId: DeviceIdentity = JSON.parse(
        await readFile(deviceIdFilePath, "utf-8")
      );
      deviceId = savedDeviceId.deviceId;
      ADDeviceId = savedDeviceId.ADDeviceId;
      if (isValidDeviceIdCandidate(deviceId) && ADDeviceId) {
        return;
      }
    } catch (e) {
      console.error(
        "Failed to read device ID from file, generating new ones.",
        e
      );
    }
  }
  await saveDeviceIdentity(await createDeviceIdentity());
}
