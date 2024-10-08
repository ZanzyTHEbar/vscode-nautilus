import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class VSCodeWorkspacesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window: Adw.PreferencesWindow) {
        const _settings = this.getSettings();

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
        const vscodeGroup = new Adw.PreferencesGroup({
            title: _('VSCode Settings'),
            description: _('Configure various settings for interacting with VSCode'),
        });

        const vscodeLocation = new Adw.EntryRow({
            title: _('VSCode Location'),
            showApplyButton: true,
            inputPurpose: Gtk.InputPurpose.TERMINAL,
            inputHints: Gtk.InputHints.WORD_COMPLETION,
        });

        const debug = new Adw.SwitchRow({
            title: _('Debug'),
            subtitle: _('Whether to enable debug logging'),
        });

        const preferWorkspaceFile = new Adw.SwitchRow({
            title: _('Prefer Workspace File'),
            subtitle: _('Whether to prefer the workspace file over the workspace directory if a workspace file is present'),
        });

        vscodeGroup.add(vscodeLocation);
        vscodeGroup.add(preferWorkspaceFile);
        vscodeGroup.add(debug);
        page.add(vscodeGroup);

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
        _settings.bind(
            'new-window',
            newWindowSwitch,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        _settings.bind(
            'vscode-location',
            vscodeLocation,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );

        _settings.bind(
            'debug',
            debug,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        _settings.bind(
            'prefer-workspace-file',
            preferWorkspaceFile,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        _settings.bind(
            'refresh-interval',
            refreshGroupEntry,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );

        // Show the window
        // Add the page to the window
        window.add(page);

        window.connect('close-request', () => {
            _settings.apply();
        });
    }
}
