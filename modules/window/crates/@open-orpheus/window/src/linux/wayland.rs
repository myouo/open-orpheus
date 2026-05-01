// Wayland man-in-the-middle hooker
//
// Strategy:
//   • Inline-hook connect(2) and close(2) in libc using `sighook::inline_hook_jump`.
//   • When connect(2) detects a Wayland socket, we create a proxy `socketpair`,
//     connect a separate real socket to the Wayland server, and swap the app's
//     fd using `dup2`. A background thread proxies traffic and FDs between the
//     app and the real server, parsing the Wayland wire format in transit.
//   • This avoids the need to hook recvmsg/sendmsg, simplifying FD and state
//     management.
//
// Wire format (from connection.c):
//   [object_id : u32][size<<16 | opcode : u32][payload ...]
//   All values are native-endian.  size includes the 8-byte header.
//
// Multi-connection:
//   Each Wayland socket fd gets its own `WaylandConn` tracking object IDs,
//   pointer state, and surface/toplevel mappings.  A single global
//   `LAST_BUTTON` records the most recent button press and its connection fd
//   so `send_xdg_toplevel_move` targets the correct socket.

use std::{
    collections::HashMap,
    mem,
    os::fd::RawFd,
    sync::{Mutex, OnceLock},
};

use libc::{
    AF_UNIX, RTLD_DEFAULT, SYS_close, SYS_connect, c_int, c_long, c_void, dlsym, msghdr,
    sa_family_t, sockaddr, sockaddr_un, syscall,
};
use sighook::{inline_hook_jump, unhook};

// ── Hook metadata storage ─────────────────────────────────────────────────

static HOOK_CONNECT_ADDR: OnceLock<u64> = OnceLock::new();
static HOOK_CLOSE_ADDR: OnceLock<u64> = OnceLock::new();

// ── Per-connection tracking state ──────────────────────────────────────────

struct WaylandConn {
    ifaces: HashMap<u32, Iface>,
    pointer_focus: HashMap<u32, u32>, // ptr_id → wl_surface_id
    pointer_seat: HashMap<u32, u32>,  // ptr_id → seat_id
    xdg_to_wl: HashMap<u32, u32>,     // xdg_surface_id → wl_surface_id
    wl_to_top: HashMap<u32, u32>,     // wl_surface_id → xdg_toplevel_id
    top_to_xdg: HashMap<u32, u32>,    // xdg_toplevel_id → xdg_surface_id
}

impl WaylandConn {
    fn new() -> Self {
        let mut ifaces = HashMap::new();
        ifaces.insert(1u32, Iface::WlDisplay); // wl_display is always object ID 1
        Self {
            ifaces,
            pointer_focus: HashMap::new(),
            pointer_seat: HashMap::new(),
            xdg_to_wl: HashMap::new(),
            wl_to_top: HashMap::new(),
            top_to_xdg: HashMap::new(),
        }
    }

    fn reset_tracking(&mut self) {
        self.ifaces.clear();
        self.ifaces.insert(1u32, Iface::WlDisplay);
        self.pointer_focus.clear();
        self.pointer_seat.clear();
        self.xdg_to_wl.clear();
        self.wl_to_top.clear();
        self.top_to_xdg.clear();
    }

    fn purge(&mut self, id: u32) {
        match self.ifaces.get(&id).copied() {
            Some(Iface::WlPointer) => {
                self.pointer_focus.remove(&id);
                self.pointer_seat.remove(&id);
            }
            Some(Iface::WlSurface) => {
                self.xdg_to_wl.retain(|_, v| *v != id);
                self.wl_to_top.remove(&id);
                self.pointer_focus.retain(|_, v| *v != id);
            }
            Some(Iface::XdgSurface) => {
                // Cascade: purge any xdg_toplevel that depends on this xdg_surface.
                let owned_top = self
                    .top_to_xdg
                    .iter()
                    .find(|(_, v)| **v == id)
                    .map(|(k, _)| *k);
                if let Some(tid) = owned_top {
                    self.purge(tid);
                }
                self.xdg_to_wl.remove(&id);
            }
            Some(Iface::XdgToplevel) => {
                self.top_to_xdg.remove(&id);
                self.wl_to_top.retain(|_, v| *v != id);
            }
            Some(Iface::WlSeat) => {
                self.pointer_seat.retain(|_, v| *v != id);
            }
            _ => {}
        }
        self.ifaces.remove(&id);
    }
}

// ── Global state ───────────────────────────────────────────────────────────

static IS_WAYLAND: OnceLock<bool> = OnceLock::new();
/// Per-connection tracking state, keyed by Wayland socket fd.
static CONNS: OnceLock<Mutex<HashMap<RawFd, WaylandConn>>> = OnceLock::new();
/// Last button-press snapshot: (fd, seat_id, serial, wl_surface_id).
/// Captures the connection fd so `send_xdg_toplevel_move` sends on the right
/// socket.  seat_id is captured at press time so pointer object lifecycle
/// changes (e.g. DevTools opening/closing destroys and re-creates wl_pointer)
/// cannot invalidate the recorded values.
#[allow(clippy::type_complexity)]
static LAST_BUTTON: OnceLock<Mutex<Option<(RawFd, u32, u32, u32)>>> = OnceLock::new();
// Per-fd reassembly buffers — messages can span multiple sendmsg/recvmsg calls.
static RX_BUFS: OnceLock<Mutex<HashMap<RawFd, Vec<u8>>>> = OnceLock::new();
static TX_BUFS: OnceLock<Mutex<HashMap<RawFd, Vec<u8>>>> = OnceLock::new();
static LAST_CREATED_WINDOW_ID: OnceLock<Mutex<Option<LastCreatedWindowId>>> = OnceLock::new();
type CursorEnterCb = Box<dyn FnOnce(i32, i32) + Send>;
type CursorEnterWatcherKey = (RawFd, u32);
type CursorEnterWatcherMap = HashMap<CursorEnterWatcherKey, Vec<CursorEnterCb>>;
static NEXT_TOPLEVEL_CURSOR_ENTER: OnceLock<Mutex<Vec<CursorEnterCb>>> = OnceLock::new();
static CURSOR_ENTER_WATCHERS: OnceLock<Mutex<CursorEnterWatcherMap>> = OnceLock::new();

