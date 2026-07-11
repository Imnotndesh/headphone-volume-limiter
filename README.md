# Headphone Volume Limiter

GNOME Shell extension (45+) that caps media volume when headphones
(wired or Bluetooth) are the active output — like the Samsung feature
this was ported from.

## Install (dev/testing mode)

```bash
# Symlink into GNOME's extension directory
mkdir -p ~/.local/share/gnome-shell/extensions
ln -s "$(pwd)/headphone-volume-limiter@brian.local" \
      ~/.local/share/gnome-shell/extensions/headphone-volume-limiter@brian.local

# Compile the settings schema
glib-compile-schemas ~/.local/share/gnome-shell/extensions/headphone-volume-limiter@brian.local/schemas/

# On X11: reload the shell
# Alt+F2, type 'r', Enter

# On Wayland: log out and back in (no in-session shell reload on Wayland)

# Enable it
gnome-extensions enable headphone-volume-limiter@brian.local
```

Watch logs while testing:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Open prefs:

```bash
gnome-extensions prefs headphone-volume-limiter@brian.local
```

## What's implemented

- Item 1 — threshold: `limit-percent` (1–100), SpinRow in prefs
- Item 2 — action mode: `warn-prompt` / `warn-allow` / `block`
- Item 3 — device targeting: all-headphones / wired-jack / specific
  Bluetooth MAC, picker built from live BlueZ paired-device query
- Item 4 — notifications via `MessageTray`, with an "Allow louder for
  this session" action button on `warn-prompt`
- Item 5 — Quick Settings toggle bound directly to the `enabled` key

## What is NOT yet verified — please test these first

I built and syntax-checked this in a sandbox without a running GNOME
Shell, so **none of the actual shell-integration behavior has been
run live**. The device-detection logic reuses what we validated
against your hardware earlier, but everything shell-specific below is
unverified:

1. **Does it load at all** — `journalctl` will show the exception if
   `enable()` throws. Most likely failure point: `resource:///org/gnome/Shell/Extensions/js/extensionPrefs.js`
   import path in `prefs.js` — I'm fairly confident on this path for
   GNOME 45+ but haven't run it, and it's exactly the kind of detail
   that shifts between shell versions.
2. **Quick Settings toggle placement/behavior** — `addExternalIndicator`
   is the documented API but I haven't confirmed the toggle actually
   renders and binds correctly on your shell version.
3. **The clamp itself** — `stream.volume = X; stream.push_volume();`
   is the standard Gvc pattern, but worth confirming it doesn't fight
   visibly with the OSD volume popup (i.e. does the volume slider
   visibly "snap back" smoothly, or jitter).
4. **The reentrancy guard** (`_isClamping`) — meant to stop our own
   clamp write from re-triggering `_onStreamVolumeChanged`, but Gvc's
   `notify::volume` signal timing under a synchronous property set
   hasn't been confirmed.
5. **BlueZ query timing in prefs.js** — runs synchronously on window
   open via `call_sync`; fine for a handful of devices, untested for
   noticeable UI lag with many paired devices.

## Suggested test sequence

1. Install, confirm it loads (`journalctl`) and prefs opens without errors
2. Toggle Quick Settings switch on/off, confirm `enabled` GSettings key changes:
   `gsettings get org.gnome.shell.extensions.headphone-volume-limiter enabled`
   (may need `--schemadir` flag pointed at the schemas folder if not installed system-wide)
3. Connect your Bluetooth buds, push volume above the default 70% limit,
   confirm it clamps back and a notification appears
4. Click "Allow louder for this session", confirm it stops clamping
   until you disconnect/reconnect the device
5. Switch action mode to `block`, confirm it clamps silently with no notification
6. Switch device mode to "specific" + your Bluetooth device, confirm
   speakers are unaffected while your buds are still capped
