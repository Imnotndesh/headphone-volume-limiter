import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import { QuickToggle, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';

/*
 * Inlined from deviceUtils.js
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
function getStreamPortSafely(stream) {
    const ports = stream.get_ports ? stream.get_ports() : [];
    const hasPorts = Array.isArray(ports) && ports.length > 0;
    const port = hasPorts ? stream.get_port() : null;
    return { ports, hasPorts, port };
}

/**
 * Device "kind" classification.
 * @returns {'bluetooth-headphones'|'wired-headphones'|'speaker-or-other'|'virtual'}
 */
function classifyDeviceKind(stream) {
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

function isHeadphoneKind(kind) {
    return kind === 'bluetooth-headphones' || kind === 'wired-headphones';
}

/**
 * Extracts the MAC address embedded in a bluez_output sink name.
 * Validated against real hardware: `bluez_output.78_15_2D_56_69_F4.1`
 * -> "78:15:2D:56:69:F4"
 * @returns {string|null}
 */
function extractBluetoothMac(stream) {
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
function getDeviceId(stream, kind) {
    if (kind === 'bluetooth-headphones') return extractBluetoothMac(stream);
    if (kind === 'wired-headphones') return 'wired-jack';
    return null;
}

function getDeviceLabel(stream) {
    return stream.get_description?.() ?? stream.get_name?.() ?? 'Unknown device';
}

imports.gi.versions.Gvc = '1.0';
const { Gvc } = imports.gi;

const NOTIFICATION_SOURCE_TITLE = 'Headphone Volume Limiter';

const HeadphoneLimiterToggle = GObject.registerClass(
class HeadphoneLimiterToggle extends QuickToggle {
    _init(settings) {
        super._init({
            title: _('Volume Limiter'),
            iconName: 'audio-headphones-symbolic',
            toggleMode: true,
        });

        this._settings = settings;
        this._settings.bind(
            'enabled',
            this,
            'checked',
            Gio.SettingsBindFlags.DEFAULT
        );
    }
});

const HeadphoneLimiterIndicator = GObject.registerClass(
class HeadphoneLimiterIndicator extends SystemIndicator {
    _init(settings) {
        super._init();
        this.quickSettingsItems.push(new HeadphoneLimiterToggle(settings));
    }
});

export default class HeadphoneVolumeLimiterExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // --- Quick Settings toggle (item 5) ---
        this._indicator = new HeadphoneLimiterIndicator(this._settings);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        // --- Notification source (item 4) ---
        this._notifSource = null;

        // --- Session-only "allow anyway" overrides ---
        // Keyed by device id (mac / "wired-jack"). Cleared whenever that
        // device disconnects, intentionally NOT persisted to GSettings —
        // an override should not silently survive a reboot.
        this._sessionOverrides = new Set();

        // --- Reentrancy guard for our own clamp writes ---
        this._isClamping = false;

        // --- Gvc control setup ---
        this._isReady = false;
        this._streamSignalIds = new Map(); // streamId -> handler id
        this._activeStreamId = null;

        this._control = new Gvc.MixerControl({ name: 'headphone-volume-limiter' });

        this._stateChangedId = this._control.connect('state-changed', (control, state) => {
            if (state === Gvc.MixerControlState.READY) {
                this._isReady = true;
                this._attachAllStreams();
                this._onActiveOutputChanged(this._control.get_default_sink());
            }
        });

        this._outputAddedId = this._control.connect('output-added', (control, id) => {
            if (!this._isReady) return;
            const uiDevice = control.lookup_output_id(id);
            if (!uiDevice) return;
            // GvcMixerUIDevice has a 'stream-id' property pointing to the real stream
            const streamId = uiDevice.stream_id;  // or uiDevice.get_stream_id?.()
            const stream = control.lookup_stream_id(streamId);
            if (stream instanceof Gvc.MixerSink) {
                this._attachStream(stream);
            }
        });

        this._outputRemovedId = this._control.connect('output-removed', (control, id) => {
            const uiDevice = control.lookup_output_id(id);
            if (uiDevice) {
                const streamId = uiDevice.stream_id;
                this._detachStreamById(streamId);
            }
        });

        this._activeUpdateId = this._control.connect('active-output-update', (control, id) => {
            if (!this._isReady) return;
            const stream = control.lookup_stream_id(id);
            this._onActiveOutputChanged(stream);
        });

        this._control.open();

        // --- Debug hooks, callable from Looking Glass (Alt+F2 -> 'lg') ---
        // e.g. global.headphoneLimiterDebug.testWarnPrompt()
        // Not shipped-quality API, just for us to isolate bugs without
        // needing real hardware events for every test.
        global.headphoneLimiterDebug = {
            getState: () => ({
                isReady: this._isReady,
                activeStreamId: this._activeStreamId,
                trackedStreams: [...this._streamSignalIds.keys()],
                sessionOverrides: [...this._sessionOverrides],
                settings: {
                    enabled: this._settings.get_boolean('enabled'),
                    limitPercent: this._settings.get_int('limit-percent'),
                    actionMode: this._settings.get_string('action-mode'),
                    deviceMode: this._settings.get_string('device-mode'),
                    specificDeviceId: this._settings.get_string('specific-device-id'),
                },
            }),
            inspectActiveStream: () => {
                const id = this._activeStreamId;
                const stream = id != null ? this._control.lookup_output_id(id) : null;
                if (!stream) {
                    return { activeStreamId: id, found: false, note: 'lookup_output_id returned null/undefined' };
                }
                return {
                    activeStreamId: id,
                    found: true,
                    constructorName: stream.constructor?.name ?? '(unknown)',
                    isMixerStream: stream instanceof Gvc.MixerStream,
                    hasPushVolume: typeof stream.push_volume === 'function',
                    hasSetVolume: typeof stream.set_volume === 'function',
                    currentVolume: stream.get_volume?.() ?? '(no get_volume)',
                };
            },
            inspectDefaultSink: () => {
                const stream = this._control.get_default_sink();
                if (!stream) return { found: false };
                return {
                    found: true,
                    id: stream.get_id(),
                    constructorName: stream.constructor?.name ?? '(unknown)',
                    isMixerStream: stream instanceof Gvc.MixerStream,
                    hasPushVolume: typeof stream.push_volume === 'function',
                };
            },
            listAllStreamsClassified: () => {
                const out = [];
                for (const { stream } of this._streamSignalIds.values()) {
                    out.push({
                        id: stream.get_id(),
                        name: stream.get_name?.(),
                        description: stream.get_description?.(),
                        kind: classifyDeviceKind(stream),
                    });
                }
                return out;
            },
            testWarnPrompt: () => this._notifyWithAllowAction('Test Device', 70, 'test-device-id'),
            testWarnAllow: () => this._notify('Test: Volume above 70% on Test Device', 'Allowed, but exceeds your configured limit.'),
            testBasicNotify: () => this._notify('Test notification', 'If you see this, MessageTray works.'),
            forceClampActiveStream: (percent = 50) => {
                const stream = this._control.lookup_output_id(this._activeStreamId);
                if (!stream) {
                    log('[headphone-limiter debug] no active stream to clamp');
                    return 'no active stream';
                }
                if (typeof stream.push_volume !== 'function') {
                    return `stream found (id=${this._activeStreamId}, ctor=${stream.constructor?.name}) but push_volume is not a function on it — run inspectActiveStream() for details`;
                }
                const maxNorm = this._control.get_vol_max_norm();
                const target = Math.round((percent / 100) * maxNorm);
                this._clampVolume(stream, target);
                return `clamped active stream to ${percent}% (raw ${target}/${maxNorm})`;
            },
        };
    }

    disable() {
        for (const [, handlerId] of this._streamSignalIds) {
            // handlerId here is {stream, id} — see _attachStream
        }
        for (const entry of this._streamSignalIds.values()) {
            try {
                entry.stream.disconnect(entry.id);
            } catch (e) {
                // stream may already be gone
            }
        }
        this._streamSignalIds.clear();

        if (this._control) {
            if (this._stateChangedId) this._control.disconnect(this._stateChangedId);
            if (this._outputAddedId) this._control.disconnect(this._outputAddedId);
            if (this._outputRemovedId) this._control.disconnect(this._outputRemovedId);
            if (this._activeUpdateId) this._control.disconnect(this._activeUpdateId);
            this._control.close();
            this._control = null;
        }

        if (this._indicator) {
            this._indicator.quickSettingsItems.forEach(item => item.destroy());
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._notifSource) {
            this._notifSource.destroy();
            this._notifSource = null;
        }

        this._sessionOverrides.clear();
        this._settings = null;
        delete global.headphoneLimiterDebug;
    }

    // --- Stream tracking -----------------------------------------------

    _attachAllStreams() {
        const sinks = this._control.get_sinks();
        for (const stream of sinks) {
            this._attachStream(stream);
        }
    }

    _attachStream(stream) {
        if (!stream) return;
        const id = stream.get_id();
        if (this._streamSignalIds.has(id)) return; // already attached

        const handlerId = stream.connect('notify::volume', () => {
            this._onStreamVolumeChanged(stream);
        });
        this._streamSignalIds.set(id, { stream, id: handlerId });
    }

    _detachStreamById(id) {
        const entry = this._streamSignalIds.get(id);
        if (entry) {
            try {
                entry.stream.disconnect(entry.id);
            } catch (e) {
                // ignore
            }
            this._streamSignalIds.delete(id);
        }

        // If the device that just disconnected had a session override,
        // clear it — reconnecting later should re-apply the configured limit.
        this._sessionOverrides.clear();
    }

    _onActiveOutputChanged(stream) {
        if (!stream) {
            this._activeStreamId = null;
            return;
        }
        this._activeStreamId = stream.get_id();
        // Re-check immediately: switching TO headphones while volume is
        // already above the limit should clamp right away, not wait for
        // the next volume change.
        this._onStreamVolumeChanged(stream);
    }

    // --- Enforcement (item 1, 2) ----------------------------------------

    _findConnectedHeadphoneStream() {
        for (const { stream } of this._streamSignalIds.values()) {
            try {
                const kind = classifyDeviceKind(stream);
                if (isHeadphoneKind(kind)) return stream;
            } catch (e) {
                // stream may have just been removed
            }
        }
        return null;
    }

    _onStreamVolumeChanged(stream) {
        if (this._isClamping) return; // ignore our own writes
        if (!this._settings.get_boolean('enabled')) {
            log('[headphone-limiter] enabled=false, skipping');
            return;
        }
        if (stream.get_id() !== this._activeStreamId) {
            log(`[headphone-limiter] stream id ${stream.get_id()} is not active stream (${this._activeStreamId}), skipping`);
            return;
        }

        const kind = classifyDeviceKind(stream);
        let effectiveDeviceId = getDeviceId(stream, kind);

        if (!isHeadphoneKind(kind)) {
            if (kind === 'virtual') {
                // Virtual passthrough sinks (EasyEffects, etc.) can be the
                // actual "default sink" the OS volume slider controls,
                // sitting between apps and the real hardware output.
                // Confirmed on real hardware: with EasyEffects active,
                // notify::volume fires on the virtual sink, not the
                // Bluetooth device directly, so classifying only the
                // active stream itself misses this entirely.
                //
                // Heuristic: if ANY currently-connected output is
                // headphone-kind, assume that's where this virtual sink's
                // audio is actually headed, and still apply the limit —
                // clamping the virtual stream, since that's what the
                // user-facing volume control actually represents.
                // LIMITATION: this can misfire if a headphone device is
                // connected but NOT actually the virtual sink's routing
                // target (e.g. multiple simultaneous outputs). Good
                // enough for the common single-output case.
                const connectedHeadphone = this._findConnectedHeadphoneStream();
                if (!connectedHeadphone) {
                    log(`[headphone-limiter] stream classified as '${kind}', no headphone device currently connected, skipping`);
                    return;
                }
                log(`[headphone-limiter] stream classified as '${kind}' but headphone device ${getDeviceLabel(connectedHeadphone)} is connected — treating as headphone passthrough`);
                effectiveDeviceId = getDeviceId(connectedHeadphone, classifyDeviceKind(connectedHeadphone));
            } else {
                log(`[headphone-limiter] stream classified as '${kind}', not headphones, skipping`);
                return;
            }
        }

        const deviceId = effectiveDeviceId;

        const deviceMode = this._settings.get_string('device-mode');
        if (deviceMode === 'specific') {
            const target = this._settings.get_string('specific-device-id');
            if (deviceId !== target) {
                log(`[headphone-limiter] device-mode=specific, deviceId ${deviceId} != target ${target}, skipping`);
                return;
            }
        }

        if (deviceId && this._sessionOverrides.has(deviceId)) {
            log(`[headphone-limiter] session override active for ${deviceId}, skipping`);
            return;
        }

        const limitPercent = this._settings.get_int('limit-percent');
        const maxNorm = this._control.get_vol_max_norm();
        const limitVolume = Math.round((limitPercent / 100) * maxNorm);

        const currentVolume = stream.get_volume();
        log(`[headphone-limiter] currentVolume=${currentVolume} limitVolume=${limitVolume} (${limitPercent}% of ${maxNorm})`);
        if (currentVolume <= limitVolume) {
            log('[headphone-limiter] within limit, nothing to do');
            return;
        }

        const actionMode = this._settings.get_string('action-mode');
        const label = getDeviceLabel(stream);
        log(`[headphone-limiter] over limit — actionMode=${actionMode}`);

        if (actionMode === 'warn-allow') {
            log('[headphone-limiter] calling _notify() for warn-allow');
            this._notify(
                `Volume above ${limitPercent}% on ${label}`,
                'Allowed, but this exceeds your configured headphone limit.'
            );
            return; // do not clamp
        }

        // Both 'block' and 'warn-prompt' clamp back down.
        this._clampVolume(stream, limitVolume);

        if (actionMode === 'block') {
            return; // silent, no notification per spec item 2
        }

        // warn-prompt: notify with an "Allow anyway" action
        this._notifyWithAllowAction(label, limitPercent, deviceId);
    }

    _clampVolume(stream, targetVolume) {
        this._isClamping = true;
        try {
            stream.volume = targetVolume;
            stream.push_volume();
        } finally {
            this._isClamping = false;
        }
    }

    // --- Notifications (item 4) ------------------------------------------

    _getNotifSource() {
        if (this._notifSource) return this._notifSource;

        this._notifSource = new MessageTray.Source({
            title: NOTIFICATION_SOURCE_TITLE,
            iconName: 'audio-headphones-symbolic',
        });
        Main.messageTray.add(this._notifSource);
        this._notifSource.connect('destroy', () => {
            this._notifSource = null;
        });
        return this._notifSource;
    }

    _notify(title, body) {
        const source = this._getNotifSource();
        const notification = new MessageTray.Notification({
            source,
            title,
            body,
        });
        source.addNotification(notification);
    }

    _notifyWithAllowAction(deviceLabel, limitPercent, deviceId) {
        const source = this._getNotifSource();
        const notification = new MessageTray.Notification({
            source,
            title: `Volume limited to ${limitPercent}% on ${deviceLabel}`,
            body: 'This device is capped by your headphone volume limiter.',
        });

        if (deviceId) {
            notification.addAction('Allow louder for this session', () => {
                this._sessionOverrides.add(deviceId);
            });
        }

        source.addNotification(notification);
    }
}
