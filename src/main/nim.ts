import { BrowserWindow, WebContents, ipcMain } from "electron";
import client from "./request";
import { serialData } from "./crypto";
import { isRecord, getStringField, getStringParam, summarizeResponseBody } from "../shared/utils";
import {
  extractListenTogetherCommandInfo,
  ListenTogetherCommandInfo,
} from "../shared/listenTogetherCommand";
import {
  IPC,
  LISTEN_TOGETHER_SYNC_INTERVAL,
} from "../shared/listenTogetherConstants";

export { type ListenTogetherCommandInfo } from "../shared/listenTogetherCommand";
export { extractListenTogetherCommandInfo } from "../shared/listenTogetherCommand";

export const rtcParams = {
  channelId: "",
  roomId: "",
  userId: "",
  canBroadcastNativePlayCommand: false,
};

let chatroomWebContentsId = 0;
let currentChatroomId = "";
let reverseSyncTimer: NodeJS.Timeout | null = null;
let reverseSyncRunning = false;
let lastReverseSyncSignature = "";
let lastReverseSyncStatusSignature = "";
let chatroomConnectionState: "idle" | "resolving" | "connecting" | "connected" | "leaving" = "idle";
let chatroomConnectingStartedAt = 0;

type RtcEnterParams = Record<string, unknown>;

type ListenTogetherTokenResult =
  | {
      code: 200;
      data: {
        imToken: string;
        imAccId: string;
        imUid: string;
        yunxinToken: string;
        yunxinExpireTime: unknown;
      };
    }
  | { code: -1; message: string };

function resetDedupeState() {
  lastReverseSyncSignature = "";
  lastReverseSyncStatusSignature = "";
}

function getReverseSyncSignature(commandInfo: ListenTogetherCommandInfo) {
  return [
    rtcParams.roomId,
    commandInfo.clientSeq ?? "",
    commandInfo.commandType ?? "",
    commandInfo.playStatus ?? "",
    commandInfo.formerSongId ?? "",
    commandInfo.targetSongId ?? commandInfo.songId ?? "",
    commandInfo.progress ?? "",
  ].join(":");
}

function isDuplicateCommand(commandInfo: ListenTogetherCommandInfo) {
  const signature = getReverseSyncSignature(commandInfo);
  if (signature === lastReverseSyncSignature) return true;
  lastReverseSyncSignature = signature;
  return false;
}

function dispatchCommandToAllWindows(
  commandInfo: ListenTogetherCommandInfo,
  source: string
) {
  console.log(
    "[LT:REVERSE] apply",
    source,
    commandInfo.commandType,
    commandInfo.playStatus,
    commandInfo.targetSongId ?? commandInfo.songId ?? "",
    commandInfo.progress ?? ""
  );
  let dispatched = false;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(IPC.LT_APPLY_REMOTE_PLAY_COMMAND, commandInfo);
    dispatched = true;
  }
  return dispatched;
}

export function dispatchReverseListenTogetherCommand(
  commandInfo: ListenTogetherCommandInfo,
  source = "unknown"
) {
  if (isDuplicateCommand(commandInfo)) return false;
  return dispatchCommandToAllWindows(commandInfo, source);
}

function dispatchReverseListenTogetherCommandToAll(
  value: unknown,
  source: string
) {
  const commandInfo = extractListenTogetherCommandInfo(value);
  if (!commandInfo) return false;
  return dispatchReverseListenTogetherCommand(commandInfo, source);
}

function extractStatusChatRoomId(body: string) {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.data) || !isRecord(parsed.data.roomInfo)) {
      return "";
    }
    return getStringField(parsed.data.roomInfo, ["chatRoomId", "chatroomId", "chat_roomid"]) ?? "";
  } catch {
    return "";
  }
}

function extractStatusInRoom(body: string): boolean | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.data)) return undefined;
    const inRoom = parsed.data.inRoom;
    if (typeof inRoom === "boolean") return inRoom;
    return undefined;
  } catch {
    return undefined;
  }
}

