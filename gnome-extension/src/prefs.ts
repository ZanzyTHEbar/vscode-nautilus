import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class GnomeRectanglePreferences extends ExtensionPreferences {
    _settings?: Gio.Settings;

    fillPreferencesWindow(window: Adw.PreferencesWindow) {
        this._settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            iconName: 'dialog-information-symbolic',
        });

        // Group for New Window setting
        const newWindowGroup = new Adw.PreferencesGroup({
            title: _('New Window'),
            description: _('Configure whether to open VSCode in a new window'),
        });
        page.add(newWindowGroup);

        const newWindowSwitch = new Adw.SwitchRow({
            title: _('Open in New Window'),
            subtitle: _('Whether to open VSCode in a new window'),
        });
        newWindowGroup.add(newWindowSwitch);

        // Group for VSCode Location
        const vscodeLocationGroup = new Adw.PreferencesGroup({
            title: _('VSCode Location'),
            description: _('Configure the path to your VSCode binary'),
        });
        page.add(vscodeLocationGroup);

        const vscodeLocationEntry = new Gtk.Entry({
            placeholder_text: _('Path to VSCode binary'),
        });
        vscodeLocationGroup.add(vscodeLocationEntry);

        window.add(page);

        // Group for Refresh Interval setting
        const refreshIntervalGroup = new Adw.PreferencesGroup({
            title: _('Refresh Interval'),
            description: _('Configure the refresh interval for the extension'),
        });
        page.add(refreshIntervalGroup);

        const refreshGroupEntry = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 3600,
                step_increment: 1,
            }),
        });
        refreshIntervalGroup.add(refreshGroupEntry);

        // Bind settings
        this._settings!.bind(
            'new-window',
            newWindowSwitch,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        this._settings!.bind(
            'vscode-location',
            vscodeLocationEntry,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );
        this._settings!.bind(
            'refresh-interval',
            refreshGroupEntry,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
    }
}
