import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";

import { data as dataDir } from "./folders";

const deviceIdFilePath = join(dataDir, "device_id.json");
const successfulDeviceIdFilePath = join(dataDir, "anonymous_device_id.json");
const execFileAsync = promisify(execFile);
const SUCCESSFUL_DEVICE_ID_VERSION = 1;
const DEVICE_ID_VERSION = 2;
const CLIENT_SIGN_VERSION = 3;
const COMMAND_TIMEOUT_MS = 2500;
const DESKTOP_MODEL_TAG = "台式电脑";
const LAPTOP_MODEL_TAG = "笔记本电脑";
const DEFAULT_SYSTEM_MANUFACTURER = "System Manufacturer";
const DEFAULT_SYSTEM_PRODUCT_NAME = "System Product Name";
const APPLE_SYSTEM_MANUFACTURER = "Apple Inc.";
const SERIAL_REJECT_SUBSTRINGS = [
  "unknown",
  "oem",
  "o.e.m",
  "invalid",
  "diy",
] as const;
const WINDOWS_ACP_CHAR_BYTES: Record<string, readonly number[]> = {
  主: [0xd6, 0xf7],
  机: [0xbb, 0xfa],
  台: [0xcc, 0xa8],
  式: [0xca, 0xbd],
  电: [0xb5, 0xe7],
  脑: [0xc4, 0xd4],
  笔: [0xb1, 0xca],
  记: [0xbc, 0xc7],
  本: [0xb1, 0xbe],
};

let deviceId = "";
let ADDeviceId = "";