function logReverseSyncStatus(statusCode: number, body: string) {
  let signature = String(statusCode);
  let summary = summarizeResponseBody(body);
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed)) {
      const data = isRecord(parsed.data) ? parsed.data : null;
      const roomInfo = data && isRecord(data.roomInfo) ? data.roomInfo : null;
      const users = roomInfo && Array.isArray(roomInfo.roomUsers) ? roomInfo.roomUsers.length : 0;
      const roomId = roomInfo ? getStringField(roomInfo, ["roomId"]) : undefined;
      const chatRoomId = roomInfo ? getStringField(roomInfo, ["chatRoomId"]) : undefined;
      const inRoom = data?.inRoom;
      signature = [statusCode, inRoom, roomId ?? "", chatRoomId ?? "", users].join(":");
      summary = `code=${parsed.code ?? ""} inRoom=${String(inRoom)} roomId=${roomId ?? ""} chatRoomId=${chatRoomId ?? ""} users=${users}`;
    }
  } catch {
    // Keep raw summary for non-JSON responses.
  }

  if (signature === lastReverseSyncStatusSignature) return;
  lastReverseSyncStatusSignature = signature;
  console.log("[LT:POLL] status/get HTTP", statusCode, summary);
}

export function startReverseSyncPoll() {
  if (reverseSyncTimer) {
    stopReverseSyncPoll();
  }
  console.log("[LT:POLL] starting reverse sync poll, roomId:", rtcParams.roomId);
  const sessionRoomId = rtcParams.roomId;

  async function poll() {
    if (!rtcParams.roomId || !rtcParams.channelId || rtcParams.roomId !== sessionRoomId) {
      stopReverseSyncPoll();
      return;
    }
    if (reverseSyncRunning) return;
    reverseSyncRunning = true;
    try {
      const resp = await client.post("https://music.163.com/api/listen/together/status/get", {
        form: { roomId: rtcParams.roomId },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        throwHttpErrors: false,
      });

      if (rtcParams.roomId !== sessionRoomId) return;

      logReverseSyncStatus(resp.statusCode, resp.body);

      let apiSuccess = false;
      try {
        const parsed = JSON.parse(resp.body);
        apiSuccess = isRecord(parsed) && parsed.code === 200;
      } catch { /* non-JSON */ }

      if (!apiSuccess) return;

      const inRoom = extractStatusInRoom(resp.body);
      if (inRoom === false) {
        console.log("[LT:POLL] server says not in room, triggering leave");
        leaveListenTogether("poll-not-in-room");
        return;
      }

      const chatRoomId = extractStatusChatRoomId(resp.body);
      if (chatRoomId && chatRoomId !== currentChatroomId && chatroomConnectionState === "idle") {
        console.log("[LT:POLL] auto joining chatroom from status/get:", chatRoomId);
        currentChatroomId = chatRoomId;
        chatroomConnectionState = "connecting";
        chatroomConnectingStartedAt = Date.now();
        const ownerWin = getOwnerWindow();
        if (ownerWin) {
          ownerWin.webContents.send(IPC.NIM_JOIN_CHATROOM, chatRoomId, rtcParams.userId);
        }
      }

      if (chatroomConnectionState === "connecting" && chatroomConnectingStartedAt > 0 &&
          Date.now() - chatroomConnectingStartedAt > 30000) {
        console.warn("[LT:POLL] chatroom connecting timed out, resetting to idle");
        chatroomConnectionState = "idle";
        chatroomConnectingStartedAt = 0;
      }

      const commandInfo = extractListenTogetherCommandInfo(resp.body);
      if (commandInfo) {
        dispatchReverseListenTogetherCommand(commandInfo, "poll");
      }
    } catch (e) {
      console.warn("[LT:POLL] status/get failed:", e);
    } finally {
      reverseSyncRunning = false;
    }
  }

  poll();
  reverseSyncTimer = setInterval(poll, LISTEN_TOGETHER_SYNC_INTERVAL);
}

