/*
 * deviceUtils.js
 *
 * Classification logic validated against real hardware in the prototype
 * scripts (detect-devices.js / list-bluetooth-paired.js) before being
 * ported here. Key findings baked in:
 *
 * - Gvc fires signals with stub/unpopulated stream objects BEFORE the
 *   controller reaches READY. Callers must gate on READY themselves
 *   (handled in extension.js, not here).
 * - stream.get_port() trips a GLib-critical assertion (not a catchable
 *   JS exception) on sinks with no ports at all, e.g. virtual sinks like
 *   "Easy Effects Sink". Always check get_ports().length first.
 * - Bluetooth sinks are named like `bluez_output.78_15_2D_56_69_F4.1` —
 *   underscore-separated MAC in the middle, profile index as suffix.
 * - Per your call: we generalize to "is this headphones vs a speaker"
 *   rather than distinguishing wired-jack specifically, since both wired
 *   and Bluetooth headphones report a port whose id/human-name contains
 *   "headphone"/"headset", while built-in outputs say "speaker"/"hdmi".
 */

/**
 * @returns {{ports: Array, hasPorts: boolean, port: Object|null}}
 */
export function getStreamPortSafely(stream) {
    const ports = stream.get_ports ? stream.get_ports() : [];
    const hasPorts = Array.isArray(ports) && ports.length > 0;
    const port = hasPorts ? stream.get_port() : null;
    return { ports, hasPorts, port };
}

/**
 * Device "kind" classification.
 * @returns {'bluetooth-headphones'|'wired-headphones'|'speaker-or-other'|'virtual'}
 */
export function classifyDeviceKind(stream) {
    const name = (stream.get_name?.() ?? '').toLowerCase();
    const { hasPorts, port } = getStreamPortSafely(stream);

    if (!hasPorts) return 'virtual';

    const portId = (port?.port ?? '').toLowerCase();
    const portHuman = (port?.human_port ?? '').toLowerCase();
    const isBluetooth = name.includes('bluez') || name.includes('bluetooth');
    const looksLikeHeadphones =
        portId.includes('headphone') ||
        portId.includes('headset') ||
        portHuman.includes('headphone') ||
        portHuman.includes('headset') ||
        name.includes('headphone');

    if (isBluetooth) return 'bluetooth-headphones';
    if (looksLikeHeadphones) return 'wired-headphones';
    return 'speaker-or-other';
}

export function isHeadphoneKind(kind) {
    return kind === 'bluetooth-headphones' || kind === 'wired-headphones';
}

/**
 * Extracts the MAC address embedded in a bluez_output sink name.
 * Validated against real hardware: `bluez_output.78_15_2D_56_69_F4.1`
 * -> "78:15:2D:56:69:F4"
 * @returns {string|null}
 */
export function extractBluetoothMac(stream) {
    const name = stream.get_name?.() ?? '';
    const match = name.match(/bluez_output\.([0-9A-Fa-f_]{17})\./);
    if (!match) return null;
    return match[1].replace(/_/g, ':').toUpperCase();
}

/**
 * Stable identifier for a stream, used to match against the
 * "specific-device-id" setting.
 * - Bluetooth: the MAC address.
 * - Wired headphones: the literal string "wired-jack" (there's only
 *   ever one analog jack per machine in practice, so no need for a
 *   more specific id).
 * - Everything else: null (not selectable as a limiter target).
 */
export function getDeviceId(stream, kind) {
    if (kind === 'bluetooth-headphones') return extractBluetoothMac(stream);
    if (kind === 'wired-headphones') return 'wired-jack';
    return null;
}

export function getDeviceLabel(stream) {
    return stream.get_description?.() ?? stream.get_name?.() ?? 'Unknown device';
}