#[derive(Clone, Copy)]
struct LastCreatedWindowId {
    fd: RawFd,
    toplevel_id: u32,
    xdg_surface_id: u32,
    wl_surface_id: Option<u32>,
}

impl LastCreatedWindowId {
    fn as_token(self) -> String {
        // Stable token format for future per-window Wayland operations.
        format!(
            "wayland:{}:{}:{}:{}",
            self.fd,
            self.toplevel_id,
            self.xdg_surface_id,
            self.wl_surface_id.unwrap_or(0)
        )
    }
}

// ── Toplevel creation callbacks ────────────────────────────────────────────
//
// Extension point for future `make_next_created_wayland_window_*()` APIs.
// Callbacks are consumed (drained) when the next xdg_toplevel is created
// on any tracked connection.

/// Information about a newly created xdg_toplevel, passed to creation callbacks.
#[allow(dead_code)]
pub(super) struct NewToplevel {
    pub fd: RawFd,
    pub toplevel_id: u32,
    pub xdg_surface_id: u32,
    pub wl_surface_id: Option<u32>,
}

type ToplevelCreatedCb = Box<dyn FnOnce(&NewToplevel) + Send>;
static ON_TOPLEVEL_CREATED: OnceLock<Mutex<Vec<ToplevelCreatedCb>>> = OnceLock::new();

/// Registers a one-shot callback invoked when the next xdg_toplevel is created
/// on any tracked connection.  The callback is consumed after invocation.
#[allow(dead_code)]
pub(super) fn on_next_toplevel_created(cb: impl FnOnce(&NewToplevel) + Send + 'static) {
    if let Some(m) = ON_TOPLEVEL_CREATED.get()
        && let Ok(mut cbs) = m.lock()
    {
        cbs.push(Box::new(cb));
    }
}

fn fire_toplevel_callbacks(info: &NewToplevel) {
    if let Some(m) = ON_TOPLEVEL_CREATED.get()
        && let Ok(mut cbs) = m.lock()
    {
        let callbacks: Vec<_> = cbs.drain(..).collect();
        drop(cbs);
        for cb in callbacks {
            cb(info);
        }
    }
}

pub(super) fn on_next_new_window_first_cursor_enter(
    cb: impl FnOnce(i32, i32) + Send + 'static,
) -> bool {
    let Some(m) = NEXT_TOPLEVEL_CURSOR_ENTER.get() else {
        return false;
    };
    let Ok(mut cbs) = m.lock() else {
        return false;
    };
    cbs.push(Box::new(cb));
    true
}

fn arm_first_cursor_enter_watchers(info: &NewToplevel) {
    let Some(wl_surface_id) = info.wl_surface_id else {
        return;
    };
    let Some(pending) = NEXT_TOPLEVEL_CURSOR_ENTER.get() else {
        return;
    };
    let Ok(mut pending) = pending.lock() else {
        return;
    };
    if pending.is_empty() {
        return;
    }
    let callbacks: Vec<_> = pending.drain(..).collect();
    drop(pending);

    if let Some(watchers) = CURSOR_ENTER_WATCHERS.get()
        && let Ok(mut watchers) = watchers.lock()
    {
        watchers
            .entry((info.fd, wl_surface_id))
            .or_default()
            .extend(callbacks);
    }
}

fn fire_first_cursor_enter_watchers(fd: RawFd, wl_surface_id: u32, x: i32, y: i32) {
    let Some(watchers) = CURSOR_ENTER_WATCHERS.get() else {
        return;
    };
    let callbacks = {
        let Ok(mut watchers) = watchers.lock() else {
            return;
        };
        watchers.remove(&(fd, wl_surface_id))
    };
    if let Some(callbacks) = callbacks {
        for callback in callbacks {
            callback(x, y);
        }
    }
}

fn clear_first_cursor_enter_watchers_for_fd(fd: RawFd) {
    if let Some(watchers) = CURSOR_ENTER_WATCHERS.get()
        && let Ok(mut watchers) = watchers.lock()
    {
        watchers.retain(|(watch_fd, _), _| *watch_fd != fd);
    }
}

// ── Object interface tags ──────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Iface {
    WlDisplay,
    WlRegistry,
    WlCompositor,
    WlSeat,
    WlPointer,
    WlSurface,
    XdgWmBase,
    XdgSurface,
    XdgToplevel,
}

// ── Wayland wire protocol opcodes ─────────────────────────────────────────
//
// Values from the Wayland core XML and xdg-shell XML.  Opcodes are per-object
// and start at 0.

// wl_display events (server → client)
const EVT_DELETE_ID: u16 = 1; // wl_display::delete_id(id: uint)

// wl_display requests (client → server)
const REQ_GET_REGISTRY: u16 = 1; // wl_display::get_registry(id: new_id)

// wl_registry requests
const REQ_BIND: u16 = 0; // wl_registry::bind(name, iface_str, ver, new_id)

// wl_compositor requests
const REQ_CREATE_SURFACE: u16 = 0; // wl_compositor::create_surface(id: new_id)

// wl_seat requests
const REQ_GET_POINTER: u16 = 0; // wl_seat::get_pointer(id: new_id)