export function stopReverseSyncPoll() {
  if (!reverseSyncTimer) return;
  console.log("[LT:POLL] stopping reverse sync poll");
  clearInterval(reverseSyncTimer);
  reverseSyncTimer = null;
}

export function leaveListenTogether(reason: string) {
  console.log("[LT] leaveListenTogether, reason:", reason);
  stopReverseSyncPoll();
  resetDedupeState();
  rtcParams.channelId = "";
  rtcParams.roomId = "";
  rtcParams.userId = "";
  rtcParams.canBroadcastNativePlayCommand = false;
  chatroomWebContentsId = 0;
  currentChatroomId = "";
  chatroomConnectionState = "idle";
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    w.webContents.send(IPC.NIM_CLEANUP);
  }
}

async function getListenTogetherToken(
  channelId?: string,
  roomId?: string
): Promise<ListenTogetherTokenResult> {
  const cid = channelId || rtcParams.channelId;
  const rid = roomId || rtcParams.roomId;

  try {
    const imResp = await client.post("https://music.163.com/api/middle/im/token/get", {
      throwHttpErrors: false,
    });
    const imData = JSON.parse(imResp.body);
    if (imData.code !== 200 || !imData.data?.token) {
      console.warn("[NIM] IM token failed: HTTP", imResp.statusCode, "code:", imData.code);
      return { code: -1, message: "Failed to get IM token" };
    }

    const baseData = {
      imToken: imData.data.token,
      imAccId: imData.data.accId ?? imData.data.uid ?? "",
      imUid: imData.data.uid ?? "",
    };

    if (!cid || !rid) {
      console.log("[NIM] getListenTogetherToken: skipping yunxin token, no channelId/roomId yet");
      return {
        code: 200,
        data: {
          ...baseData,
          yunxinToken: "",
          yunxinExpireTime: null,
        },
      };
    }

    const body = `channelId=${encodeURIComponent(cid)}&roomId=${encodeURIComponent(rid)}`;
    const yxResp = await client.post(
      "https://music.163.com/api/listen/together/yunxin/token/get",
      {
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        throwHttpErrors: false,
      }
    );
    const yxData = JSON.parse(yxResp.body);
    if (yxData.code !== 200 || !yxData.data?.token) {
      console.warn("[NIM] yunxin token failed: HTTP", yxResp.statusCode, "code:", yxData.code);
      return { code: -1, message: "Failed to get yunxin token" };
    }

    return {
      code: 200,
      data: {
        ...baseData,
        yunxinToken: yxData.data.token,
        yunxinExpireTime: yxData.data.expireTime,
      },
    };
  } catch (e) {
    console.error("[NIM] getListenTogetherToken error:", e);
    return { code: -1, message: String(e) };
  }
}

function getAddressList(data: unknown) {
  const raw = getAddressListCandidate(data);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function getAddressListCandidate(data: unknown): unknown {
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data)) return data;

  const candidate = data as {
    addr?: unknown;
    address?: unknown;
    addresses?: unknown;
    chatroomAddresses?: unknown;
    data?: unknown;
    items?: unknown;
    result?: unknown;
  };

  if (Array.isArray(candidate.addr)) return candidate.addr;
  if (Array.isArray(candidate.address)) return candidate.address;
  if (Array.isArray(candidate.addresses)) return candidate.addresses;
  if (Array.isArray(candidate.chatroomAddresses)) return candidate.chatroomAddresses;
  if (Array.isArray(candidate.items)) return candidate.items;
  return getAddressListCandidate(candidate.data ?? candidate.result);
}

function getOwnerWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  if (chatroomWebContentsId) {
    const owner = windows.find((w) => w.webContents.id === chatroomWebContentsId);
    if (owner) return owner;
  }
  return windows.length > 0 ? windows[0] : null;
}

