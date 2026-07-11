# Headphone Volume Limiter

[![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-45..50-blue?logo=gnome)](https://extensions.gnome.org/)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-green.svg)](LICENSE)

A GNOME Shell extension that caps media volume when headphones (wired or
Bluetooth) are the active audio output — the same hearing-safety feature
found on many phones, now on your desktop.

## Features

| Feature | Description |
|---|---|
| **Volume cap** | Set a maximum volume percentage (1–100%). When headphones exceed it, the extension acts immediately. |
| **Three action modes** | `warn-prompt` — clamp + notification with "Allow anyway" button<br>`warn-allow` — notification only, no clamping<br>`block` — silently clamp, no notification |
| **Device targeting** | Apply the limit to all headphones, or pick one specific Bluetooth device by MAC address. |
| **Quick Settings toggle** | Enable/disable the limiter instantly from the system menu. |
| **Session override** | Click "Allow anyway" on a notification to bypass the limit until you disconnect the device. |
| **Virtual sink passthrough** | Works correctly with EasyEffects and other DSP pipelines that insert virtual sinks between apps and hardware. |

## Screenshots

<!-- TODO: add screenshots of the Quick Settings toggle and Preferences window -->

## Installation

### From GNOME Extensions website (recommended)

Visit [extensions.gnome.org](https://extensions.gnome.org/) and search for
"Headphone Volume Limiter".

### From GitHub Releases

1. Download the latest `headphone-volume-limiter@brian.local-v*.zip` from
   the [Releases page](https://github.com/imnotndesh/headphone-volume-limiter/releases).
2. Install it:

```bash
gnome-extensions install headphone-volume-limiter@brian.local-v*​.zip
```
Restart GNOME Shell (Alt+F2, type r, Enter on X11; log out/in on Wayland).
Enable: gnome-extensions enable headphone-volume-limiter@brian.local

### Manual deployment (development)
```bash
# Clone
git clone https://github.com/imnotndesh/headphone-volume-limiter.git
cd headphone-volume-limiter

# Symlink into extensions directory
ln -s "$(pwd)/headphone-volume-limiter@brian.local" \
      ~/.local/share/gnome-shell/extensions/headphone-volume-limiter@brian.local

# Compile schemas
glib-compile-schemas \
  ~/.local/share/gnome-shell/extensions/headphone-volume-limiter@brian.local/schemas/

# Reload Shell (Alt+F2 → r → Enter) then enable
gnome-extensions enable headphone-volume-limiter@brian.local

```
## Preferences

Open preferences from GNOME Extensions app, or:

```bash
gnome-extensions prefs headphone-volume-limiter@brian.local
```
### Available actions
1. Limit percentage — slider from 1% to 100% (default: 70%)
2. Action mode — warn-prompt, warn-allow, or block
3. Device targeting — all headphones, or one specific Bluetooth device
4. The Quick Settings toggle in the system menu mirrors the enabled setting

## Debugging
To Watch extension logs in real time
```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep headphone-limiter
```