// wl_pointer events (server → client)
const EVT_ENTER: u16 = 0; // wl_pointer::enter(serial, surface, sx_fixed, sy_fixed)
const EVT_LEAVE: u16 = 1; // wl_pointer::leave(serial, surface)
const EVT_BUTTON: u16 = 3; // wl_pointer::button(serial, time, button, state)
const BTN_PRESSED: u32 = 1; // wl_pointer_button_state::pressed

// xdg_wm_base requests
const REQ_GET_XDG_SURFACE: u16 = 2; // xdg_wm_base::get_xdg_surface(id: new_id, surface: obj)

// xdg_surface requests
const REQ_GET_TOPLEVEL: u16 = 1; // xdg_surface::get_toplevel(id: new_id)

// xdg_toplevel requests
const REQ_MOVE: u16 = 5; // xdg_toplevel::move(seat: obj, serial: uint)

// wl_pointer::release (destructor, since version 3) is opcode 1.
// opcode 0 is wl_pointer::set_cursor — do NOT treat it as a destructor.
const WL_POINTER_RELEASE: u16 = 1;

// Opcode 0 = destructor for: wl_surface, wl_pointer (release), xdg_surface, xdg_toplevel
const REQ_DESTROY: u16 = 0;

// ── Wire helpers ──────────────────────────────────────────────────────────

/// Parses the 8-byte Wayland message header.
/// Returns `(object_id, opcode, total_message_size)` or `None` if malformed.
#[inline]
fn parse_header(buf: &[u8]) -> Option<(u32, u16, usize)> {
    if buf.len() < 8 {
        return None;
    }
    let oid = u32::from_ne_bytes(buf[0..4].try_into().unwrap());
    let word = u32::from_ne_bytes(buf[4..8].try_into().unwrap());
    let op = (word & 0xFFFF) as u16;
    let sz = (word >> 16) as usize;
    // Wayland wire sizes are always 4-byte aligned and at least 8 (header).
    if sz < 8 || !sz.is_multiple_of(4) {
        return None;
    }
    Some((oid, op, sz))
}

/// Reads a u32 from `buf` at byte `offset`.
#[inline]
fn ru32(buf: &[u8], offset: usize) -> Option<u32> {
    buf.get(offset..offset + 4)
        .and_then(|b| b.try_into().ok())
        .map(u32::from_ne_bytes)
}

#[inline]
fn rfixed_i32(buf: &[u8], offset: usize) -> Option<i32> {
    buf.get(offset..offset + 4)
        .and_then(|b| b.try_into().ok())
        .map(i32::from_ne_bytes)
        .map(|value| value >> 8)
}

/// Reads a Wayland string argument (length-prefixed, NUL-terminated, 4-byte padded).
/// Returns `(str_slice, offset_of_next_arg)`.
///
/// Used to parse the interface name inside `wl_registry::bind`, which the Wayland
/// wire protocol encodes as (interface: string, version: uint, new_id: uint) because
/// the `new_id` argument has no static interface in the XML.
fn parse_wl_str(buf: &[u8], offset: usize) -> Option<(&str, usize)> {
    if offset + 4 > buf.len() {
        return None;
    }
    let raw_len = ru32(buf, offset)? as usize;
    if raw_len == 0 {
        return Some(("", offset + 4));
    }
    let data_start = offset + 4;
    let data_end = data_start + raw_len;
    if data_end > buf.len() {
        return None;
    }
    let nul = buf[data_start..data_end]
        .iter()
        .position(|&b| b == 0)
        .unwrap_or(raw_len);
    let s = std::str::from_utf8(&buf[data_start..data_start + nul]).ok()?;
    let padded = (raw_len + 3) & !3;
    let next = data_start + padded;
    if next > buf.len() {
        return None;
    }
    Some((s, next))
}

// ── State helpers ─────────────────────────────────────────────────────────

fn is_wayland_fd(fd: RawFd) -> bool {
    CONNS
        .get()
        .and_then(|m| m.lock().ok())
        .is_some_and(|map| map.contains_key(&fd))
}

// ── Stream reassembly ─────────────────────────────────────────────────────
//
// libwayland's wl_connection_flush may call sendmsg multiple times before
// the buffer is fully drained, and wl_connection_read similarly calls recvmsg
// in a loop.  We reassemble the byte stream per-fd and dispatch complete
// messages only.

fn feed_inbound(fd: RawFd, chunk: &[u8]) {
    feed(fd, chunk, &RX_BUFS, true);
}
fn feed_outbound(fd: RawFd, chunk: &[u8]) {
    feed(fd, chunk, &TX_BUFS, false);
}

fn feed(
    fd: RawFd,
    chunk: &[u8],
    storage: &OnceLock<Mutex<HashMap<RawFd, Vec<u8>>>>,
    is_event: bool,
) {
    let Some(storage) = storage.get() else { return };

    // Hold the buffer lock only long enough to append + extract complete
    // messages.  Releasing before dispatch avoids nested lock ordering issues
    // (the handlers acquire CONNS, LAST_BUTTON, etc.).
    let (msgs, sync_lost) = {
        let Ok(mut map) = storage.lock() else { return };
        let buf = map.entry(fd).or_default();
        buf.extend_from_slice(chunk);
        let mut msgs: Vec<(u32, u16, Vec<u8>)> = Vec::new();
        let mut off = 0;
        while let Some((oid, op, sz)) = parse_header(&buf[off..]) {
            let Some(end) = off.checked_add(sz) else {
                break;
            };
            if end > buf.len() {
                break;
            }
            msgs.push((oid, op, buf[off..end].to_vec()));
            off = end;
        }
        buf.drain(..off);
        let sync_lost = buf.len() > 4 << 20;
        if sync_lost {
            buf.clear();
        }
        (msgs, sync_lost)
    };

    for (oid, op, msg) in msgs {
        if is_event {
            on_event(fd, oid, op, &msg);
        } else {
            on_request(fd, oid, op, &msg);
        }
    }

    // 4 MiB guard: if the reassembly buffer held more than 4 MiB of
    // incomplete data, we have likely lost wire-format sync.  Reset the
    // tracking state for this connection so stale object IDs cannot be reused.
    if sync_lost {
        eprintln!(
            "[wayland] reassembly buffer exceeded 4 MiB — sync lost, resetting state for fd {}",
            fd
        );
        clear_first_cursor_enter_watchers_for_fd(fd);
        if let Some(m) = CONNS.get()
            && let Ok(mut map) = m.lock()
            && let Some(conn) = map.get_mut(&fd)
        {
            conn.reset_tracking();
        }
    }
}

