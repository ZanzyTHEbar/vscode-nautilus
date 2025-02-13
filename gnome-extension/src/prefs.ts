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

        // Add Git Cache Settings group
        const gitCacheGroup = new Adw.PreferencesGroup({
            title: _('Git Cache Settings'),
            description: _('Configure git information caching behavior')
        });
        page.add(gitCacheGroup);

        const gitCacheTTLEntry = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 60,    // Minimum 1 minute
                upper: 3600,  // Maximum 1 hour
                step_increment: 60
            }),
        });

        const gitCacheTTLRow = new Adw.ActionRow({
            title: _('Git Cache TTL'),
            subtitle: _('Time in seconds to cache git repository information'),
            activatable_widget: gitCacheTTLEntry
        });
        gitCacheTTLRow.add_suffix(gitCacheTTLEntry);
        gitCacheGroup.add(gitCacheTTLRow);

        // Add Performance Settings group
        const performanceGroup = new Adw.PreferencesGroup({
            title: _('Performance Settings'),
            description: _('Configure performance and resource usage')
        });
        page.add(performanceGroup);

        // Performance Mode dropdown
        const performanceModeRow = new Adw.ComboRow({
            title: _('Performance Mode'),
            subtitle: _('Adjust performance settings based on your system capabilities'),
            model: new Gtk.StringList({
                strings: ['balanced', 'performance', 'memory-saver']
            })
        });
        performanceGroup.add(performanceModeRow);

        // Max Batch Size
        const maxBatchSizeEntry = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 2,
                upper: 20,
                step_increment: 1
            }),
        });

        const maxBatchSizeRow = new Adw.ActionRow({
            title: _('Maximum Batch Size'),
            subtitle: _('Maximum number of workspaces to process simultaneously'),
            activatable_widget: maxBatchSizeEntry
        });
        maxBatchSizeRow.add_suffix(maxBatchSizeEntry);
        performanceGroup.add(maxBatchSizeRow);

        // Processing Delay
        const processingDelayEntry = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 50,
                upper: 1000,
                step_increment: 50
            }),
        });

        const processingDelayRow = new Adw.ActionRow({
            title: _('Processing Delay'),
            subtitle: _('Delay in milliseconds between processing batches'),
            activatable_widget: processingDelayEntry
        });
        processingDelayRow.add_suffix(processingDelayEntry);
        performanceGroup.add(processingDelayRow);

        // Enable Diagnostics switch
        const diagnosticsRow = new Adw.SwitchRow({
            title: _('Enable Diagnostics'),
            subtitle: _('Collect diagnostic information for troubleshooting')
        });
        performanceGroup.add(diagnosticsRow);

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

        _settings.bind(
            'git-cache-ttl',
            gitCacheTTLEntry,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );

        _settings.bind(
            'performance-mode',
            performanceModeRow,
            'selected',
            Gio.SettingsBindFlags.DEFAULT
        );

        _settings.bind(
            'max-batch-size',
            maxBatchSizeEntry,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );

        _settings.bind(
            'processing-delay',
            processingDelayEntry,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );

        _settings.bind(
            'enable-diagnostics',
            diagnosticsRow,
            'active',
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
