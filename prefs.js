import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Note: prefs.js runs in a separate, sandboxed process from the shell
// (no access to Main, no direct Gvc control instance already running).
// We re-query BlueZ directly here for the device picker, same approach
// validated in list-bluetooth-paired.js.

const BLUEZ_SERVICE = 'org.bluez';
const OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';
const DEVICE_IFACE = 'org.bluez.Device1';
const A2DP_SINK_UUID = '0000110b-0000-1000-8000-00805f9b34fb';

function listPairedAudioBluetoothDevices() {
    try {
        const connection = Gio.DBus.system;
        const [result] = connection.call_sync(
            BLUEZ_SERVICE,
            '/',
            OBJECT_MANAGER_IFACE,
            'GetManagedObjects',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        ).deep_unpack();

        const devices = [];
        for (const [, interfaces] of Object.entries(result)) {
            const props = interfaces[DEVICE_IFACE];
            if (!props) continue;

            const paired = props.Paired?.deep_unpack?.() ?? false;
            if (!paired) continue;

            const name = props.Name?.deep_unpack?.() ?? props.Alias?.deep_unpack?.() ?? 'Unknown device';
            const address = props.Address?.deep_unpack?.() ?? '';
            const icon = props.Icon?.deep_unpack?.() ?? '';
            const uuids = props.UUIDs?.deep_unpack?.() ?? [];

            const looksLikeAudio =
                uuids.some(u => u.toLowerCase() === A2DP_SINK_UUID) ||
                icon.includes('audio') ||
                icon.includes('headset') ||
                icon.includes('headphone');

            if (!looksLikeAudio) continue;
            devices.push({ name, address });
        }
        return devices;
    } catch (e) {
        // BlueZ not running / no bluetooth adapter / D-Bus error — not
        // fatal, just means the picker will only offer the wired jack.
        logError(e, 'headphone-volume-limiter: could not query BlueZ');
        return [];
    }
}

export default class HeadphoneVolumeLimiterPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Headphone Volume Limiter'),
            iconName: 'audio-headphones-symbolic',
        });
        window.add(page);

        const infoGroup = new Adw.PreferencesGroup();
        page.add(infoGroup);
        const infoRow = new Adw.ActionRow({
            title: _('Changes apply immediately'),
            subtitle: _('There is no separate save step — each setting here takes effect as soon as you change it.'),
        });
        infoRow.add_prefix(new Gtk.Image({ iconName: 'emblem-ok-symbolic' }));
        infoGroup.add(infoRow);

        // --- General ---------------------------------------------------
        const generalGroup = new Adw.PreferencesGroup({ title: _('General') });
        page.add(generalGroup);

        const enabledRow = new Adw.SwitchRow({
            title: _('Enabled'),
            subtitle: _('Master switch — also available in Quick Settings'),
        });
        settings.bind('enabled', enabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(enabledRow);

        // --- Threshold (item 1) -----------------------------------------
        const thresholdGroup = new Adw.PreferencesGroup({
            title: _('Volume Limit'),
            description: _('Maximum percentage of the volume bar allowed on headphones'),
        });
        page.add(thresholdGroup);

        const limitAdjustment = new Gtk.Adjustment({
            lower: 1,
            upper: 100,
            stepIncrement: 1,
            pageIncrement: 5,
            value: settings.get_int('limit-percent'),
        });
        const limitRow = new Adw.SpinRow({
            title: _('Limit (%)'),
            adjustment: limitAdjustment,
        });
        settings.bind('limit-percent', limitAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        thresholdGroup.add(limitRow);

        // --- Action mode (item 2) ----------------------------------------
        const actionGroup = new Adw.PreferencesGroup({
            title: _('When the limit is exceeded'),
        });
        page.add(actionGroup);

        const actionModel = new Gtk.StringList();
        const actionOptions = [
            { id: 'warn-prompt', label: _('Warn and clamp back (allow override for this session)') },
            { id: 'warn-allow', label: _('Warn only, allow the volume increase') },
            { id: 'block', label: _('Silently block — no notification') },
        ];
        actionOptions.forEach(opt => actionModel.append(opt.label));

        const actionRow = new Adw.ComboRow({
            title: _('Action'),
            model: actionModel,
        });
        const currentAction = settings.get_string('action-mode');
        actionRow.selected = Math.max(0, actionOptions.findIndex(o => o.id === currentAction));
        actionRow.connect('notify::selected', () => {
            settings.set_string('action-mode', actionOptions[actionRow.selected].id);
        });
        actionGroup.add(actionRow);

        // --- Device targeting (item 3) ------------------------------------
        const deviceGroup = new Adw.PreferencesGroup({
            title: _('Apply to'),
        });
        page.add(deviceGroup);

        const deviceModel = new Gtk.StringList();
        const deviceOptions = [{ id: 'all-headphones', label: _('All headphones (wired + Bluetooth)') }];

        deviceOptions.push({ id: 'wired-jack', label: _('Wired headphone jack only') });

        const pairedDevices = listPairedAudioBluetoothDevices();
        pairedDevices.forEach(d => {
            deviceOptions.push({ id: d.address, label: `${d.name} (Bluetooth)` });
        });

        deviceOptions.forEach(opt => deviceModel.append(opt.label));

        const deviceRow = new Adw.ComboRow({
            title: _('Device'),
            subtitle: pairedDevices.length === 0
                ? _('No paired Bluetooth audio devices found — pair one to see it listed here')
                : '',
            model: deviceModel,
        });

        // Figure out the currently-selected option from settings.
        const currentDeviceMode = settings.get_string('device-mode');
        const currentSpecificId = settings.get_string('specific-device-id');
        let selectedIndex = 0; // default: all-headphones
        if (currentDeviceMode === 'specific') {
            const idx = deviceOptions.findIndex(o => o.id === currentSpecificId);
            selectedIndex = idx >= 0 ? idx : 0;
        }
        deviceRow.selected = selectedIndex;

        deviceRow.connect('notify::selected', () => {
            const chosen = deviceOptions[deviceRow.selected];
            if (chosen.id === 'all-headphones') {
                settings.set_string('device-mode', 'all-headphones');
                settings.set_string('specific-device-id', '');
                settings.set_string('specific-device-label', '');
            } else {
                settings.set_string('device-mode', 'specific');
                // Note: 'wired-jack' matches the id emitted by
                // deviceUtils.getDeviceId() for the analog output;
                // Bluetooth options use the MAC address directly.
                settings.set_string('specific-device-id', chosen.id);
                settings.set_string('specific-device-label', chosen.label);
            }
        });

        deviceGroup.add(deviceRow);

        const refreshButton = new Gtk.Button({
            label: _('Refresh Bluetooth device list'),
            marginTop: 6,
            halign: Gtk.Align.START,
        });
        refreshButton.connect('clicked', () => {
            window.close();
            // Reopening re-runs fillPreferencesWindow with a fresh BlueZ query.
            // (Simplest reliable refresh given ComboRow model rebuilding
            // mid-session is fiddly — acceptable for a v1 prefs UI.)
        });
        const refreshRow = new Adw.ActionRow();
        refreshRow.add_suffix(refreshButton);
        deviceGroup.add(refreshRow);
    }
}