// ── Event handler (server → client) ───────────────────────────────────────

fn on_event(fd: RawFd, oid: u32, op: u16, msg: &[u8]) {
    let Some(conns) = CONNS.get() else { return };
    let Ok(mut guard) = conns.lock() else { return };
    let Some(conn) = guard.get_mut(&fd) else {
        return;
    };

    // wl_display::delete_id — server confirms the client ID is fully released.
    if oid == 1 && op == EVT_DELETE_ID {
        if let Some(dead) = ru32(msg, 8) {
            conn.purge(dead);
        }
        return;
    }

    if conn.ifaces.get(&oid) == Some(&Iface::WlPointer) {
        let pointer_event = handle_pointer_event(conn, oid, op, msg);
        // Drop the CONNS lock before touching LAST_BUTTON to avoid
        // nested-lock ordering issues with send_xdg_toplevel_move.
        drop(guard);
        if let Some((seat_id, serial, surf_id)) = pointer_event.button_info
            && let Some(m) = LAST_BUTTON.get()
            && let Ok(mut opt) = m.lock()
        {
            *opt = Some((fd, seat_id, serial, surf_id));
        }
        if let Some((wl_surface_id, x, y)) = pointer_event.entered_surface {
            fire_first_cursor_enter_watchers(fd, wl_surface_id, x, y);
        }
    }
}

struct PointerEventOutcome {
    button_info: Option<(u32, u32, u32)>,
    entered_surface: Option<(u32, i32, i32)>,
}

/// Processes a wl_pointer event within the connection.
/// Returns `Some((seat_id, serial, surf_id))` for a button press that should
/// update the global `LAST_BUTTON`.
fn handle_pointer_event(
    conn: &mut WaylandConn,
    ptr_id: u32,
    op: u16,
    msg: &[u8],
) -> PointerEventOutcome {
    match op {
        EVT_ENTER => {
            // enter(serial: uint, surface: object, sx: fixed, sy: fixed) — 24 B
            if let (Some(surf_id), Some(x), Some(y)) =
                (ru32(msg, 12), rfixed_i32(msg, 16), rfixed_i32(msg, 20))
            {
                conn.pointer_focus.insert(ptr_id, surf_id);
                return PointerEventOutcome {
                    button_info: None,
                    entered_surface: Some((surf_id, x, y)),
                };
            }
            PointerEventOutcome {
                button_info: None,
                entered_surface: None,
            }
        }
        EVT_LEAVE => {
            // A pointer can focus at most one surface at a time; just remove it.
            conn.pointer_focus.remove(&ptr_id);
            PointerEventOutcome {
                button_info: None,
                entered_surface: None,
            }
        }
        EVT_BUTTON => {
            // button(serial: uint, time: uint, button: uint, state: uint) — 24 B
            let serial = ru32(msg, 8);
            let state = ru32(msg, 20);
            // Record only press events; the serial from a press is what
            // xdg_toplevel::move requires.
            if let (Some(serial), Some(BTN_PRESSED)) = (serial, state) {
                let surf_id = conn.pointer_focus.get(&ptr_id).copied();
                // Snapshot seat_id now — if the pointer object is later destroyed
                // (e.g. DevTools opening causes a wl_pointer release + re-create)
                // the pointer_seat entry for ptr_id will be purged, making a
                // deferred lookup return None.  Capturing it here keeps it valid.
                let seat_id = conn.pointer_seat.get(&ptr_id).copied();
                if let (Some(surf_id), Some(seat_id)) = (surf_id, seat_id) {
                    return PointerEventOutcome {
                        button_info: Some((seat_id, serial, surf_id)),
                        entered_surface: None,
                    };
                }
            }
            PointerEventOutcome {
                button_info: None,
                entered_surface: None,
            }
        }
        _ => PointerEventOutcome {
            button_info: None,
            entered_surface: None,
        },
    }
}

// ── Request handler (client → server) ─────────────────────────────────────