export function enterOrJoinRtc(
  method: "enter" | "join",
  webContents: WebContents,
  params: Record<string, unknown>
) {
  rtcParams.channelId = getStringParam(
    params,
    "channelId",
    "channelName",
    "agoraChannelId",
    "rtcChannelId"
  );
  rtcParams.roomId = getStringParam(params, "roomId", "roomid", "roomID");
  rtcParams.userId = getStringParam(params, "userId", "user_id", "uid");
  rtcParams.canBroadcastNativePlayCommand = true;
  resetDedupeState();
  startReverseSyncPoll();
  console.log(`[RTC] ${method}`, rtcParams);

  const resultEvent = method === "enter" ? "rtc.onEnter" : "rtc.onJoin";
  webContents.send("channel.call", resultEvent, {
    code: 200,
    channelId: rtcParams.channelId,
    roomId: rtcParams.roomId,
    roomRTCType: params.roomRTCType ?? "yunxin",
  });
}

export function broadcastListenTogetherPlayCommand(commandInfo: ListenTogetherCommandInfo) {
  console.log("[LT:SEND] broadcast", commandInfo.commandType, commandInfo.playStatus, commandInfo.targetSongId);
  if (!commandInfo.userId && rtcParams.userId) {
    commandInfo.userId = Number.isNaN(Number(rtcParams.userId))
      ? rtcParams.userId
      : Number(rtcParams.userId);
  }
  const text = JSON.stringify({
    content: {
      type: 20000,
      content: commandInfo,
    },
  });

  const ownerWin = getOwnerWindow();
  if (ownerWin) {
    console.log("[LT:SEND] sending play command to owner window:", ownerWin.id);
    ownerWin.webContents.send(IPC.NIM_SEND_PLAY_COMMAND, text);
    return;
  }
  console.warn("[LT:SEND] no owner window found, play command dropped");
}

// ===== IPC Handlers =====

ipcMain.handle(IPC.NIM_GET_LISTEN_TOGETHER_TOKEN, async (_event, channelId?: string, roomId?: string) => {
  return getListenTogetherToken(channelId, roomId);
});

ipcMain.handle(IPC.NIM_GET_CHATROOM_ADDR, async (_event, chatRoomId?: string, userId?: string) => {
  const cid = typeof chatRoomId === "string" ? chatRoomId : "";
  if (!cid) {
    console.warn("[NIM] getChatroomAddr: no chatRoomId provided");
    return { addresses: [] as string[] };
  }

  try {
    const tokenResult = await getListenTogetherToken();
    const accid = tokenResult.code === 200 ? tokenResult.data.imAccId : "";
    const fallbackAccid = typeof userId === "string" && userId ? userId : rtcParams.userId;
    const addressAccid = accid || fallbackAccid;
    const addressBody = addressAccid
      ? `roomid=${encodeURIComponent(cid)}&accid=${encodeURIComponent(addressAccid)}&clienttype=1`
      : `roomid=${encodeURIComponent(cid)}`;
    const eapiParams = serialData("/api/im/getChatroomAddr", addressBody);
    const addrResp = await client.post(
      "https://music.163.com/api/linux/forward",
      {
        body: `eparams=${eapiParams}`,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        throwHttpErrors: false,
      }
    );

    let addrData: unknown;
    try {
      addrData = JSON.parse(addrResp.body);
    } catch {
      console.warn("[NIM] chatroom addr API returned invalid JSON, falling back to non-eapi endpoint");
      addrData = {};
    }
    const addresses = getAddressList(addrData);

    if (!Array.isArray(addresses) || addresses.length === 0) {
      console.warn(
        "[NIM] chatroom eapi addr empty:",
        addrResp.statusCode,
        summarizeResponseBody(addrResp.body)
      );
      const altResp = await client.post(
        "https://music.163.com/api/im/getChatroomAddr",
        {
          body: addressBody,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          throwHttpErrors: false,
        }
      );

      let altData: unknown;
      try {
        altData = JSON.parse(altResp.body);
      } catch {
        console.warn("[NIM] fallback chatroom addr API also returned invalid JSON");
        altData = {};
      }
      const addrs = getAddressList(altData);
      if (addrs.length === 0) {
        console.warn(
          "[NIM] chatroom fallback addr empty:",
          altResp.statusCode,
          summarizeResponseBody(altResp.body)
        );
        console.warn("[NIM] no chatroom addresses available, letting SDK resolve chatroom addresses");
      } else {
        addresses.push(...addrs);
      }
    }

    console.log("[NIM] got", addresses.length, "chatroom addresses:", addresses);
    return { addresses };
  } catch (e) {
    console.error("[NIM] getChatroomAddr error:", e);
    return { addresses: [] as string[] };
  }
});

