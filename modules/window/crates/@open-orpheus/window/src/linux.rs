use neon::{
    event::Channel,
    handle::Handle,
    object::Object,
    prelude::{Context, Cx, JsFunction, ModuleContext},
    result::NeonResult,
    types::JsValue,
    types::{JsBuffer, buffer::TypedArray},
};
use std::sync::OnceLock;

mod hook;
mod wayland;
mod x11;

static DISABLE_DISPLAY_SERVER_HOOKS: OnceLock<bool> = OnceLock::new();

fn disable_display_server_hooks() -> bool {
    *DISABLE_DISPLAY_SERVER_HOOKS.get_or_init(|| {
        std::env::var("DISABLE_DISPLAY_SERVER_HOOKS")
            .ok()
            .map(|v| {
                let value = v.trim().to_ascii_lowercase();
                !value.is_empty() && value != "0" && value != "false" && value != "no"
            })
            .unwrap_or(false)
    })
}

// Both false -> we are not connecting to either display server,
// so dragWindow will just fail gracefully

#[neon::export]
fn is_wayland() -> bool {
    wayland::is_wayland()
}

#[neon::export]
fn is_x11() -> bool {
    x11::is_x11()
}

#[neon::export]
fn get_last_created_window_id() -> Option<String> {
    wayland::get_last_created_window_id()
}

#[neon::export]
fn drag_window<'cx>(cx: &mut Cx<'cx>, handle: Handle<JsBuffer>) -> NeonResult<()> {
    if wayland::is_wayland() {
        wayland::send_xdg_toplevel_move();
        return Ok(());
    }

    let buf = handle.as_slice(cx);
    if buf.len() != 4 {
        let err_msg = cx.string("Invalid buffer size for window handle");
        return cx.throw(err_msg);
    }
    let Some(window) = buf
        .get(0..4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()) as u64)
    else {
        let err_msg = cx.string("Failed to parse window handle");
        return cx.throw(err_msg);
    };

    if !x11::send_net_wm_moveresize_move(window as u32) {
        let err_msg = cx.string("Failed to send net wm moveresize move event");
        return cx.throw(err_msg);
    }

    Ok(())
}

#[neon::export]
fn capture_next_window_first_cursor_enter<'cx>(
    cx: &mut Cx<'cx>,
    callback: Handle<'cx, JsFunction>,
) -> NeonResult<()> {
    if disable_display_server_hooks() {
        let err_msg = cx.string(
            "captureNextWindowFirstCursorEnter is unavailable when Wayland hooks are disabled",
        );
        return cx.throw(err_msg);
    }

    let channel: Channel = cx.channel();
    let callback = callback.root(cx);
    if !wayland::on_next_new_window_first_cursor_enter(move |x, y| {
        channel.send(move |mut cx| {
            let callback = callback.into_inner(&mut cx);
            let this = cx.undefined();
            let args: [Handle<JsValue>; 2] =
                [cx.number(x as f64).upcast(), cx.number(y as f64).upcast()];
            callback.call(&mut cx, this, args)?;
            Ok(())
        });
    }) {
        let err_msg = cx.string(
            "captureNextWindowFirstCursorEnter is unavailable because Wayland hooks are not initialized",
        );
        return cx.throw(err_msg);
    }

    Ok(())
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    neon::registered().export(&mut cx)?;

    if !disable_display_server_hooks() {
        hook::init_hooks();
    }

    Ok(())
}

#[unsafe(no_mangle)]
pub extern "C" fn on_unload() {
    if !disable_display_server_hooks() {
        hook::remove_hooks();
    }
}

#[used]
#[unsafe(link_section = ".fini_array")]
static DESTRUCTOR: extern "C" fn() = on_unload;