fn on_request(fd: RawFd, oid: u32, op: u16, msg: &[u8]) {
    let mut new_toplevel: Option<NewToplevel> = None;

    {
        let Some(conns) = CONNS.get() else { return };
        let Ok(mut guard) = conns.lock() else { return };
        let Some(conn) = guard.get_mut(&fd) else {
            return;
        };

        let Some(iface) = conn.ifaces.get(&oid).copied() else {
            return;
        };

        match (iface, op) {
            // wl_display::get_registry(id: new_id)
            (Iface::WlDisplay, REQ_GET_REGISTRY) => {
                if let Some(new_id) = ru32(msg, 8) {
                    conn.ifaces.insert(new_id, Iface::WlRegistry);
                }
            }

            // wl_registry::bind(name: uint, interface: string, version: uint, id: new_id)
            //
            // new_id has no static interface in the XML so the wire format prepends
            // (interface: string, version: uint) before the actual id uint.
            (Iface::WlRegistry, REQ_BIND) => {
                // bytes [8..12] = name (uint); bytes [12..] = interface string
                if let Some((iface_name, after)) = parse_wl_str(msg, 12) {
                    // after+0 = version (u32), after+4 = new_id (u32)
                    if let Some(new_id) = ru32(msg, after + 4) {
                        let tag = match iface_name {
                            "wl_compositor" => Some(Iface::WlCompositor),
                            "wl_seat" => Some(Iface::WlSeat),
                            "xdg_wm_base" => Some(Iface::XdgWmBase),
                            _ => None,
                        };
                        if let Some(tag) = tag {
                            conn.ifaces.insert(new_id, tag);
                        }
                    }
                }
            }

            // wl_compositor::create_surface(id: new_id)
            (Iface::WlCompositor, REQ_CREATE_SURFACE) => {
                if let Some(new_id) = ru32(msg, 8) {
                    conn.ifaces.insert(new_id, Iface::WlSurface);
                }
            }

            // wl_seat::get_pointer(id: new_id)
            // Record the seat association so send_xdg_toplevel_move can look it up.
            (Iface::WlSeat, REQ_GET_POINTER) => {
                if let Some(new_id) = ru32(msg, 8) {
                    conn.ifaces.insert(new_id, Iface::WlPointer);
                    conn.pointer_seat.insert(new_id, oid);
                }
            }

            // xdg_wm_base::get_xdg_surface(id: new_id, surface: object)
            (Iface::XdgWmBase, REQ_GET_XDG_SURFACE) => {
                if let (Some(xdg_id), Some(wl_id)) = (ru32(msg, 8), ru32(msg, 12)) {
                    conn.ifaces.insert(xdg_id, Iface::XdgSurface);
                    conn.xdg_to_wl.insert(xdg_id, wl_id);
                }
            }

            // xdg_surface::get_toplevel(id: new_id)
            (Iface::XdgSurface, REQ_GET_TOPLEVEL) => {
                if let Some(top_id) = ru32(msg, 8) {
                    conn.ifaces.insert(top_id, Iface::XdgToplevel);
                    conn.top_to_xdg.insert(top_id, oid);
                    let wl_id = conn.xdg_to_wl.get(&oid).copied();
                    if let Some(wl_id) = wl_id {
                        conn.wl_to_top.insert(wl_id, top_id);
                    }
                    new_toplevel = Some(NewToplevel {
                        fd,
                        toplevel_id: top_id,
                        xdg_surface_id: oid,
                        wl_surface_id: wl_id,
                    });
                }
            }

            // Destructor requests — the client frees the ID immediately on send;
            // we must clean up without waiting for the server's delete_id event.
            // NOTE: wl_pointer's destructor is opcode 1 (release), NOT opcode 0
            //       (set_cursor).  Conflating them would purge the pointer on every
            //       cursor-shape change.
            (Iface::WlSurface | Iface::XdgSurface | Iface::XdgToplevel, REQ_DESTROY) => {
                conn.purge(oid);
            }
            (Iface::WlPointer, WL_POINTER_RELEASE) => {
                conn.purge(oid);
            }

            _ => {}
        }
    } // CONNS lock released

    // Fire toplevel-created callbacks outside the CONNS lock so that
    // callbacks can freely access connection state if needed.
    if let Some(ref info) = new_toplevel {
        if let Some(m) = LAST_CREATED_WINDOW_ID.get()
            && let Ok(mut last) = m.lock()
        {
            *last = Some(LastCreatedWindowId {
                fd: info.fd,
                toplevel_id: info.toplevel_id,
                xdg_surface_id: info.xdg_surface_id,
                wl_surface_id: info.wl_surface_id,
            });
        }
        fire_toplevel_callbacks(info);
        arm_first_cursor_enter_watchers(info);
    }
}

// ── Wayland socket path detection ─────────────────────────────────────────
//
// Mirrors the logic in wl_os_socket_cloexec / wl_display_connect in
// wayland-client.c: the socket path is $XDG_RUNTIME_DIR/$WAYLAND_DISPLAY
// (or $XDG_RUNTIME_DIR/wayland-0 by default).

fn is_wayland_socket(addr: *const c_void, addrlen: u32) -> bool {
    if addr.is_null() || (addrlen as usize) < mem::size_of::<sa_family_t>() {
        return false;
    }
    let sa = unsafe { &*(addr as *const sockaddr) };
    if sa.sa_family as i32 != AF_UNIX {
        return false;
    }

    let sun = unsafe { &*(addr as *const sockaddr_un) };
    let path_offset = mem::size_of::<sa_family_t>();
    let path_len = (addrlen as usize)
        .saturating_sub(path_offset)
        .min(sun.sun_path.len());
    if path_len == 0 {
        return false;
    }

    let raw = unsafe { std::slice::from_raw_parts(sun.sun_path.as_ptr() as *const u8, path_len) };

    // Abstract Unix sockets begin with a NUL byte; filesystem sockets are C-strings.
    let candidate = if raw[0] == 0 {
        &raw[1..]
    } else {
        let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
        &raw[..end]
    };
    if candidate.is_empty() {
        return false;
    }

    // Primary: match against $WAYLAND_DISPLAY (canonical method).
    if let Ok(disp) = std::env::var("WAYLAND_DISPLAY") {
        return candidate.ends_with(disp.as_bytes());
    }

    // Fallback when $WAYLAND_DISPLAY is unset: match the default socket name
    // pattern "wayland-<digits>" (e.g. wayland-0) to avoid false positives
    // from unrelated sockets whose path merely contains "wayland".
    let filename = candidate
        .iter()
        .rposition(|&b| b == b'/')
        .map(|p| &candidate[p + 1..])
        .unwrap_or(candidate);
    filename.starts_with(b"wayland-")
        && filename.len() > 8
        && filename[8..].iter().all(|b| b.is_ascii_digit())
}

// ── Connection management ──────────────────────────────────────────────────