ipcMain.on(IPC.NIM_JOIN_CHATROOM, (_event, chatRoomId?: string, _userId?: string) => {
  const cid = typeof chatRoomId === "string" ? chatRoomId : "";
  if (!cid) {
    console.warn("[NIM] joinChatroom: no chatRoomId provided, skipping");
    return;
  }
  chatroomWebContentsId = _event.sender.id;
  currentChatroomId = cid;
  chatroomConnectionState = "connecting";
  chatroomConnectingStartedAt = Date.now();
  console.log("[NIM] chatroom join registered for", cid);
});

ipcMain.on(IPC.NIM_LEAVE_CHATROOM, () => {
  leaveListenTogether("nim.leaveChatroom");
});

ipcMain.on(IPC.NIM_LEAVE, () => {
  leaveListenTogether("nim.leave");
});

ipcMain.on(IPC.LT_CHATROOM_CONNECTED, () => {
  if (chatroomConnectionState === "connecting") {
    chatroomConnectionState = "connected";
    chatroomConnectingStartedAt = 0;
    console.log("[NIM] chatroom connection confirmed by renderer");
  }
});

ipcMain.on(IPC.LT_REMOTE_EVENT, (_event, payload: string, source: string) => {
  dispatchReverseListenTogetherCommandToAll(payload, source);
});

ipcMain.on(IPC.LT_PAGE_LOG, (_event, level: string, message: string) => {
  const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  method("[LT:PAGE]", message);
});

ipcMain.handle(IPC.NIM_ENTER_RTC, async (_event, params: RtcEnterParams) => {
  rtcParams.channelId = getStringParam(
    params,
    "channelId",
    "channelName",
    "agoraChannelId",
    "rtcChannelId"
  );
  rtcParams.roomId = getStringParam(params, "roomId", "roomid", "roomID");
  rtcParams.userId = getStringParam(params, "userId", "user_id", "uid");
  rtcParams.canBroadcastNativePlayCommand = true;
  resetDedupeState();
  startReverseSyncPoll();
  return { code: 200 };
});

ipcMain.on(IPC.LT_NATIVE_PLAY_COMMAND, (_event, commandInfo: ListenTogetherCommandInfo) => {
  console.log("[LT:IPC] nativePlayCommand, canBroadcast:", rtcParams.canBroadcastNativePlayCommand, "type:", commandInfo.commandType);
  if (!rtcParams.canBroadcastNativePlayCommand) {
    console.log("[LT:IPC] blocked: canBroadcastNativePlayCommand=false");
    return;
  }

  if (rtcParams.channelId && rtcParams.roomId) {
    const body = `channelId=${encodeURIComponent(rtcParams.channelId)}&roomId=${encodeURIComponent(rtcParams.roomId)}&commandInfo=${encodeURIComponent(JSON.stringify(commandInfo))}`;
    client.post("https://music.163.com/api/listen/together/play/command/report", {
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      throwHttpErrors: false,
    }).then((resp) => {
      console.log("[LT:API] HTTP", resp.statusCode, "body:", resp.body.slice(0, 300));
    }).catch((e) => {
      console.warn("[LT:API] HTTP failed:", e);
    });
  }
});