type DeviceIdentity = {
  deviceIdVersion?: number;
  clientSignVersion?: number;
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

type HostInfo = {
  manufacturer: string;
  productName: string;
  modelTag: string;
};

export function getDeviceId() {
  return deviceId;
}

export function getADDeviceId() {
  return ADDeviceId;
}

function formatMACAddress(macAddress: string) {
  const normalized = macAddress.trim().replaceAll("-", ":").toUpperCase();
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(normalized) ? normalized : "";
}

function getActiveMACAddress() {
  for (const networkInterface of Object.values(networkInterfaces())) {
    for (const address of networkInterface ?? []) {
      const macAddress = formatMACAddress(address.mac);
      if (
        !address.internal &&
        macAddress &&
        macAddress !== "00:00:00:00:00:00"
      ) {
        return macAddress;
      }
    }
  }
  return "";
}

function getFirstAdapterMACAddressHex() {
  for (const networkInterface of Object.values(networkInterfaces())) {
    for (const address of networkInterface ?? []) {
      const macAddress = formatMACAddress(address.mac);
      if (macAddress && macAddress !== "00:00:00:00:00:00") {
        return macAddress.replaceAll(":", "");
      }
    }
  }
  return "";
}

function generateMACAddress() {
  const macBytes = randomBytes(6);
  // Keep the synthetic MAC in the same unicast/universal family as successful PC identities.
  macBytes[0] = 0xfc;
  return Array.from(macBytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join(":")
    .toUpperCase();
}

function generateRandomDeviceId(length = 52) {
  const byteLength = Math.ceil(length / 2);
  return randomBytes(byteLength).toString("hex").slice(0, length).toUpperCase();
}

function isValidDeviceIdCandidate(value: string | undefined) {
  return Boolean(value && /^[\dA-F]{52}$/.test(value));
}

function createDeterministicHardwareSerial(seed: string, length = 16) {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digest = createHash("sha256").update(seed, "utf8").digest();
  return Array.from(
    { length },
    (_, index) => alphabet[digest[index] % alphabet.length]
  ).join("");
}

function encodeDiskSerial(serial: string) {
  return Buffer.from(serial, "ascii").toString("hex").toUpperCase();
}

function removeSpaces(value: string) {
  return value.replaceAll(" ", "");
}

function rejectWeakHardwareSerial(serial: string) {
  if (!serial) return "";
  if (serial.length >= 6 && /^[0-9]+$/.test(serial)) return "";
  if (SERIAL_REJECT_SUBSTRINGS.some((part) => serial.includes(part))) return "";
  return serial;
}

function normalizeHardwareSerial(value: string) {
  return rejectWeakHardwareSerial(removeSpaces(value.trim()));
}

async function readTrimmedFile(filePath: string) {
  try {
    return (await readFile(filePath, "utf-8")).trim();
  } catch {
    return "";
  }
}

async function runCommand(command: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

function sha1UpperHexAscii(value: string) {
  return createHash("sha1").update(value, "ascii").digest("hex").toUpperCase();
}

async function getWindowsCurrentUserSID() {
  return normalizeHardwareToken(
    await runCommand("powershell.exe", [
      "-NoProfile",
      "-Command",
      "$ErrorActionPreference='Stop';" +
        "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ])
  );
}

async function createWindowsNativeDeviceId() {
  const sid = await getWindowsCurrentUserSID();
  const macAddressHex = getFirstAdapterMACAddressHex();
  if (!sid || !macAddressHex) return "";
  return `${sha1UpperHexAscii(sid)}${macAddressHex}`;
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

export async function useDeviceId(nextDeviceId: string) {
  if (!isValidDeviceIdCandidate(nextDeviceId) || !ADDeviceId) return false;

  await saveDeviceIdentity({
    deviceIdVersion: DEVICE_ID_VERSION,
    clientSignVersion: CLIENT_SIGN_VERSION,
    deviceId: nextDeviceId,
    ADDeviceId,
  });
  return true;
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

async function createInitialDeviceId() {
  const successfulDeviceId = await readSuccessfulDeviceId();
  if (successfulDeviceId) return successfulDeviceId;

  if (process.platform === "win32") {
    return (await createWindowsNativeDeviceId()) || generateRandomDeviceId();
  }

  return generateRandomDeviceId();
}

function normalizeHardwareToken(value: string) {
  return value.replaceAll("\u0000", "").trim();
}

function cleanHostValue(value: string, fallback: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

async function getLinuxHostInfo(): Promise<HostInfo> {
  const manufacturer = cleanHostValue(
    await readTrimmedFile("/sys/class/dmi/id/sys_vendor"),
    DEFAULT_SYSTEM_MANUFACTURER
  );
  const productName = cleanHostValue(
    await readTrimmedFile("/sys/class/dmi/id/product_name"),
    DEFAULT_SYSTEM_PRODUCT_NAME
  );
  const chassisType = await readTrimmedFile("/sys/class/dmi/id/chassis_type");

  return {
    manufacturer,
    productName,
    modelTag: chassisType === "9" ? LAPTOP_MODEL_TAG : DESKTOP_MODEL_TAG,
  };
}

async function getMacOSHostInfo(): Promise<HostInfo> {
  const model = cleanHostValue(
    await runCommand("sysctl", ["-n", "hw.model"]),
    DEFAULT_SYSTEM_PRODUCT_NAME
  );

  return {
    manufacturer: APPLE_SYSTEM_MANUFACTURER,
    productName: model,
    modelTag: /book/i.test(model) ? LAPTOP_MODEL_TAG : DESKTOP_MODEL_TAG,
  };
}

async function getWindowsHostInfo(): Promise<HostInfo> {
  const output = await runCommand("powershell.exe", [
    "-NoProfile",
    "-Command",
    "$ErrorActionPreference='Stop';" +
      "$cs = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 Manufacturer, Model;" +
      "$chassis = Get-CimInstance Win32_SystemEnclosure | Select-Object -First 1 -ExpandProperty ChassisTypes | Select-Object -First 1;" +
      "Write-Output $cs.Manufacturer;" +
      "Write-Output $cs.Model;" +
      "Write-Output $chassis",
  ]);
  const [manufacturer = "", productName = "", chassisType = ""] = output
    .split(/\r?\n/)
    .map((line) => line.trim());

  return {
    manufacturer: cleanHostValue(manufacturer, DEFAULT_SYSTEM_MANUFACTURER),
    productName: cleanHostValue(productName, DEFAULT_SYSTEM_PRODUCT_NAME),
    modelTag: chassisType === "9" ? LAPTOP_MODEL_TAG : DESKTOP_MODEL_TAG,
  };
}

async function getHostInfo(): Promise<HostInfo> {
  if (process.platform === "linux") {
    return await getLinuxHostInfo();
  }
  if (process.platform === "darwin") {
    return await getMacOSHostInfo();
  }
  if (process.platform === "win32") {
    return await getWindowsHostInfo();
  }

  return {
    manufacturer: DEFAULT_SYSTEM_MANUFACTURER,
    productName: DEFAULT_SYSTEM_PRODUCT_NAME,
    modelTag: DESKTOP_MODEL_TAG,
  };
}

function createHostTag(hostInfo: HostInfo) {
  return `主机:${hostInfo.manufacturer} ${hostInfo.productName} ${hostInfo.modelTag}`;
}

async function getBaseBoardSerial() {
  if (process.platform === "win32") {
    const boardSerial = normalizeHardwareSerial(
      await runCommand("powershell.exe", [
        "-NoProfile",
        "-Command",
        "$ErrorActionPreference='Stop';" +
          "Get-CimInstance Win32_BaseBoard | Select-Object -First 1 -ExpandProperty SerialNumber",
      ])
    );
    if (boardSerial) return boardSerial;

    return normalizeHardwareSerial(
      await runCommand("powershell.exe", [
        "-NoProfile",
        "-Command",
        "$ErrorActionPreference='Stop';" +
          "Get-CimInstance Win32_BIOS | Select-Object -First 1 -ExpandProperty SerialNumber",
      ])
    );
  }

  if (process.platform === "darwin") {
    const platformSerial = await runCommand("ioreg", [
      "-rd1",
      "-c",
      "IOPlatformExpertDevice",
    ]);
    const match = platformSerial.match(
      /"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/
    );
    return normalizeHardwareSerial(match?.[1] ?? "");
  }

  const candidates = [
    "/sys/class/dmi/id/board_serial",
    "/sys/class/dmi/id/product_serial",
  ];

  for (const candidate of candidates) {
    const serial = normalizeHardwareSerial(await readTrimmedFile(candidate));
    if (serial) return serial;
  }

  return "";
}

function getParentBlockDeviceName(blockDevice: string) {
  if (/^nvme\d+n\d+p\d+$/.test(blockDevice)) {
    return blockDevice.replace(/p\d+$/, "");
  }
  if (/^mmcblk\d+p\d+$/.test(blockDevice)) {
    return blockDevice.replace(/p\d+$/, "");
  }
  if (/^[a-z]+\d+$/.test(blockDevice)) {
    return blockDevice.replace(/\d+$/, "");
  }
  return blockDevice;
}

async function readLinuxDiskSerialFromBlock(blockDevice: string) {
  const serial = normalizeHardwareToken(
    await readTrimmedFile(`/sys/class/block/${blockDevice}/device/serial`)
  );
  return serial;
}

async function getLinuxDiskSerial() {
  const mountSource = await runCommand("findmnt", ["-no", "SOURCE", "/"]);
  const normalizedSource = mountSource.replace(/\[.*\]$/, "");
  const sourceName = basename(normalizedSource);
  const blockCandidates = new Set<string>();
  if (sourceName) {
    blockCandidates.add(sourceName);
    blockCandidates.add(getParentBlockDeviceName(sourceName));
  }

  for (const blockDevice of blockCandidates) {
    const serial = await readLinuxDiskSerialFromBlock(blockDevice);
    if (serial) return serial;
  }

  try {
    for (const blockDevice of (await readdir("/sys/class/block")).sort()) {
      const serial = await readLinuxDiskSerialFromBlock(blockDevice);
      if (serial) return serial;
    }
  } catch {
    return "";
  }

  return "";
}

async function getMacOSDiskSerial() {
  const nvmeOutput = await runCommand("ioreg", [
    "-r",
    "-c",
    "AppleNVMeController",
    "-l",
  ]);
  const nvmeMatch = nvmeOutput.match(/"Serial Number"\s*=\s*"([^"]+)"/);
  if (nvmeMatch?.[1]) return normalizeHardwareToken(nvmeMatch[1]);

  const sataOutput = await runCommand("ioreg", [
    "-r",
    "-c",
    "AppleAHCIDiskDriver",
    "-l",
  ]);
  const sataMatch = sataOutput.match(/"Serial Number"\s*=\s*"([^"]+)"/);
  return normalizeHardwareToken(sataMatch?.[1] ?? "");
}

async function getWindowsDiskSerial() {
  return normalizeHardwareToken(
    await runCommand("powershell.exe", [
      "-NoProfile",
      "-Command",
      "$ErrorActionPreference='Stop';" +
        "Get-CimInstance Win32_DiskDrive | Select-Object -First 1 -ExpandProperty SerialNumber",
    ])
  );
}

async function getDiskSerial() {
  if (process.platform === "linux") {
    return await getLinuxDiskSerial();
  }
  if (process.platform === "darwin") {
    return await getMacOSDiskSerial();
  }
  if (process.platform === "win32") {
    return await getWindowsDiskSerial();
  }
  return "";
}

function createFallbackDiskSerial(
  hostInfo: HostInfo,
  macAddress: string,
  serial: string
) {
  return createDeterministicHardwareSerial(
    [
      hostInfo.manufacturer,
      hostInfo.productName,
      hostInfo.modelTag,
      macAddress,
      serial,
    ]
      .filter(Boolean)
      .join("|")
  );
}

function toWindowsAcpBuffer(value: string) {
  const chunks: Buffer[] = [];
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && codePoint <= 0x7f) {
      chunks.push(Buffer.from(char, "ascii"));
      continue;
    }

    const acpBytes = WINDOWS_ACP_CHAR_BYTES[char];
    chunks.push(Buffer.from(acpBytes ?? Buffer.from(char, "utf8")));
  }
  return Buffer.concat(chunks);
}

function md5LowerHex(value: string | Buffer) {
  return createHash("md5").update(value).digest("hex");
}

function createClientSign(
  macAddress: string,
  diskSerialHex: string,
  baseBoardSerial: string,
  hostTag: string
) {
  const seed0 = macAddress + diskSerialHex;
  const md5_1 = md5LowerHex(toWindowsAcpBuffer(seed0 + hostTag));
  const md5_2 = md5LowerHex(Buffer.from(md5_1, "ascii"));
  return `${macAddress}@@@${diskSerialHex}@@@${baseBoardSerial}@@@${md5_1}${md5_2}`;
}

async function createDeviceIdentity(
  options: DeviceIdentityOptions = {}
): Promise<DeviceIdentity> {
  const nextDeviceId = options.rotateDeviceId
    ? generateRandomDeviceId()
    : await createInitialDeviceId();
  const macAddress = getActiveMACAddress() || generateMACAddress();
  const [hostInfo, baseBoardSerial, diskSerial] = await Promise.all([
    getHostInfo(),
    getBaseBoardSerial(),
    getDiskSerial(),
  ]);
  const normalizedDiskSerial = normalizeHardwareToken(diskSerial);
  const effectiveDiskSerial =
    normalizedDiskSerial ||
    createFallbackDiskSerial(hostInfo, macAddress, baseBoardSerial);
  const diskSerialHex = encodeDiskSerial(effectiveDiskSerial);
  const hostTag = createHostTag(hostInfo);

  return {
    deviceIdVersion: DEVICE_ID_VERSION,
    clientSignVersion: CLIENT_SIGN_VERSION,
    deviceId: nextDeviceId,
    ADDeviceId: createClientSign(
      macAddress,
      diskSerialHex,
      baseBoardSerial,
      hostTag
    ),
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

export async function refreshDeviceId(
  reason?: string,
  options: DeviceIdentityOptions = {}
) {
  await saveDeviceIdentity(await createDeviceIdentity(options));
  console.warn(
    `[device] Regenerated device identity${reason ? `: ${reason}` : ""}`
  );
}

function isCurrentDeviceIdentity(identity: DeviceIdentity) {
  return (
    identity.deviceIdVersion === DEVICE_ID_VERSION &&
    identity.clientSignVersion === CLIENT_SIGN_VERSION &&
    Boolean(identity.deviceId) &&
    Boolean(identity.ADDeviceId)
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
      if (isCurrentDeviceIdentity(savedDeviceId)) {
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