fn reset_connection_state(fd: RawFd) {
    if let Some(m) = CONNS.get()
        && let Ok(mut map) = m.lock()
    {
        map.remove(&fd);
    }
    // Clear LAST_BUTTON if it belongs to this connection.
    if let Some(m) = LAST_BUTTON.get()
        && let Ok(mut opt) = m.lock()
        && opt.is_some_and(|(f, _, _, _)| f == fd)
    {
        *opt = None;
    }
    if let Some(m) = RX_BUFS.get() {
        let _ = m.lock().map(|mut g| g.remove(&fd));
    }
    if let Some(m) = TX_BUFS.get() {
        let _ = m.lock().map(|mut g| g.remove(&fd));
    }
    if let Some(m) = LAST_CREATED_WINDOW_ID.get()
        && let Ok(mut last) = m.lock()
        && last.is_some_and(|id| id.fd == fd)
    {
        *last = None;
    }
    clear_first_cursor_enter_watchers_for_fd(fd);
}

#[inline]
fn raw_syscall_ret(num: c_long, args: &[usize]) -> c_long {
    unsafe {
        match args {
            [a0] => syscall(num, *a0),
            [a0, a1] => syscall(num, *a0, *a1),
            [a0, a1, a2] => syscall(num, *a0, *a1, *a2),
            _ => -1,
        }
    }
}

#[inline]
fn call_connect(fd: c_int, addr: *const c_void, addrlen: u32) -> c_int {
    raw_syscall_ret(
        SYS_connect as c_long,
        &[fd as usize, addr as usize, addrlen as usize],
    ) as c_int
}

#[inline]
fn call_close(fd: c_int) -> c_int {
    raw_syscall_ret(SYS_close as c_long, &[fd as usize]) as c_int
}

// ── Proxy MITM Helpers ────────────────────────────────────────────────────

fn forward_msg(from: RawFd, to: RawFd, is_event: bool, app_fd: RawFd) -> bool {
    let mut buf = vec![0u8; 65536];
    let mut cmsg_buf = vec![0u8; 1024];

    let mut iov = libc::iovec {
        iov_base: buf.as_mut_ptr() as *mut c_void,
        iov_len: buf.len(),
    };

    let mut msg = libc::msghdr {
        msg_name: std::ptr::null_mut(),
        msg_namelen: 0,
        msg_iov: &mut iov,
        msg_iovlen: 1,
        msg_control: cmsg_buf.as_mut_ptr() as *mut c_void,
        msg_controllen: cmsg_buf.len(),
        msg_flags: 0,
    };

    let n = loop {
        let ret = unsafe { libc::recvmsg(from, &mut msg, libc::MSG_CMSG_CLOEXEC) };
        if ret < 0 && unsafe { *libc::__errno_location() } == libc::EINTR {
            continue;
        }
        break ret;
    };

    if n <= 0 {
        return false;
    }

    let data = &buf[..n as usize];
    if is_event {
        feed_inbound(app_fd, data);
    } else {
        feed_outbound(app_fd, data);
    }

    let cmsg_ptr = msg.msg_control;
    let cmsg_len = msg.msg_controllen;

    //iov.iov_len = n as usize;
    let mut total_sent = 0;

    while total_sent < n as usize {
        //iov.iov_base = unsafe { buf.as_mut_ptr().add(total_sent) } as *mut c_void;
        //iov.iov_len = (n as usize) - total_sent;

        if total_sent > 0 {
            msg.msg_control = std::ptr::null_mut();
            msg.msg_controllen = 0;
        }

        let sent = loop {
            let ret = unsafe { libc::sendmsg(to, &msg, libc::MSG_NOSIGNAL) };
            if ret < 0 && unsafe { *libc::__errno_location() } == libc::EINTR {
                continue;
            }
            break ret;
        };

        if sent <= 0 {
            break;
        }
        total_sent += sent as usize;
    }

    // Close any FDs we received from the local socket once they've been
    // queued for sending. Otherwise we leak FDs in the proxy thread.
    if cmsg_len > 0 && !cmsg_ptr.is_null() {
        let msg_for_close = libc::msghdr {
            msg_name: std::ptr::null_mut(),
            msg_namelen: 0,
            msg_iov: std::ptr::null_mut(),
            msg_iovlen: 0,
            msg_control: cmsg_ptr,
            msg_controllen: cmsg_len,
            msg_flags: 0,
        };
        unsafe {
            let mut cmsg = libc::CMSG_FIRSTHDR(&msg_for_close);
            while !cmsg.is_null() {
                if (*cmsg).cmsg_level == libc::SOL_SOCKET && (*cmsg).cmsg_type == libc::SCM_RIGHTS {
                    let fd_ptr = libc::CMSG_DATA(cmsg) as *mut c_int;
                    let header_len = (fd_ptr as usize) - (cmsg as usize);
                    if (*cmsg).cmsg_len as usize > header_len {
                        let data_len = (*cmsg).cmsg_len as usize - header_len;
                        let fd_count = data_len / std::mem::size_of::<c_int>();
                        for i in 0..fd_count {
                            let fd = *fd_ptr.add(i);
                            if fd >= 0 {
                                call_close(fd);
                            }
                        }
                    }
                }
                cmsg = libc::CMSG_NXTHDR(&msg_for_close, cmsg);
            }
        }
    }

    total_sent == n as usize
}

fn proxy_loop(app_fd: RawFd, proxy_fd: RawFd, real_fd: RawFd) {
    let mut fds = [
        libc::pollfd {
            fd: proxy_fd,
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: real_fd,
            events: libc::POLLIN,
            revents: 0,
        },
    ];

    loop {
        let ret = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
        if ret < 0 {
            let err = unsafe { *libc::__errno_location() };
            if err == libc::EINTR {
                continue;
            }
            break;
        }

        if fds[0].revents & (libc::POLLIN | libc::POLLERR | libc::POLLHUP) != 0
            && !forward_msg(proxy_fd, real_fd, false, app_fd)
        {
            break;
        }

        if fds[1].revents & (libc::POLLIN | libc::POLLERR | libc::POLLHUP) != 0
            && !forward_msg(real_fd, proxy_fd, true, app_fd)
        {
            break;
        }
    }

    call_close(proxy_fd);
    call_close(real_fd);
}

// ── Hook callbacks ─────────────────────────────────────────────────────────
//
// Plain `extern "C"` functions installed with sighook entry jumps.
// Calling the original goes straight to the kernel syscall entry so we do not
// mutate hook state while already inside a hooked libc wrapper.

/// connect(2) — detect Wayland socket fds, set up socketpair, proxy real connect.
extern "C" fn hook_connect(fd: c_int, addr: *const c_void, addrlen: u32) -> c_int {
    if !is_wayland_socket(addr, addrlen) {
        return call_connect(fd, addr, addrlen);
    }

    // 1. Open a real connection to the Wayland server.
    let real_fd = unsafe { libc::socket(AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if real_fd < 0 {
        return -1;
    }

    let ret = call_connect(real_fd, addr, addrlen);
    if ret < 0 {
        let err = unsafe { *libc::__errno_location() };
        call_close(real_fd);
        unsafe { *libc::__errno_location() = err };
        return ret;
    }

    // 2. Set up our MITM socketpair.
    let mut pair = [0; 2];
    if unsafe {
        libc::socketpair(
            AF_UNIX,
            libc::SOCK_STREAM | libc::SOCK_CLOEXEC,
            0,
            pair.as_mut_ptr(),
        )
    } < 0
    {
        let err = unsafe { *libc::__errno_location() };
        call_close(real_fd);
        unsafe { *libc::__errno_location() = err };
        return -1;
    }

    let fd_flags = unsafe { libc::fcntl(fd, libc::F_GETFD, 0) };
    let fl_flags = unsafe { libc::fcntl(fd, libc::F_GETFL, 0) };

    // 3. Transparently replace the application's file descriptor with our local socket end.
    if unsafe { libc::dup2(pair[0], fd) } < 0 {
        let err = unsafe { *libc::__errno_location() };
        call_close(real_fd);
        call_close(pair[0]);
        call_close(pair[1]);
        unsafe { *libc::__errno_location() = err };
        return -1;
    }
    call_close(pair[0]);

    // Restore any flags (e.g. O_NONBLOCK, FD_CLOEXEC) that the application
    // might have set on its original socket before calling connect.
    if fd_flags >= 0 {
        unsafe { libc::fcntl(fd, libc::F_SETFD, fd_flags) };
    }
    if fl_flags >= 0 {
        unsafe { libc::fcntl(fd, libc::F_SETFL, fl_flags) };
    }

    IS_WAYLAND.set(true).ok();
    if let Some(m) = CONNS.get()
        && let Ok(mut map) = m.lock()
    {
        map.entry(fd).or_insert_with(WaylandConn::new);
    }

    // 4. Start background proxying loop.
    let proxy_fd = pair[1];
    std::thread::spawn(move || {
        proxy_loop(fd, proxy_fd, real_fd);
    });

    0
}

/// close(2) — detect when a tracked Wayland fd is closed.
extern "C" fn hook_close(fd: c_int) -> c_int {
    if is_wayland_fd(fd) {
        reset_connection_state(fd);
    }
    call_close(fd)
}

// ── Public API ─────────────────────────────────────────────────────────────

pub(super) fn is_wayland() -> bool {
    *IS_WAYLAND.get().unwrap_or(&false)
}

/// Sends raw bytes on the given fd. Since we use a socketpair proxy,
/// this simply injects data onto the app side of the socketpair which
/// naturally proxies it to the real Wayland server.
///
/// Returns `true` if all bytes were sent.
#[allow(dead_code)]
pub(super) fn send_raw_wayland(fd: RawFd, data: &mut [u8]) -> bool {
    let mut iov = libc::iovec {
        iov_base: data.as_mut_ptr() as *mut c_void,
        iov_len: data.len(),
    };
    let msg = msghdr {
        msg_name: std::ptr::null_mut(),
        msg_namelen: 0,
        msg_iov: &mut iov as *mut libc::iovec,
        msg_iovlen: 1,
        msg_control: std::ptr::null_mut(),
        msg_controllen: 0,
        msg_flags: 0,
    };
    // Use `libc::sendmsg` directly — we don't hook sendmsg anymore.
    let ret = unsafe { libc::sendmsg(fd, &msg as *const msghdr, libc::MSG_NOSIGNAL) };
    ret as usize == data.len()
}

/// Sends `xdg_toplevel::move` using the serial from the last recorded
/// `wl_pointer::button` press.  Returns `true` on success.
pub(super) fn send_xdg_toplevel_move() -> bool {
    // Retrieve the button-press snapshot captured in handle_pointer_event.
    // seat_id was snapshotted at press time, so pointer lifecycle changes
    // (DevTools open/close, pointer re-creation) cannot invalidate it.
    let Some((fd, seat_id, serial, wl_surf_id)) = LAST_BUTTON
        .get()
        .and_then(|m| m.lock().ok())
        .and_then(|g| *g)
    else {
        eprintln!("[wayland] send_xdg_toplevel_move: no button event recorded yet");
        return false;
    };

    // Look up the xdg_toplevel for the focused wl_surface on this connection.
    let top_id = {
        let Some(conns) = CONNS.get() else {
            return false;
        };
        let Ok(guard) = conns.lock() else {
            return false;
        };
        let Some(conn) = guard.get(&fd) else {
            eprintln!(
                "[wayland] send_xdg_toplevel_move: connection for fd {} no longer tracked",
                fd
            );
            return false;
        };

        // Primary: direct wl_surface → xdg_toplevel mapping populated at get_toplevel time.
        conn.wl_to_top
            .get(&wl_surf_id)
            .copied()
            .filter(|id| conn.ifaces.get(id) == Some(&Iface::XdgToplevel))
            // Fallback: reverse-search through xdg_surface when the direct entry is stale.
            .or_else(|| {
                let xdg_id = conn
                    .xdg_to_wl
                    .iter()
                    .find(|(_, v)| **v == wl_surf_id)
                    .map(|(k, _)| *k);
                xdg_id.and_then(|xid| {
                    conn.top_to_xdg
                        .iter()
                        .filter(|(tid, sid)| {
                            **sid == xid && conn.ifaces.get(tid) == Some(&Iface::XdgToplevel)
                        })
                        .map(|(tid, _)| *tid)
                        .max()
                })
            })
    };

    let Some(top_id) = top_id else {
        eprintln!(
            "[wayland] send_xdg_toplevel_move: no live xdg_toplevel for wl_surface {}",
            wl_surf_id
        );
        return false;
    };

    // Craft xdg_toplevel::move(seat: object, serial: uint)
    //   [xdg_toplevel_id : u32][size<<16 | opcode : u32][seat_id : u32][serial : u32]
    //   Total: 16 bytes.
    let hdr_word = (REQ_MOVE as u32) | (16u32 << 16);
    let mut buf = [0u8; 16];
    buf[0..4].copy_from_slice(&top_id.to_ne_bytes());
    buf[4..8].copy_from_slice(&hdr_word.to_ne_bytes());
    buf[8..12].copy_from_slice(&seat_id.to_ne_bytes());
    buf[12..16].copy_from_slice(&serial.to_ne_bytes());

    if !send_raw_wayland(fd, &mut buf) {
        eprintln!(
            "[wayland] send_xdg_toplevel_move: sendmsg failed (errno {})",
            unsafe { *libc::__errno_location() }
        );
        return false;
    }

    true
}

pub(super) fn get_last_created_window_id() -> Option<String> {
    LAST_CREATED_WINDOW_ID
        .get()
        .and_then(|m| m.lock().ok())
        .and_then(|id| *id)
        .map(LastCreatedWindowId::as_token)
}

// ── Hook installation ─────────────────────────────────────────────────────

/// Resolves a libc symbol, saves the original function pointer, and patches the
/// libc entry to jump to our hook.
macro_rules! install_hook {
    ($addr_slot:expr, $name:literal, $detour_fn:expr) => {{
        let sym = unsafe { dlsym(RTLD_DEFAULT, concat!($name, "\0").as_ptr() as *const _) };
        if sym.is_null() {
            eprintln!("[wayland] symbol not found: {} — hook setup aborted", $name);
            return;
        }
        let target_addr = sym as usize as u64;
        if $addr_slot.set(target_addr).is_err() {
            eprintln!(
                "[wayland] target address slot for {} already set — skipping",
                $name
            );
            return;
        }
        if let Err(e) = inline_hook_jump(target_addr, $detour_fn as *const () as usize as u64) {
            eprintln!("[wayland] failed to enable hook for {}: {}", $name, e);
            return;
        }
    }};
}

pub(super) fn init_wayland_hook() {
    // Initialise all state before any hook fires.
    CONNS.get_or_init(|| Mutex::new(HashMap::new()));
    LAST_BUTTON.get_or_init(|| Mutex::new(None));
    LAST_CREATED_WINDOW_ID.get_or_init(|| Mutex::new(None));
    RX_BUFS.get_or_init(|| Mutex::new(HashMap::new()));
    TX_BUFS.get_or_init(|| Mutex::new(HashMap::new()));
    NEXT_TOPLEVEL_CURSOR_ENTER.get_or_init(|| Mutex::new(Vec::new()));
    CURSOR_ENTER_WATCHERS.get_or_init(|| Mutex::new(HashMap::new()));
    ON_TOPLEVEL_CREATED.get_or_init(|| Mutex::new(Vec::new()));

    install_hook!(HOOK_CONNECT_ADDR, "connect", hook_connect);
    install_hook!(HOOK_CLOSE_ADDR, "close", hook_close);
}

/// Removes all installed Wayland hooks and resets all connection state.
/// Safe to call from any thread; idempotent if called multiple times.
pub(super) fn remove_wayland_hook() {
    // Clear all connection state.
    if let Some(m) = CONNS.get()
        && let Ok(mut map) = m.lock()
    {
        map.clear();
    }
    if let Some(m) = LAST_BUTTON.get()
        && let Ok(mut opt) = m.lock()
    {
        *opt = None;
    }
    if let Some(m) = LAST_CREATED_WINDOW_ID.get()
        && let Ok(mut opt) = m.lock()
    {
        *opt = None;
    }
    if let Some(m) = RX_BUFS.get()
        && let Ok(mut map) = m.lock()
    {
        map.clear();
    }
    if let Some(m) = TX_BUFS.get()
        && let Ok(mut map) = m.lock()
    {
        map.clear();
    }
    if let Some(m) = NEXT_TOPLEVEL_CURSOR_ENTER.get()
        && let Ok(mut cbs) = m.lock()
    {
        cbs.clear();
    }
    if let Some(m) = CURSOR_ENTER_WATCHERS.get()
        && let Ok(mut watchers) = m.lock()
    {
        watchers.clear();
    }
    if let Some(m) = ON_TOPLEVEL_CREATED.get()
        && let Ok(mut cbs) = m.lock()
    {
        cbs.clear();
    }
    if let Some(addr) = HOOK_CLOSE_ADDR.get() {
        let _ = unhook(*addr);
    }
    if let Some(addr) = HOOK_CONNECT_ADDR.get() {
        let _ = unhook(*addr);
    }
}
