import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import System from 'system';
import { _performance } from './performance.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import { throws } from 'assert';

// TODO: Support remote files and folders and docker containers

// TODO: Implement support for custom cmd args

interface Workspace {
    uri: string;
    storeDir: Gio.File | null;
}

interface RecentWorkspace {
    name: string;
    path: string;
    softRemove: () => void;
    removeWorkspaceItem?: () => void;
}

// Define an interface for memory information
interface MemoryInfo {
    total: number;
    used: number;
    free: number;
    shared: number;
    buffcache: number;
    available: number;
    memoryPressure: number;
}

export default class VSCodeWorkspacesExtension extends Extension {
    gsettings?: Gio.Settings;
    _indicator?: PanelMenu.Button;

    private _refreshInterval: number = 300;
    private _refreshTimeout: number | null = null;
    private _newWindow: boolean = false;
    private _vscodeLocation: string = '';
    private _preferCodeWorkspaceFile: boolean = false;
    private _debug: boolean = false;
    private _gitCacheTTL: number = 300;

    // Make these mutable
    private _targetProcessingTime: number = 500;
    private _maxBatchSize: number = 10;

    private _workspaceTags: Map<string, Set<string>> = new Map();
    private _favoriteWorkspaces: Set<string> = new Set();
    private _defaultTags: string[] = ['work', 'personal', 'archived'];

    private _workspaceGroups: Map<string, {
        name: string;
        workspaces: Set<string>;
        color?: string;
        icon?: string;
        expanded: boolean;
    }> = new Map();

    constructor(metadata: any) {
        super(metadata);
        this._targetProcessingTime = 500;
        this._maxBatchSize = 10;
    }

    // Add all workspace storage paths
    _workspacePaths: string[] = [
        GLib.build_filenamev([GLib.get_home_dir(), '.config/Code/User/workspaceStorage']),
        GLib.build_filenamev([GLib.get_home_dir(), '.config/VSCodium/User/workspaceStorage']),
        GLib.build_filenamev([GLib.get_home_dir(), '.config/Code - Insiders/User/workspaceStorage'])
    ];

    _workspaces: Set<Workspace> = new Set();
    _recentWorkspaces: Set<RecentWorkspace> = new Set();

    // Add cache for git information
    private _gitCache: Map<string, {
        isRepo: boolean;
        remoteUrl: string | null;
        repoInfo: { owner: string; repo: string } | null;
        userName: string | null;
        timestamp: number;
    }> = new Map();

    private _getCachedGitInfo(path: string) {
        const cached = this._gitCache.get(path);
        if (cached && (Date.now() - cached.timestamp) < (this._gitCacheTTL * 1000)) {
            this._log(`Using cached git info for ${path}`);
            return cached;
        }
        return null;
    }

    private _cacheGitInfo(path: string, info: {
        isRepo: boolean;
        remoteUrl: string | null;
        repoInfo: { owner: string; repo: string } | null;
        userName: string | null;
    }) {
        this._log(`Caching git info for ${path}`);
        this._gitCache.set(path, { ...info, timestamp: Date.now() });
    }

    // TODO: Implement notifications
    //_messageTray: MessageTray.MessageTray | null = null;
    //_notificationSource: MessageTray.Source | null = null;
    //_notification: MessageTray.Notification | null = null;

    private _workspaceProcessingQueue: Set<string> = new Set();
    private _batchSize: number = 5; // Process 5 workspaces at a time
    private _processingTimeout: number | null = null;
    private _isProcessing: boolean = false;

    private _processedCount: number = 0;
    private _totalWorkspaces: number = 0;

    private _errors: Array<{ path: string; error: string }> = [];
    private _hasErrors: boolean = false;

    private _isCancelled: boolean = false;
    private readonly _gitOperationTimeout: number = 5000; // 5 second timeout for git operations

    private _lastCleanupTime: number = 0;
    private readonly _cleanupInterval: number = 3600; // 1 hour in seconds
    private _cleanupTimeout: number | null = null;

    private _perfMetrics: {
        workspaceProcessingTime: number[];
        gitOperationTime: number[];
        menuUpdateTime: number[];
        lastProcessingStart: number;
    } = {
            workspaceProcessingTime: [],
            gitOperationTime: [],
            menuUpdateTime: [],
            lastProcessingStart: 0
        };

    private _startPerfMeasurement() {
        this._perfMetrics.lastProcessingStart = _performance();
    }

    private _recordPerfMetric(category: keyof typeof this._perfMetrics, duration: number) {
        if (Array.isArray(this._perfMetrics[category])) {
            (this._perfMetrics[category] as number[]).push(duration);
            // Keep only last 100 measurements
            if ((this._perfMetrics[category] as number[]).length > 100) {
                (this._perfMetrics[category] as number[]).shift();
            }
        }
    }

    private _getAverageMetric(category: keyof typeof this._perfMetrics): number {
        if (!Array.isArray(this._perfMetrics[category])) return 0;
        const metrics = this._perfMetrics[category] as number[];
        if (metrics.length === 0) return 0;
        return metrics.reduce((a, b) => a + b, 0) / metrics.length;
    }

    private _logPerformanceStats() {
        if (!this._debug) return;

        const stats = {
            avgWorkspaceProcessing: this._getAverageMetric('workspaceProcessingTime').toFixed(2),
            avgGitOperation: this._getAverageMetric('gitOperationTime').toFixed(2),
            avgMenuUpdate: this._getAverageMetric('menuUpdateTime').toFixed(2),
            totalWorkspaces: this._workspaces.size,
            cacheSize: this._gitCache.size,
            queueSize: this._workspaceProcessingQueue.size
        };

        this._log('Performance Stats:');
        this._log(`- Avg Workspace Processing: ${stats.avgWorkspaceProcessing}ms`);
        this._log(`- Avg Git Operation: ${stats.avgGitOperation}ms`);
        this._log(`- Avg Menu Update: ${stats.avgMenuUpdate}ms`);
        this._log(`- Total Workspaces: ${stats.totalWorkspaces}`);
        this._log(`- Git Cache Size: ${stats.cacheSize}`);
        this._log(`- Queue Size: ${stats.queueSize}`);
    }

    private _createProgressMenuItem(): PopupMenu.PopupMenuItem {
        const progressItem = new PopupMenu.PopupMenuItem('');
        progressItem.setSensitive(false);

        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });

        const progressText = new St.Label({
            text: `Processing workspaces (${this._processedCount}/${this._totalWorkspaces})...`,
            x_align: Clutter.ActorAlign.START,
        });

        const progressBarBase = new St.Widget({
            style_class: 'progress-bar',
            y_align: Clutter.ActorAlign.CENTER,
            height: 6,
            x_expand: true,
        });

        const progressBarFill = new St.Widget({
            style_class: 'progress-bar-fill',
            height: 6,
        });

        const progress = Math.min(this._processedCount / Math.max(this._totalWorkspaces, 1), 1);
        progressBarFill.set_width(Math.floor(progress * progressBarBase.width));

        progressBarBase.add_child(progressBarFill);
        box.add_child(progressText);
        box.add_child(progressBarBase);
        progressItem.add_child(box);

        return progressItem;
    }

    private _createErrorMenuItem(): PopupMenu.PopupMenuItem {
        const menuItem = new PopupMenu.PopupMenuItem('');
        const subMenu = new PopupMenu.PopupSubMenuMenuItem(_('Errors encountered'));

        const icon = new St.Icon({
            icon_name: 'dialog-warning-symbolic',
            style_class: 'popup-menu-icon'
        });
        subMenu.add_child(icon);

        this._errors.forEach(({ path, error }) => {
            const errorItem = new PopupMenu.PopupMenuItem(GLib.path_get_basename(path));
            errorItem.add_style_class_name('error-item');

            const errorLabel = new St.Label({
                text: error,
                style_class: 'error-description',
                x_align: Clutter.ActorAlign.START
            });
            errorItem.add_child(errorLabel);

            subMenu.menu.addMenuItem(errorItem);
        });

        const retryButton = new PopupMenu.PopupMenuItem(_('Retry failed items'));
        retryButton.connect('activate', () => {
            this._retryFailedWorkspaces();
        });
        subMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        subMenu.menu.addMenuItem(retryButton);

        menuItem.add_child(subMenu);
        return menuItem;
    }

    private async _retryFailedWorkspaces() {
        const failedPaths = this._errors.map(e => e.path);
        this._errors = [];
        this._hasErrors = false;

        for (const path of failedPaths) {
            this._workspaceProcessingQueue.add(path);
        }

        if (this._workspaceProcessingQueue.size > 0) {
            await this._processBatchedWorkspaces();
        }
    }

    private _addError(path: string, error: string) {
        this._logDiagnostic('error', error, path);
        this._errors.push({ path, error });
        this._hasErrors = true;
        this._createMenu(); // Update menu to show error state
    }

    private _cancelProcessing() {
        this._isCancelled = true;
        this._isProcessing = false;
        this._workspaceProcessingQueue.clear();
        if (this._processingTimeout) {
            GLib.source_remove(this._processingTimeout);
            this._processingTimeout = null;
        }
        this._createMenu();
    }

    private readonly _minBatchSize: number = 2;
    private _adaptiveBatchSize: number = 5;

    private _adjustBatchSize(lastBatchDuration: number) {
        // Adjust batch size based on processing time
        if (lastBatchDuration > this._targetProcessingTime * 1.2) { // Too slow
            this._adaptiveBatchSize = Math.max(
                this._minBatchSize,
                Math.floor(this._adaptiveBatchSize * 0.8)
            );
            this._log(`Reducing batch size to ${this._adaptiveBatchSize} due to slow processing`);
        } else if (lastBatchDuration < this._targetProcessingTime * 0.8) { // Too fast
            this._adaptiveBatchSize = Math.min(
                this._maxBatchSize,
                Math.ceil(this._adaptiveBatchSize * 1.2)
            );
            this._log(`Increasing batch size to ${this._adaptiveBatchSize} due to fast processing`);
        }
    }

    private _shouldThrottle(): boolean {
        const avgProcessingTime = this._getAverageMetric('workspaceProcessingTime');
        const avgGitTime = this._getAverageMetric('gitOperationTime');

        // Throttle if either average time is too high
        if (avgProcessingTime > 1000 || avgGitTime > 2000) {
            this._log(`Throttling due to high processing times: workspace=${avgProcessingTime}ms, git=${avgGitTime}ms`);
            return true;
        }

        // Check system memory pressure
        const memInfo = this._getSystemMemoryInfo();
        if (memInfo && memInfo.memoryPressure > 0.8) {
            this._log(`Throttling due to high memory pressure: ${memInfo.memoryPressure}`);
            return true;
        }

        return false;
    }

    private async _processBatchedWorkspaces() {
        this._startPerfMeasurement();
        this._isProcessing = true;
        this._isCancelled = false;
        this._processedCount = 0;
        this._totalWorkspaces = this._workspaceProcessingQueue.size;

        // Apply current performance mode
        this._applyPerformanceMode();
        this._createMenu();

        try {
            while (!this._isCancelled && this._workspaceProcessingQueue.size > 0) {
                const batchStart = _performance();

                // Use adaptive batch size with mode considerations
                const effectiveBatchSize = this._performanceMode === 'memory-saver'
                    ? Math.min(this._adaptiveBatchSize, 3)
                    : this._adaptiveBatchSize;

                const batch = Array.from(this._workspaceProcessingQueue)
                    .slice(0, effectiveBatchSize);

                if (this._shouldThrottle()) {
                    const throttleDelay = this._performanceMode === 'memory-saver' ? 2000 : 1000;
                    await new Promise(resolve =>
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, throttleDelay, () => {
                            resolve(null);
                            return GLib.SOURCE_REMOVE;
                        })
                    );
                }

                await Promise.all(
                    batch.map(async (path) => {
                        if (this._isCancelled) return;

                        const itemStart = _performance();
                        try {
                            const workspaceStoreDir = Gio.File.new_for_path(path);
                            await this._processWorkspaceDir(workspaceStoreDir, (workspace) => {
                                this._workspaces.add(workspace);
                            });
                        } catch (error) {
                            this._log(`Error processing workspace ${path}: ${error}`);
                            if (this._enableDiagnostics) {
                                this._logDiagnostic('error', error instanceof Error ? error.message : String(error), path);
                            }
                            this._addError(path, error instanceof Error ? error.message : String(error));
                        } finally {
                            const itemDuration = _performance() - itemStart;
                            this._recordPerfMetric('workspaceProcessingTime', itemDuration);
                            this._workspaceProcessingQueue.delete(path);
                            this._processedCount++;
                            this._createMenu();
                        }
                    })
                );

                const batchDuration = _performance() - batchStart;
                this._adjustBatchSize(batchDuration);

                // Apply mode-specific delay between batches
                const effectiveDelay = this._performanceMode === 'performance'
                    ? Math.max(50, this._processingDelay / 2)
                    : this._processingDelay;

                await new Promise(resolve =>
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, effectiveDelay, () => {
                        resolve(null);
                        return GLib.SOURCE_REMOVE;
                    })
                );
            }
        } finally {
            if (!this._isCancelled) {
                this._isProcessing = false;
                if (this._enableDiagnostics || this._debug) {
                    this._logPerformanceStats();
                }
                this._createMenu();
            }
        }
    }

    enable() {
        const startTime = _performance();
        this._diagnosticsData.startupTime = startTime;
        this._collectSystemInfo();

        this.gsettings = this.getSettings();

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        // check for vscode, codium, or code icons
        let iconName: string = '';

        if (this._iconExists('vscode')) {
            iconName = 'vscode';
        } else if (this._iconExists('codium')) {
            iconName = 'codium';
        } else if (this._iconExists('vscodium')) {
            iconName = 'vscodium';
        } else if (this._iconExists('com.vscodium.codium')) {
            iconName = 'com.vscodium.codium';
        } else if (this._iconExists('code')) {
            iconName = 'code';
        }

        const icon = new St.Icon({
            icon_name: iconName,
            style_class: 'system-status-icon',
        });

        this._indicator.add_child(icon);

        Main.panel.addToStatusArea(this.metadata.uuid, this._indicator);

        this._startRefresh();
        this._setSettings();
        this._createMenu();

        this.gsettings.connect('changed', () => {
            this._setSettings();
            this._startRefresh();
        });

        this._scheduleCleanup();

        // Schedule workspace cleanup every 24 hours
        GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            24 * 60 * 60, // 24 hours
            () => {
                this._cleanupWorkspaces();
                return GLib.SOURCE_CONTINUE;
            }
        );

        this._loadWorkspaceStats();
        this._loadWorkspaceMetadata();
        this._loadWorkspaceGroups();
    }

    disable() {
        this._cancelProcessing();
        if (this._refreshTimeout) {
            GLib.source_remove(this._refreshTimeout);
            this._refreshTimeout = null;
        }
        if (this._processingTimeout) {
            GLib.source_remove(this._processingTimeout);
            this._processingTimeout = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = undefined;
        }

        if (this._cleanupTimeout) {
            GLib.source_remove(this._cleanupTimeout);
            this._cleanupTimeout = null;
        }

        // Clear all caches and queues
        this.gsettings = undefined;
        this._workspaces.clear();
        this._recentWorkspaces.clear();
        this._gitCache.clear();
        this._workspaceProcessingQueue.clear();

        this._errors = [];
        this._hasErrors = false;

        if (this._prefetchTimeout) {
            GLib.source_remove(this._prefetchTimeout);
            this._prefetchTimeout = null;
        }

        this._prefetchQueue.clear();
        this._prefetchedWorkspaces.clear();

        // Close all open workspaces in stats
        for (const [uri, stats] of this._workspaceStats.entries()) {
            if (stats.lastOpenTime !== null) {
                this._updateWorkspaceStats(uri, 'close');
            }
        }

        // Save stats before disabling
        this._saveWorkspaceStats();
        this._saveWorkspaceMetadata();
        this._saveWorkspaceGroups();

        this._log(`VSCode Workspaces Extension disabled`);
    }

    _setSettings() {
        this._newWindow = this.gsettings!.get_value('new-window').deepUnpack() ?? false;
        this._vscodeLocation = this.gsettings!.get_value('vscode-location').deepUnpack() ?? 'code';
        this._refreshInterval = this.gsettings!.get_value('refresh-interval').deepUnpack() ?? 300;
        this._preferCodeWorkspaceFile = this.gsettings!.get_value('prefer-workspace-file').deepUnpack() ?? false;
        this._debug = this.gsettings!.get_value('debug').deepUnpack() ?? false;
        this._gitCacheTTL = this.gsettings!.get_value('git-cache-ttl').deepUnpack() ?? 300;
        this._performanceMode = this.gsettings!.get_value('performance-mode').deepUnpack() ?? 'balanced';
        this._maxBatchSize = this.gsettings!.get_value('max-batch-size').deepUnpack() ?? 10;
        this._processingDelay = this.gsettings!.get_value('processing-delay').deepUnpack() ?? 100;
        this._enableDiagnostics = this.gsettings!.get_value('enable-diagnostics').deepUnpack() ?? false;

        // Apply performance mode settings
        this._applyPerformanceMode();

        this._log(`VSCode Workspaces Extension enabled`);
        this._log(`New Window: ${this._newWindow}`);
        this._log(`VSCode Location: ${this._vscodeLocation}`);
        this._log(`Refresh Interval: ${this._refreshInterval}`);
        this._log(`Prefer Code Workspace File: ${this._preferCodeWorkspaceFile}`);
        this._log(`Debug: ${this._debug}`);
        this._log(`Git Cache TTL: ${this._gitCacheTTL}`);
        this._log(`Performance Mode: ${this._performanceMode}`);
        this._log(`Max Batch Size: ${this._maxBatchSize}`);
        this._log(`Processing Delay: ${this._processingDelay}ms`);
        this._log(`Diagnostics Enabled: ${this._enableDiagnostics}`);
    }

    private _applyPerformanceMode() {
        switch (this._performanceMode) {
            case 'performance':
                this._adaptiveBatchSize = Math.min(this._maxBatchSize, 10);
                this._gitCacheTTL = 600; // 10 minutes
                this._targetProcessingTime = 300; // Faster target processing
                break;
            case 'memory-saver':
                this._adaptiveBatchSize = Math.min(this._maxBatchSize, 3);
                this._gitCacheTTL = 180; // 3 minutes
                this._targetProcessingTime = 800; // Slower, more memory-friendly
                this._clearGitCache(); // Clear cache on mode change
                break;
            case 'balanced':
            default:
                this._adaptiveBatchSize = Math.min(this._maxBatchSize, 5);
                this._gitCacheTTL = 300; // 5 minutes
                this._targetProcessingTime = 500; // Default target
                break;
        }
    }

    _iconExists(iconName: string): boolean {
        const theme = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });
        const iconThemeName = theme.get_string('icon-theme');
        const iconTheme = new Gio.ThemedIcon({ name: iconThemeName });

        try {
            const iconInfo = iconTheme.get_names().filter(icon => icon === iconName);
            return iconInfo.length > 0
        } catch (error) {
            logError(error as object, 'Failed to check if icon exists');
            return false;
        }
    }


    _createMenu() {
        if (!this._indicator) return;

        const menu = this._indicator.menu as PopupMenu.PopupMenu;
        menu.removeAll();

        // Add groups section
        for (const [groupId, group] of this._workspaceGroups.entries()) {
            if (group.workspaces.size === 0) continue;

            const groupSection = new PopupMenu.PopupSubMenuMenuItem(group.name);

            // Add group header with expand/collapse and color/icon
            if (group.color) {
                groupSection.add_style_class_name('workspace-group');
                groupSection.set_style(`color: ${group.color};`);
            }

            if (group.icon) {
                const icon = new St.Icon({
                    icon_name: group.icon,
                    style_class: 'popup-menu-icon'
                });
                groupSection.insert_child_at_index(icon, 0);
            }

            // Add expand/collapse toggle
            const expandIcon = new St.Icon({
                icon_name: group.expanded ? 'pan-down-symbolic' : 'pan-end-symbolic',
                style_class: 'popup-menu-icon'
            });
            groupSection.insert_child_at_index(expandIcon, 0);

            groupSection.connect('activate', () => {
                this._toggleGroupExpanded(groupId);
            });

            if (group.expanded) {
                // Add workspaces in this group
                let section = new PopupMenu.PopupMenuSection();
                for (const uri of group.workspaces) {
                    this._addWorkspaceMenuItem(section, uri, this._favoriteWorkspaces.has(uri));
                }
                groupSection.menu.addMenuItem(section);
            }

            menu.addMenuItem(groupSection);
        }

        // Add separator if we added any groups
        if (Array.from(this._workspaceGroups.values()).some(g => g.workspaces.size > 0)) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        // Add filter/sort options
        const filterMenu = new PopupMenu.PopupSubMenuMenuItem(_('Filter & Sort'));

        // Tag filters
        const allTags = new Set(
            Array.from(this._workspaceTags.values())
                .flatMap(tags => Array.from(tags))
        );

        if (allTags.size > 0) {
            const tagFilters = new PopupMenu.PopupSubMenuMenuItem(_('Filter by Tag'));
            for (const tag of allTags) {
                const tagItem = new PopupMenu.PopupMenuItem(tag);
                tagItem.connect('activate', () => {
                    this._filterWorkspacesByTag(tag);
                });
                tagFilters.menu.addMenuItem(tagItem);
            }
            filterMenu.menu.addMenuItem(tagFilters);
        }

        // Sort options
        const sortOptions = new PopupMenu.PopupSubMenuMenuItem(_('Sort By'));

        ['Name', 'Last Opened', 'Most Used'].forEach(option => {
            const item = new PopupMenu.PopupMenuItem(_(option));
            item.connect('activate', () => {
                this._sortWorkspaces(option.toLowerCase());
            });
            sortOptions.menu.addMenuItem(item);
        });

        filterMenu.menu.addMenuItem(sortOptions);
        menu.addMenuItem(filterMenu);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Show favorite workspaces first
        if (this._favoriteWorkspaces.size > 0) {
            const favoritesSection = new PopupMenu.PopupMenuSection();
            const favoriteHeader = new PopupMenu.PopupMenuItem(_('Favorites'));
            favoriteHeader.setSensitive(false);
            favoritesSection.addMenuItem(favoriteHeader);

            for (const uri of this._favoriteWorkspaces) {
                this._addWorkspaceMenuItem(favoritesSection, uri, true);
            }

            menu.addMenuItem(favoritesSection);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        if (this._debug) {
            const debugSection = new PopupMenu.PopupSubMenuMenuItem(_('Debug Information'));

            const addDebugRow = (label: string, value: string) => {
                const row = new PopupMenu.PopupMenuItem(`${label}: ${value}`);
                row.setSensitive(false);
                debugSection.menu.addMenuItem(row);
            };

            addDebugRow('Total Workspaces', this._workspaces.size.toString());
            addDebugRow('Cache Size', this._gitCache.size.toString());
            addDebugRow('Queue Size', this._workspaceProcessingQueue.size.toString());
            addDebugRow('Current Batch Size', this._adaptiveBatchSize.toString());
            addDebugRow('Avg Processing Time', `${this._getAverageMetric('workspaceProcessingTime').toFixed(2)}ms`);
            addDebugRow('Avg Git Op Time', `${this._getAverageMetric('gitOperationTime').toFixed(2)}ms`);

            const memInfo = this._getSystemMemoryInfo();
            if (memInfo) {
                addDebugRow('Memory Pressure', `${(memInfo.memoryPressure * 100).toFixed(1)}%`);
            }

            menu.addMenuItem(debugSection);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        // Show errors if any
        if (this._hasErrors) {
            menu.addMenuItem(this._createErrorMenuItem());
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        // Show progress if processing
        if (this._isProcessing) {
            const cancelItem = new PopupMenu.PopupMenuItem(_('Cancel Processing'));
            cancelItem.connect('activate', () => {
                this._cancelProcessing();
            });
            menu.addMenuItem(cancelItem);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addMenuItem(this._createProgressMenuItem());
            return;
        }

        // Add diagnostics menu item
        const diagnosticsItem = new PopupMenu.PopupMenuItem(_('Save Diagnostics Report'));
        diagnosticsItem.connect('activate', () => {
            const reportPath = this._saveDiagnosticsReport();
            if (reportPath) {
                const source = new MessageTray.Source({ title: 'VSCode Workspaces', iconName: 'text-x-generic-symbolic' });
                if (!Main.messageTray.contains(source)) {
                    Main.messageTray.add(source);
                }

                const notification = new MessageTray.Notification(
                    {
                        source: source,
                        title: _('Diagnostics Report Saved'),
                        body: _(`Report saved to: ${reportPath}`)
                    }
                );
                notification.isTransient = true;
                source.addNotification(notification);
            }
        });

        menu.addMenuItem(diagnosticsItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Add workspace statistics submenu
        const statsSubmenu = new PopupMenu.PopupSubMenuMenuItem(_('Workspace Statistics'));

        // Show most active workspaces
        const mostActive = Array.from(this._workspaceStats.entries())
            .sort((a, b) => b[1].openCount - a[1].openCount)
            .slice(0, 5);

        if (mostActive.length > 0) {
            const mostActiveItem = new PopupMenu.PopupMenuItem(_('Most Active Workspaces'));
            mostActiveItem.setSensitive(false);
            statsSubmenu.menu.addMenuItem(mostActiveItem);

            for (const [uri, stats] of mostActive) {
                const workspaceName = GLib.path_get_basename(uri);
                const statsItem = new PopupMenu.PopupMenuItem(
                    `${workspaceName}(${stats.openCount} opens, ${this._formatDuration(stats.totalTimeOpen)} total)`
                );
                statsItem.setSensitive(false);
                statsSubmenu.menu.addMenuItem(statsItem);
            }

            statsSubmenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        // Show peak activity hours
        const peakHours = new Array(24)
            .fill(0)
            .map((_, hour) => ({
                hour,
                count: Array.from(this._workspaceStats.values())
                    .reduce((sum, stats) => sum + stats.hourlyStats[hour], 0)
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 3);

        if (peakHours.length > 0 && peakHours[0].count > 0) {
            const peakHoursItem = new PopupMenu.PopupMenuItem(_('Peak Activity Hours'));
            peakHoursItem.setSensitive(false);
            statsSubmenu.menu.addMenuItem(peakHoursItem);

            for (const { hour, count } of peakHours) {
                const timeString = `${hour.toString().padStart(2, '0')}:00`;
                const statsItem = new PopupMenu.PopupMenuItem(
                    `${timeString}(${count} opens)`
                );
                statsItem.setSensitive(false);
                statsSubmenu.menu.addMenuItem(statsItem);
            }
        }

        menu.addMenuItem(statsSubmenu);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._loadRecentWorkspaces();
    }

    private _addWorkspaceMenuItem(menu: PopupMenu.PopupMenuSection, uri: string, isFavorite: boolean) {
        const workspace = Array.from(this._workspaces)
            .find(w => w.uri === uri);

        if (!workspace) return;

        const name = this._get_name(workspace.uri);
        const item = new PopupMenu.PopupMenuItem(name);

        // Add favorite toggle
        const favoriteIcon = new St.Icon({
            icon_name: isFavorite ? 'starred-symbolic' : 'non-starred-symbolic',
            style_class: 'popup-menu-icon'
        });

        const favoriteButton = new St.Button({
            child: favoriteIcon,
            style_class: 'favorite-button'
        });

        favoriteButton.connect('clicked', () => {
            this._toggleFavorite(uri);
        });

        item.add_child(favoriteButton);

        // Add tags submenu
        const tagMenu = this._createTagMenu(uri);
        item.add_child(tagMenu);

        // Add groups submenu
        const groupMenu = this._createGroupMenu(uri);
        item.add_child(groupMenu);

        menu.addMenuItem(item);
    }

    private _createTagMenu(uri: string): PopupMenu.PopupSubMenuMenuItem {
        const tagMenu = new PopupMenu.PopupSubMenuMenuItem(_('Tags'));

        // Show current tags
        const currentTags = this._workspaceTags.get(uri) || new Set();
        if (currentTags.size > 0) {
            for (const tag of currentTags) {
                const tagItem = new PopupMenu.PopupMenuItem(tag);
                const removeIcon = new St.Icon({
                    icon_name: 'list-remove-symbolic',
                    style_class: 'popup-menu-icon'
                });
                tagItem.add_child(removeIcon);
                tagItem.connect('activate', () => {
                    this._removeTag(uri, tag);
                });
                tagMenu.menu.addMenuItem(tagItem);
            }
            tagMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        // Add new tag option
        const addTagItem = new PopupMenu.PopupMenuItem(_('Add Tag...'));
        addTagItem.connect('activate', () => {
            // Show tag selection dialog
            const dialog = new ModalDialog.ModalDialog();
            const box = new St.BoxLayout({ vertical: true });

            const entry = new St.Entry({
                hint_text: _('Enter tag name...'),
                x_expand: true
            });
            box.add_child(entry);

            // Add default tag suggestions
            const suggestionBox = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style_class: 'tag-suggestions'
            });

            this._defaultTags.forEach(tag => {
                if (!currentTags.has(tag)) {
                    const button = new St.Button({
                        label: tag,
                        style_class: 'tag-suggestion-button'
                    });
                    button.connect('clicked', () => {
                        this._addTag(uri, tag);
                        dialog.close();
                    });
                    suggestionBox.add_child(button);
                }
            });

            box.add_child(suggestionBox);
            dialog.contentLayout.add_child(box);

            dialog.addButton({
                label: _('Cancel'),
                action: () => {
                    dialog.close();
                }
            });

            dialog.addButton({
                label: _('Add'),
                action: () => {
                    const text = entry.get_text().trim();
                    if (text) {
                        this._addTag(uri, text);
                    }
                    dialog.close();
                }
            });

            dialog.open();
        });
        tagMenu.menu.addMenuItem(addTagItem);

        return tagMenu;
    }

    private _createGroupMenu(uri: string): PopupMenu.PopupSubMenuMenuItem {
        const groupMenu = new PopupMenu.PopupSubMenuMenuItem(_('Groups'));

        // Add to existing group options
        for (const [groupId, group] of this._workspaceGroups.entries()) {
            const isInGroup = group.workspaces.has(uri);
            const groupItem = new PopupMenu.PopupMenuItem(group.name);

            if (isInGroup) {
                const removeIcon = new St.Icon({
                    icon_name: 'list-remove-symbolic',
                    style_class: 'popup-menu-icon'
                });
                groupItem.add_child(removeIcon);
                groupItem.connect('activate', () => {
                    this._removeFromGroup(groupId, uri);
                });
            } else {
                const addIcon = new St.Icon({
                    icon_name: 'list-add-symbolic',
                    style_class: 'popup-menu-icon'
                });
                groupItem.add_child(addIcon);
                groupItem.connect('activate', () => {
                    this._addToGroup(groupId, uri);
                });
            }

            groupMenu.menu.addMenuItem(groupItem);
        }

        groupMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Create new group option
        const newGroupItem = new PopupMenu.PopupMenuItem(_('Create New Group...'));
        newGroupItem.connect('activate', () => {
            const dialog = new ModalDialog.ModalDialog();
            const box = new St.BoxLayout({ vertical: true });

            const nameEntry = new St.Entry({
                hint_text: _('Enter group name...'),
                x_expand: true
            });
            box.add_child(nameEntry);

            const colorButton = new St.Button({
                label: _('Select Color'),
                style_class: 'group-color-button'
            });

            const iconButton = new St.Button({
                label: _('Select Icon'),
                style_class: 'group-icon-button'
            });

            const buttonBox = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style_class: 'group-options-box'
            });
            buttonBox.add_child(colorButton);
            buttonBox.add_child(iconButton);
            box.add_child(buttonBox);

            dialog.contentLayout.add_child(box);

            dialog.addButton({
                label: _('Cancel'),
                action: () => dialog.close()
            });

            dialog.addButton({
                label: _('Create'),
                action: () => {
                    const name = nameEntry.get_text().trim();
                    if (name) {
                        const groupId = this._createWorkspaceGroup(name);
                        this._addToGroup(groupId, uri);
                    }
                    dialog.close();
                }
            });

            dialog.open();
        });
        groupMenu.menu.addMenuItem(newGroupItem);

        return groupMenu;
    }

    private _filterWorkspacesByTag(tag: string) {
        // Implementation of tag filtering
        // TODO: this._createMenu();
    }

    private _sortWorkspaces(criteria: string) {
        // Implementation of workspace sorting
        // TODO:this._createMenu();
    }

    _isGitRepo(path: string): boolean {
        const cached = this._getCachedGitInfo(path);
        if (cached !== null) {
            return cached.isRepo;
        }

        try {
            const gitDir = Gio.File.new_for_path(GLib.build_filenamev([path, '.git']));
            const isRepo = gitDir.query_exists(null);
            this._cacheGitInfo(path, {
                isRepo,
                remoteUrl: null,
                repoInfo: null,
                userName: null
            });
            return isRepo;
        } catch (error) {
            this._log(`Error checking if path is git repo: ${error} `);
            return false;
        }
    }

    _getGitRemoteUrl(path: string): string | null {
        const cached = this._getCachedGitInfo(path);
        if (cached !== null && cached.remoteUrl !== null) {
            return cached.remoteUrl;
        }

        try {
            const configFile = Gio.File.new_for_path(GLib.build_filenamev([path, '.git', 'config']));
            if (!configFile.query_exists(null)) {
                this._log(`No git config found at ${path} `);
                this._cacheGitInfo(path, {
                    isRepo: true,
                    remoteUrl: null,
                    repoInfo: null,
                    userName: null
                });
                return null;
            }

            const [, contents] = configFile.load_contents(null);
            const config = new TextDecoder().decode(contents);

            let remoteUrl: string | null = null;

            // Look for the upstream remote first, as it's typically the fork source
            const upstreamMatch = /\[remote "upstream"\][\s\S]*?url = (.+)/.exec(config);
            if (upstreamMatch) {
                this._log(`Found upstream remote: ${upstreamMatch[1]} `);
                remoteUrl = upstreamMatch[1];
            } else {
                // If no upstream, look for origin
                const originMatch = /\[remote "origin"\][\s\S]*?url = (.+)/.exec(config);
                if (originMatch) {
                    this._log(`Found origin remote: ${originMatch[1]} `);
                    remoteUrl = originMatch[1];
                }
            }

            this._cacheGitInfo(path, {
                isRepo: true,
                remoteUrl,
                repoInfo: null,
                userName: null
            });

            return remoteUrl;
        } catch (error) {
            logError(error as object, 'Failed to read git config');
            return null;
        }
    }

    _getRepoInfoFromUrl(url: string): { owner: string; repo: string } | null {
        try {
            // Handle different git URL formats and clean the URL first
            const cleanUrl = decodeURIComponent(url.trim());
            this._log(`Parsing git URL: ${cleanUrl} `);

            // Common patterns for different git hosting services:
            // HTTPS:
            // - GitHub:    https://github.com/owner/repo.git
            // - GitLab:    https://gitlab.com/owner/repo.git
            // - Bitbucket: https://bitbucket.org/owner/repo.git
            // SSH:
            // - GitHub:    git@github.com:owner/repo.git
            // - GitLab:    git@gitlab.com:owner/repo.git
            // - Bitbucket: git@bitbucket.org:owner/repo.git
            // With subgroups:
            // - GitLab:    https://gitlab.com/group/subgroup/repo.git
            //              git@gitlab.com:group/subgroup/repo.git

            let match;
            if (cleanUrl.startsWith('https://')) {
                // Handle HTTPS URLs including subgroups
                match = cleanUrl.match(/https:\/\/[^/]+\/(.+?)\/([^/\s.]+?)(?:\.git)?$/);
                this._log('Matched HTTPS URL format');
            } else if (cleanUrl.startsWith('ssh://')) {
                // Handle SSH URLs with explicit port
                match = cleanUrl.match(/ssh:\/\/(?:[^@]+@)?[^:/]+(?::\d+)?\/(.+?)\/([^/\s.]+?)(?:\.git)?$/);
                this._log('Matched SSH URL format with port');
            } else if (cleanUrl.includes('@')) {
                // Handle SSH URLs with scp-like syntax
                match = cleanUrl.match(/@[^:]+:(.+?)\/([^/\s.]+?)(?:\.git)?$/);
                this._log('Matched SSH URL format');
            }

            if (match) {
                const [, ownerPath, repo] = match;
                // For paths with subgroups, use the last component as owner
                const ownerParts = ownerPath.split('/');
                const owner = ownerParts[ownerParts.length - 1];

                // Normalize and decode owner/repo names
                const normalizedOwner = decodeURIComponent(owner).toLowerCase();
                const normalizedRepo = decodeURIComponent(repo).toLowerCase();

                this._log(`Found repo info - owner: ${normalizedOwner}, repo: ${normalizedRepo}, full path: ${ownerPath} `);
                return {
                    owner: normalizedOwner,
                    repo: normalizedRepo
                };
            }
            this._log(`No match found for git URL: ${cleanUrl} `);
        } catch (error) {
            this._log(`Error parsing git URL: ${error} `);
        }
        return null;
    }

    _getGitUserName(path: string): string | null {
        const cached = this._getCachedGitInfo(path);
        if (cached !== null && cached.userName !== null) {
            return cached.userName;
        }

        try {
            const configFile = Gio.File.new_for_path(GLib.build_filenamev([path, '.git', 'config']));
            if (!configFile.query_exists(null)) {
                this._log(`No local git config found at ${path} `);
                return null;
            }

            const [, contents] = configFile.load_contents(null);
            const config = new TextDecoder().decode(contents);

            let userName: string | null = null;

            // Try to get local git config user name first
            const localUserMatch = /\[user\]\s*name\s*=\s*(.+)/.exec(config);
            if (localUserMatch) {
                userName = localUserMatch[1].trim();
                this._log(`Found local git user: ${userName} `);
            } else {
                // If no local config, try global git config
                const globalConfigPath = GLib.build_filenamev([GLib.get_home_dir(), '.gitconfig']);
                const globalConfigFile = Gio.File.new_for_path(globalConfigPath);
                if (globalConfigFile.query_exists(null)) {
                    const [, globalContents] = globalConfigFile.load_contents(null);
                    const globalConfig = new TextDecoder().decode(globalContents);
                    const globalUserMatch = /\[user\]\s*name\s*=\s*(.+)/.exec(globalConfig);
                    if (globalUserMatch) {
                        userName = globalUserMatch[1].trim();
                        this._log(`Found global git user: ${userName} `);
                    }
                }
            }

            // Update cache with username
            const existingCache = this._getCachedGitInfo(path);
            this._cacheGitInfo(path, {
                isRepo: true,
                remoteUrl: existingCache?.remoteUrl || null,
                repoInfo: existingCache?.repoInfo || null,
                userName
            });

            return userName;
        } catch (error) {
            this._log(`Error reading git user config: ${error} `);
            return null;
        }
    }

    _get_name(workspacePath: string) {
        let path = decodeURIComponent(workspacePath);
        path = path.replace(`file://`, '');

        // Convert path to filesystem path
        const fsPath = path.startsWith('~') ?
            path.replace('~', GLib.get_home_dir()) :
            path;

        // If not a git repository, fallback immediately
        if (!this._isGitRepo(fsPath)) {
            this._log(`Not a git repository: ${fsPath}`);
            path = path.replace(GLib.get_home_dir(), '~');
            const fallbackBasename = GLib.path_get_basename(path);
            this._log(`Using fallback name: ${fallbackBasename}`);
            return fallbackBasename;
        }

        this._log(`Found git repository at ${fsPath}`);
        const remoteUrl = this._getGitRemoteUrl(fsPath);
        if (!remoteUrl) {
            path = path.replace(GLib.get_home_dir(), '~');
            const fallbackBasename = GLib.path_get_basename(path);
            this._log(`Using fallback name: ${fallbackBasename}`);
            return fallbackBasename;
        }

        const repoInfo = this._getRepoInfoFromUrl(remoteUrl);
        if (!repoInfo) {
            path = path.replace(GLib.get_home_dir(), '~');
            const fallbackBasename = GLib.path_get_basename(path);
            this._log(`Using fallback name: ${fallbackBasename}`);
            return fallbackBasename;
        }

        if (!remoteUrl.includes('upstream')) {
            const userName = this._getGitUserName(fsPath);
            if (userName && userName.toLowerCase() !== repoInfo.owner) {
                this._log(`Detected fork: local user ${userName} differs from remote owner ${repoInfo.owner}`);
                return `${repoInfo.owner}/${repoInfo.repo}`;
            }
            this._log(`Not a fork: local user ${userName} matches remote owner ${repoInfo.owner}`);
        } else {
            this._log(`Using upstream git info for workspace name: ${repoInfo.owner}/${repoInfo.repo}`);
            return `${repoInfo.owner}/${repoInfo.repo}`;
        }

        path = path.replace(GLib.get_home_dir(), '~');
        const fallbackBasename = GLib.path_get_basename(path);
        this._log(`Using fallback name: ${fallbackBasename}`);
        return fallbackBasename;
    }

    // Sets up a tooltip for a given actor.
    _addTooltip(actor: PopupMenu.PopupBaseMenuItem, text: string) {
        let tooltip = new St.Label({
            text,
            style_class: 'my-tooltip',
            visible: false
        });

        // Add the tooltip to the top chrome so it stays on top of other UI
        Main.layoutManager.addTopChrome(tooltip);

        // Show the tooltip when the pointer enters the actor
        actor.connect('enter-event', () => {

            let [x, y] = actor.get_transformed_position();

            tooltip.set_position(x, y + actor.height);
            tooltip.show();
        });

        // Hide the tooltip when the pointer leaves the actor
        actor.connect('leave-event', () => {
            tooltip.hide();
        });

        return tooltip;
    }

    _loadRecentWorkspaces() {
        this._getRecentWorkspaces();

        if (this._recentWorkspaces?.size === 0) {
            this._log('No recent workspaces found');
            return;
        }

        // Create a combo_box-like button for the recent workspaces
        const comboBoxButton: St.Button = new St.Button({
            label: 'VSCode Workspaces',
            style_class: 'workspace-combo-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        const comboBoxSubMenu = new PopupMenu.PopupSubMenuMenuItem('Recent Workspaces');
        const comboBoxMenu = comboBoxSubMenu.menu;

        comboBoxButton.connect('clicked', (_button: St.Button) => {
            comboBoxMenu.toggle();
        });

        // Create the PopupMenu for the ComboBox items

        this._recentWorkspaces?.forEach(workspace => {
            const item = new PopupMenu.PopupMenuItem(this._get_name(workspace.path));

            // Add tooltip showing full path
            const tooltipPath = workspace.path.replace('file://', '');

            this._addTooltip(item, tooltipPath);


            const trashIcon = new St.Icon({
                icon_name: 'user-trash-symbolic',
                style_class: 'trash-icon',
            });

            const trashButton = new St.Button({
                child: trashIcon,
                style_class: 'trash-button',
                reactive: true,
                can_focus: true,
                track_hover: true,
            });

            trashButton.connect('enter-event', () => {
                trashIcon.add_style_class_name('trash-icon-hover');
            });

            trashButton.connect('leave-event', () => {
                trashIcon.remove_style_class_name('trash-icon-hover');
            });

            trashButton.connect('clicked', () => {
                workspace.softRemove();
            });

            item.add_child(trashButton);

            item.connect('activate', () => {
                comboBoxButton.label = workspace.name;
                this._openWorkspace(workspace.path);
            });
            comboBoxMenu.addMenuItem(item);
        });

        // Add the ComboBox button to the menu
        const comboBoxMenuItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
        });
        comboBoxMenuItem.actor.add_child(comboBoxButton);
        (this._indicator?.menu as PopupMenu.PopupMenu).addMenuItem(comboBoxMenuItem);

        // Add the ComboBox submenu to the menu
        (this._indicator?.menu as PopupMenu.PopupMenu).addMenuItem(comboBoxSubMenu);
    }

    private async _retryOperation<T>(
        operation: () => Promise<T>,
        maxRetries: number = 3,
        delayMs: number = 1000
    ): Promise<T> {
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error as Error;
                this._log(`Operation failed (attempt ${attempt}/${maxRetries}): ${error}`);

                if (attempt < maxRetries) {
                    await new Promise(resolve => GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT,
                        delayMs,
                        () => {
                            resolve(null);
                            return GLib.SOURCE_REMOVE;
                        }
                    ));
                }
            }
        }

        throw lastError;
    }

    private async _processWorkspaceDir(
        workspaceStoreDir: Gio.File,
        callback: (workspace: Workspace) => void
    ): Promise<void> {
        try {
            const normalizedPath = this._normalizeWorkspacePath(workspaceStoreDir.get_path() || '');
            const pathInfo = await this._getPathInfo(normalizedPath);

            if (!pathInfo.isReadable) {
                this._log(`Cannot read workspace directory: ${normalizedPath}`);
                return;
            }

            this._log(`Checking ${workspaceStoreDir.get_path()}`);

            const workspaceFile = Gio.File.new_for_path(
                GLib.build_filenamev([workspaceStoreDir.get_path()!, 'workspace.json'])
            );

            // Retry reading workspace.json if needed
            const [, contents] = await this._retryOperation(async () => {
                return await new Promise<[boolean, Uint8Array, string]>((resolve, reject) => {
                    workspaceFile.load_contents_async(null, (file, result) => {
                        try {
                            if (!file) {
                                throw new Error("File is null");
                            }
                            resolve(file.load_contents_finish(result));
                        } catch (error) {
                            reject(error);
                        }
                    });
                });
            });

            const decoder = new TextDecoder();
            const json = JSON.parse(decoder.decode(contents));

            const workspaceURI = (json.folder || json.workspace) as string | undefined;
            if (!workspaceURI) {
                this._log('No folder or workspace property found in workspace.json');
                return;
            }

            this._log(
                `Found workspace.json in ${workspaceStoreDir.get_path()} with ${workspaceURI}`
            );

            const newWorkspace = {
                uri: workspaceURI,
                storeDir: workspaceStoreDir,
            };

            const pathToWorkspace = Gio.File.new_for_uri(newWorkspace.uri);

            // Async check for workspace existence
            const exists = await new Promise<boolean>(resolve => {
                pathToWorkspace.query_info_async(
                    'standard::*',
                    Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (file, result) => {
                        try {
                            if (!file) {
                                throw new Error("File is null");
                            }
                            file.query_info_finish(result);
                            resolve(true);
                        } catch {
                            resolve(false);
                        }
                    }
                );
            });

            if (!exists) {
                this._log(
                    `Workspace does not exist and will be removed: ${pathToWorkspace.get_path()}`
                );
                this._workspaces.delete(newWorkspace);
                const trashRes = await new Promise<boolean>(resolve => {
                    workspaceStoreDir.trash_async(GLib.PRIORITY_DEFAULT, null, (file, result) => {
                        try {
                            if (!file) {
                                throw new Error("File is null");
                            }
                            resolve(file.trash_finish(result));
                        } catch {
                            resolve(false);
                        }
                    });
                });

                if (!trashRes) {
                    this._log(`Failed to move workspace to trash: ${workspaceStoreDir.get_path()}`);
                }
                return;
            }

            callback(newWorkspace);

            // Check for duplicate workspaces
            const workspaceExists = Array.from(this._workspaces).some(workspace => {
                return workspace.uri === workspaceURI;
            });

            if (workspaceExists) {
                this._log(`Workspace already exists: ${newWorkspace}`);
                return;
            }

            this._workspaces.add(newWorkspace);
        } catch (error) {
            this._addError(
                workspaceStoreDir.get_path() || 'unknown',
                error instanceof Error ? error.message : String(error)
            );
            throw error; // Propagate error for retry mechanism
        }
    }

    private async _validateWorkspace(workspace: Workspace): Promise<boolean> {
        if (!workspace.storeDir) return false;

        try {
            const pathToWorkspace = Gio.File.new_for_uri(workspace.uri);
            const exists = await this._safeFileOperation(
                () => new Promise<boolean>(resolve => {
                    pathToWorkspace.query_info_async(
                        'standard::*',
                        Gio.FileQueryInfoFlags.NONE,
                        GLib.PRIORITY_DEFAULT,
                        null,
                        (_file, result) => {
                            try {
                                pathToWorkspace.query_info_finish(result);
                                resolve(true);
                            } catch {
                                resolve(false);
                            }
                        }
                    );
                }),
                'Error checking workspace existence'
            );

            if (!exists) {
                this._log(`Invalid workspace detected: ${workspace.uri}`);
                return false;
            }

            // Validate workspace.json exists and is readable
            const workspaceJsonPath = GLib.build_filenamev([workspace.storeDir.get_path()!, 'workspace.json']);
            const workspaceFile = Gio.File.new_for_path(workspaceJsonPath);

            const contents = await this._safeFileOperation(
                () => new Promise<[boolean, Uint8Array]>((resolve, reject) => {
                    workspaceFile.load_contents_async(null, (_file, result) => {
                        try {
                            const [success, data] = workspaceFile.load_contents_finish(result);
                            resolve([success, data]);
                        } catch (error) {
                            reject(error);
                        }
                    });
                }),
                'Error reading workspace.json'
            );

            if (!contents || !contents[0] || contents[1].length === 0) {
                this._log(`Invalid workspace.json for ${workspace.uri}`);
                return false;
            }

            const json = JSON.parse(new TextDecoder().decode(contents[1]));
            return Boolean(json.folder || json.workspace);
        } catch (error) {
            this._log(`Error validating workspace ${workspace.uri}: ${error}`);
            return false;
        }
    }

    private async _cleanupInvalidWorkspaces() {
        const invalidWorkspaces = new Set<Workspace>();

        for (const workspace of this._workspaces) {
            if (!await this._validateWorkspace(workspace)) {
                invalidWorkspaces.add(workspace);
            }
        }

        for (const workspace of invalidWorkspaces) {
            this._log(`Removing invalid workspace: ${workspace.uri}`);
            this._workspaces.delete(workspace);

            if (workspace.storeDir) {
                try {
                    await this._safeFileOperation(
                        () => new Promise<boolean>((resolve, reject) => {
                            workspace.storeDir!.trash_async(
                                GLib.PRIORITY_DEFAULT,
                                null,
                                (_file, result) => {
                                    try {
                                        const success = workspace.storeDir!.trash_finish(result);
                                        resolve(success);
                                    } catch (error) {
                                        reject(error);
                                    }
                                }
                            );
                        }),
                        `Failed to remove invalid workspace ${workspace.uri}`
                    );
                } catch (error) {
                    this._log(`Failed to remove invalid workspace ${workspace.uri}: ${error}`);
                }
            }
        }

        if (invalidWorkspaces.size > 0) {
            this._createMenu();
        }
    }

    private _safeFileOperation<T>(
        operation: () => Promise<T>,
        errorMessage: string
    ): Promise<T | null> {
        try {
            return operation();
        } catch (error) {
            this._log(`${errorMessage}: ${error}`);
            return Promise.resolve(null);
        }
    }

    _log(message: any): void {

        if (!this._debug) {
            return;
        }

        log(`[${this.metadata.name}]: ${message}`);
    }

    _getRecentWorkspaces() {
        try {
            // Iterate through all workspace paths
            for (const path of this._workspacePaths) {
                const dir = Gio.File.new_for_path(path);
                if (dir.query_exists(null)) {
                    this._iterateWorkspaceDir(dir, workspace => {
                        //! This callback checks if the workspace exists and if it is a directory, it checks if there is a `.code-workspace` file in the directory

                        const pathToWorkspace = Gio.File.new_for_uri(workspace.uri);

                        // we will only execute the below if the setting is active

                        if (!this._preferCodeWorkspaceFile) {
                            this._log(`Not preferring code-workspace file - continuing: ${workspace.uri}`);
                            return;
                        }

                        if (
                            pathToWorkspace.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !==
                            Gio.FileType.DIRECTORY
                        ) {
                            this._log(`Not a directory - continuing: ${pathToWorkspace.get_path()}`);
                            return;
                        }

                        // Check if there is a file with a `.code-workspace` extension in the directory

                        // look for children, and find one with the `.code-workspace` extension
                        const enumerator = pathToWorkspace.enumerate_children(
                            'standard::*,unix::uid',
                            Gio.FileQueryInfoFlags.NONE,
                            null
                        );

                        let info: Gio.FileInfo | null;

                        let workspaceFilePath: string | null = null;

                        while ((info = enumerator.next_file(null)) !== null) {
                            const file = enumerator.get_child(info);

                            if (file.get_basename()?.endsWith('.code-workspace')) {
                                workspaceFilePath = file.get_path();
                                break;
                            }
                        }

                        const enumCloseRes = enumerator.close(null);

                        if (!enumCloseRes) {
                            throw new Error('Failed to close enumerator');
                        }

                        this._log(`Checking for ${workspaceFilePath}`);

                        if (!workspaceFilePath) {
                            this._log(`Failed to get workspace file path`);
                            return;
                        }

                        const workspaceFile = Gio.File.new_for_path(workspaceFilePath);
                        if (!workspaceFile.query_exists(null)) {
                            this._log(`No .code-workspace file found in ${workspace.uri} - opening directory`);
                            return;
                        }

                        this._log(`Found .code-workspace file in ${workspace.uri}`);

                        // Check if a workspace with the same uri as the workspaceFile exists
                        const workspaceFileExists = Array.from(this._workspaces).some(_workspace => {
                            return _workspace.uri === workspaceFile.get_uri();
                        });

                        if (!workspaceFileExists) {
                            return;
                        }

                        this._log(`Workspace already exists in recent workspaces -  Removing directory workspace in favour of code-workspace file: ${workspaceFile.get_uri()}`);

                        this._workspaces.delete(workspace);

                        // remove the directory workspace from the cache
                        const recentWorkspaceObject = Array.from(this._recentWorkspaces).find(
                            recentWorkspace => recentWorkspace.path === workspace.uri
                        );

                        // FIXME: recentWorkspaceObject?.softRemove();

                        this._recentWorkspaces = new Set(
                            Array.from(this._recentWorkspaces).filter(
                                recentWorkspace => recentWorkspace.path !== workspace.uri
                            )
                        );
                    });
                } else {
                    this._log(`Workspace path does not exist: ${path}`);
                }
            }

            // sort the workspace files by access time
            this._workspaces = new Set(Array.from(this._workspaces).sort((a, b) => {

                const aInfo = Gio.File.new_for_uri(a.uri).query_info('standard::*,unix::atime', Gio.FileQueryInfoFlags.NONE, null);
                const bInfo = Gio.File.new_for_uri(b.uri).query_info('standard::*,unix::atime', Gio.FileQueryInfoFlags.NONE, null);

                if (!aInfo || !bInfo) {
                    this._log(`No file info found for ${a} or ${b}`);
                    return 0;
                }

                const aAccessTime = aInfo.get_attribute_uint64('unix::atime');
                const bAccessTime = bInfo.get_attribute_uint64('unix::atime');

                if (aAccessTime > bAccessTime) {
                    return -1;
                }

                if (aAccessTime < bAccessTime) {
                    return 1;
                }

                return 0;
            }));
            // this._log the Set of workspaces, given that .values() returns an iterator
            this._log(`[Workspace Cache]: ${Array.from(this._workspaces).map(workspace => workspace.uri)}`);

            this._recentWorkspaces = new Set(
                Array.from(this._workspaces).map(workspace => {
                    let workspaceName = GLib.path_get_basename(workspace.uri);

                    // if there is`.code-workspace` included in the workspaceName, remove it
                    if (workspaceName.endsWith('.code-workspace')) {
                        workspaceName = workspaceName.replace('.code-workspace', '');
                    }

                    return {
                        name: workspaceName,
                        path: workspace.uri,
                        softRemove: () => {
                            this._log(`Moving Workspace to Trash: ${workspaceName}`);
                            // Purge from the recent workspaces
                            this._workspaces.delete(workspace);
                            // Purge from the cache
                            this._recentWorkspaces = new Set(
                                Array.from(this._recentWorkspaces).filter(
                                    recentWorkspace => recentWorkspace.path !== workspace.uri
                                )
                            );

                            // now remove the workspaceStore directory
                            const trashRes = workspace.storeDir?.trash(null);

                            if (!trashRes) {
                                this._log(`Failed to move ${workspaceName} to trash`);
                                return;
                            }

                            this._log(`Workspace Trashed: ${workspaceName}`);

                            // Refresh the menu to reflect the changes
                            this._createMenu();
                        },
                        removeWorkspaceItem: () => {
                            this._log(`Removing workspace: ${workspaceName}`);
                            // Purge from the recent workspaces
                            this._workspaces.delete(workspace);
                            // Purge from the cache
                            this._recentWorkspaces = new Set(
                                Array.from(this._recentWorkspaces).filter(
                                    recentWorkspace => recentWorkspace.path !== workspace.uri
                                )
                            );
                            // now remove the workspace directory
                            workspace.storeDir?.delete(null);
                            this._createMenu();
                        },
                    };
                })
            );

            // this._log the Set of recent workspaces, given that .values() returns an iterator
            this._log(`[Recent Workspaces]: ${Array.from(this._recentWorkspaces).map(workspace => workspace.path)}`);
        } catch (e) {
            logError(e as object, 'Failed to load recent workspaces');
        }
    }

    _launchVSCode(files: string[]): void {
        // TODO: Support custom cmd args
        // TODO: Support remote files and folders
        // code --folder-uri vscode-remote://ssh-remote+user@host/path/to/folder

        this._log(`Launching VSCode with files: ${files.join(', ')}`);

        try {
            let safePaths = '';
            let args = '';
            let isDir = false;

            files.forEach(file => {
                safePaths += `"${file}" `;
                this._log(`File Path: ${file}`);

                if (GLib.file_test(file, GLib.FileTest.IS_DIR)) {
                    this._log(`Found a directory: ${file}`);
                    args = '--folder-uri';
                    isDir = true;
                } else {
                    this._log(`Found a file: ${file}`);
                    args = '--file-uri';
                    isDir = false;
                }
            });

            let newWindow = this._newWindow ? '--new-window' : '';

            if (isDir) {
                newWindow = '--new-window';
            }

            const command = `${this._vscodeLocation} ${newWindow} ${args} ${safePaths}`;
            this._log(`Command to execute: ${command}`);
            GLib.spawn_command_line_async(command);
        } catch (error) {
            logError(error as object, 'Failed to launch VSCode');
        }
    }

    _openWorkspace(workspacePath: string) {
        this._log(`Opening workspace: ${workspacePath}`);
        this._launchVSCode([workspacePath]);

        this._updateWorkspaceState(workspacePath, {
            lastAccessed: Date.now(),
            errors: 0 // Reset error count on successful open
        });

        this._updateWorkspaceStats(workspacePath, 'open');
    }

    _clearRecentWorkspaces() {
        try {
            // Back up and clear all workspace paths
            for (const path of this._workspacePaths) {
                const backupPath = `${path}.bak`;
                const workspacesDir = Gio.File.new_for_path(path);

                if (workspacesDir.query_exists(null)) {
                    this._log(`Creating backup of ${path} to ${backupPath}`);
                    workspacesDir.copy(Gio.File.new_for_path(backupPath), Gio.FileCopyFlags.OVERWRITE, null, null);

                    const enumerator = workspacesDir.enumerate_children(
                        'standard::*',
                        Gio.FileQueryInfoFlags.NONE,
                        null
                    );

                    let info: Gio.FileInfo | null;
                    while ((info = enumerator.next_file(null)) !== null) {
                        const child = enumerator.get_child(info);
                        child?.delete(null);
                    }
                }
            }

            // Clear the workspace sets
            this._workspaces.clear();
            this._recentWorkspaces.clear();

            this._createMenu();
        } catch (error) {
            logError(error as object, 'Failed to clear recent workspaces');
        }
    }

    _quit() {
        if (this._indicator) {
            this._indicator.destroy();
        }
    }

    private _clearGitCache() {
        this._log('Clearing git information cache');
        this._gitCache.clear();
    }

    _startRefresh() {
        if (this._refreshTimeout) {
            GLib.source_remove(this._refreshTimeout);
            this._refreshTimeout = null;
        }

        // Clear error state
        this._errors = [];
        this._hasErrors = false;

        // Clean up invalid workspaces before refreshing
        this._cleanupInvalidWorkspaces().then(() => {
            this._createMenu();
        });

        this._refreshTimeout = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._refreshInterval,
            () => {
                this._clearGitCache();
                this._cleanupInvalidWorkspaces().then(() => {
                    this._createMenu();
                });
                return GLib.SOURCE_CONTINUE;
            }
        );

        // Schedule cleanup if it's been long enough
        const now = Math.floor(Date.now() / 1000);
        if (now - this._lastCleanupTime >= this._cleanupInterval) {
            this._scheduleCleanup();
        }
    }

    private _scheduleCleanup() {
        if (this._cleanupTimeout) {
            GLib.source_remove(this._cleanupTimeout);
        }

        this._cleanupTimeout = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW,
            this._cleanupInterval,
            () => {
                // Only run cleanup when system is idle
                if ((global as any).get_pointer()[2] & Clutter.ModifierType.BUTTON1_MASK) {
                    // If user is interacting, reschedule cleanup
                    return GLib.SOURCE_CONTINUE;
                }

                this._performCleanup();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    private _performCleanup() {
        this._log('Performing memory cleanup...');

        // Clear expired cache entries
        const now = Date.now();
        for (const [path, info] of this._gitCache.entries()) {
            if ((now - info.timestamp) > (this._gitCacheTTL * 1000)) {
                this._gitCache.delete(path);
            }
        }

        // Force garbage collection of unused objects
        System.gc();

        this._lastCleanupTime = Math.floor(Date.now() / 1000);
        this._log('Memory cleanup completed');
    }

    private _diagnosticsData: {
        errors: Array<{
            timestamp: number;
            type: string;
            message: string;
            path?: string;
        }>;
        warnings: Array<{
            timestamp: number;
            type: string;
            message: string;
        }>;
        startupTime?: number;
        lastRefreshTime?: number;
        systemInfo?: {
            gnomeVersion: string;
            extensionVersion: string;
            os: string;
        };
    } = {
            errors: [],
            warnings: []
        };

    private _collectSystemInfo() {
        try {
            // Safe access to config
            let gnomeVersion = 'Unknown';
            try {
                gnomeVersion = Config.PACKAGE_VERSION;
            } catch {
                this._log('Could not determine GNOME version');
            }

            const osRelease = Gio.File.new_for_path('/etc/os-release');
            let osName = 'Unknown';

            if (osRelease.query_exists(null)) {
                const [success, contents] = osRelease.load_contents(null);
                if (success) {
                    const lines = new TextDecoder().decode(contents).split('\n');
                    const prettyName = lines.find(line => line.startsWith('PRETTY_NAME='));
                    if (prettyName) {
                        osName = prettyName.split('=')[1].replace(/"/g, '');
                    }
                }
            }

            this._diagnosticsData.systemInfo = {
                gnomeVersion,
                extensionVersion: this.metadata?.version?.toString() || 'Unknown',
                os: osName
            };
        } catch (error) {
            this._log(`Error collecting system info: ${error}`);
        }
    }

    private _logDiagnostic(type: 'error' | 'warning', message: string, path?: string) {
        const entry = {
            timestamp: Date.now(),
            type: type === 'error' ? 'ERROR' : 'WARNING',
            message,
            ...(path ? { path } : {})
        };

        if (type === 'error') {
            this._diagnosticsData.errors.push(entry);
            // Keep last 100 errors
            if (this._diagnosticsData.errors.length > 100) {
                this._diagnosticsData.errors.shift();
            }
        } else {
            this._diagnosticsData.warnings.push(entry);
            // Keep last 50 warnings
            if (this._diagnosticsData.warnings.length > 50) {
                this._diagnosticsData.warnings.shift();
            }
        }
    }

    private _generateDiagnosticsReport(): string {
        const report = [
            '=== VSCode Workspaces Extension Diagnostics Report ===',
            '',
            '== System Information ==',
            `GNOME Version: ${this._diagnosticsData.systemInfo?.gnomeVersion || 'Unknown'}`,
            `Extension Version: ${this._diagnosticsData.systemInfo?.extensionVersion || 'Unknown'}`,
            `Operating System: ${this._diagnosticsData.systemInfo?.os || 'Unknown'}`,
            '',
            '== Performance Metrics ==',
            `Average Workspace Processing Time: ${this._getAverageMetric('workspaceProcessingTime').toFixed(2)}ms`,
            `Average Git Operation Time: ${this._getAverageMetric('gitOperationTime').toFixed(2)}ms`,
            `Average Menu Update Time: ${this._getAverageMetric('menuUpdateTime').toFixed(2)}ms`,
            `Current Batch Size: ${this._adaptiveBatchSize}`,
            '',
            '== Workspace Statistics ==',
            `Total Workspaces: ${this._workspaces.size}`,
            `Git Cache Size: ${this._gitCache.size}`,
            `Processing Queue Size: ${this._workspaceProcessingQueue.size}`,
            '',
            '== Recent Errors ==',
            ...this._diagnosticsData.errors.slice(-10).map(error =>
                `[${new Date(error.timestamp).toISOString()}] ${error.type}: ${error.message}${error.path ? ` (${error.path})` : ''}`
            ),
            '',
            '== Recent Warnings ==',
            ...this._diagnosticsData.warnings.slice(-10).map(warning =>
                `[${new Date(warning.timestamp).toISOString()}] ${warning.type}: ${warning.message}`
            )
        ].join('\n');

        return report;
    }

    private _saveDiagnosticsReport() {
        try {
            const homeDir = GLib.get_home_dir();
            const timestamp = new Date().toISOString().replace(/:/g, '-');
            const fileName = `vscode-workspaces-diagnostics-${timestamp}.txt`;
            const filePath = GLib.build_filenamev([homeDir, fileName]);

            const file = Gio.File.new_for_path(filePath);
            const report = this._generateDiagnosticsReport();

            const [success, tag] = file.replace_contents(
                new TextEncoder().encode(report),
                null,
                false,
                Gio.FileCreateFlags.NONE,
                null
            );

            if (success) {
                this._log(`Diagnostics report saved to: ${filePath}`);
                return filePath;
            }
        } catch (error) {
            this._log(`Error saving diagnostics report: ${error}`);
        }
        return null;
    }

    private _performanceMode: 'balanced' | 'performance' | 'memory-saver' = 'balanced';
    private _processingDelay: number = 100;
    private _enableDiagnostics: boolean = false;

    private _prefetchQueue: Set<string> = new Set();
    private _prefetchTimeout: number | null = null;
    private _prefetchBatchSize: number = 3;
    private _prefetchedWorkspaces: Map<string, Workspace> = new Map();

    private _schedulePrefetch() {
        if (this._prefetchTimeout) {
            GLib.source_remove(this._prefetchTimeout);
            this._prefetchTimeout = null;
        }

        // Schedule prefetch during idle time
        this._prefetchTimeout = GLib.timeout_add(
            GLib.PRIORITY_LOW,
            1000, // Wait 1 second before starting prefetch
            () => {
                this._prefetchWorkspaces();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    private async _prefetchWorkspaces() {
        if (this._isProcessing || this._prefetchQueue.size === 0) return;

        const batch = Array.from(this._prefetchQueue).slice(0, this._prefetchBatchSize);

        for (const path of batch) {
            if (this._isProcessing) break; // Stop prefetching if processing starts

            try {
                const workspaceStoreDir = Gio.File.new_for_path(path);
                if (!workspaceStoreDir.query_exists(null)) {
                    this._prefetchQueue.delete(path);
                    continue;
                }

                const workspaceFile = Gio.File.new_for_path(
                    GLib.build_filenamev([path, 'workspace.json'])
                );

                const [success, contents] = await this._safeFileOperation(
                    () => new Promise<[boolean, Uint8Array]>((resolve, reject) => {
                        workspaceFile.load_contents_async(null, (_file, result) => {
                            try {
                                const [s, data] = workspaceFile.load_contents_finish(result);
                                resolve([s, data]);
                            } catch (error) {
                                reject(error);
                            }
                        });
                    }),
                    'Error prefetching workspace'
                ) || [false, new Uint8Array()];

                if (!success) {
                    this._prefetchQueue.delete(path);
                    continue;
                }

                const json = JSON.parse(new TextDecoder().decode(contents));
                const workspaceURI = json.folder || json.workspace;

                if (workspaceURI) {
                    this._prefetchedWorkspaces.set(path, {
                        uri: workspaceURI,
                        storeDir: workspaceStoreDir
                    });
                }
            } catch (error) {
                this._log(`Error prefetching workspace at ${path}: ${error}`);
            } finally {
                this._prefetchQueue.delete(path);
            }

            // Add delay between items to prevent system load
            await new Promise(resolve =>
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    resolve(null);
                    return GLib.SOURCE_REMOVE;
                })
            );
        }

        // Schedule next batch if there are more items
        if (this._prefetchQueue.size > 0) {
            this._schedulePrefetch();
        }
    }

    private _addToPrefetchQueue(path: string) {

        let hasWorkspace: boolean = false;

        this._workspaces.forEach(workspace => {
            if (workspace.storeDir?.get_path() === path) {
                this._log(`Workspace already exists in cache: ${path}`);
                hasWorkspace = true;
                return;
            }
        });

        if (!this._prefetchedWorkspaces.has(path) && !hasWorkspace) {
            this._prefetchQueue.add(path);
            this._schedulePrefetch();
        }
    }

    async _iterateWorkspaceDir(dir: Gio.File, callback: (workspace: Workspace) => void) {
        try {
            const promises: Promise<void>[] = [];
            const enumerator = dir.enumerate_children(
                'standard::*,unix::uid',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let info: Gio.FileInfo | null;
            while ((info = enumerator.next_file(null)) !== null) {
                const workspaceStoreDir = enumerator.get_child(info);
                if (workspaceStoreDir) {
                    const path = workspaceStoreDir.get_path()!;

                    // Check if we have this workspace pre-fetched
                    const prefetchedWorkspace = this._prefetchedWorkspaces.get(path);
                    if (prefetchedWorkspace) {
                        callback(prefetchedWorkspace);
                        this._prefetchedWorkspaces.delete(path);
                        continue;
                    }

                    this._workspaceProcessingQueue.add(path);
                    // Add remaining paths to prefetch queue
                    this._addToPrefetchQueue(path);
                }
            }

            const enumCloseRes = enumerator.close(null);
            if (!enumCloseRes) {
                throw new Error('Failed to close enumerator');
            }

            // Start processing the queue
            this._processBatchedWorkspaces();
        } catch (error) {
            logError(error as object, 'Failed to iterate workspace directory');
        }
    }

    private async _resolveRealPath(file: Gio.File): Promise<string | null> {
        try {
            const info = await new Promise<Gio.FileInfo>((resolve, reject) => {
                file.query_info_async(
                    'standard::*,access::*',
                    Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (_file, result) => {
                        try {
                            const info = file.query_info_finish(result);
                            resolve(info);
                        } catch (error) {
                            reject(error);
                        }
                    }
                );
            });

            if (info.get_file_type() === Gio.FileType.SYMBOLIC_LINK) {
                const target = info.get_symlink_target();
                if (target) {
                    const targetFile = Gio.File.new_for_path(target);
                    return this._resolveRealPath(targetFile);
                }
            }

            return file.get_path();
        } catch (error) {
            this._log(`Error resolving real path: ${error}`);
            return null;
        }
    }

    private _normalizeWorkspacePath(path: string): string {
        // Handle URI encoded characters
        let normalized = decodeURIComponent(path);

        // Convert file:// URLs to paths
        if (normalized.startsWith('file://')) {
            normalized = normalized.slice(7);
        }

        // Handle home directory
        if (normalized.startsWith('~')) {
            normalized = GLib.build_filenamev([GLib.get_home_dir(), normalized.slice(1)]);
        }

        // Resolve relative paths
        if (!normalized.startsWith('/')) {
            normalized = GLib.build_filenamev([GLib.get_current_dir(), normalized]);
        }

        // Clean up path separators
        normalized = normalized.replace(/\/+/g, '/');

        return normalized;
    }

    private async _validatePath(path: string): Promise<boolean> {
        try {
            const file = Gio.File.new_for_path(this._normalizeWorkspacePath(path));
            const realPath = await this._resolveRealPath(file);

            if (!realPath) {
                return false;
            }

            const info = await new Promise<Gio.FileInfo>((resolve, reject) => {
                file.query_info_async(
                    'access::*',
                    Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (_file, result) => {
                        try {
                            resolve(file.query_info_finish(result));
                        } catch (error) {
                            reject(error);
                        }
                    }
                );
            });

            return info.get_attribute_boolean('access::can-read');
        } catch (error) {
            this._log(`Error validating path ${path}: ${error}`);
            return false;
        }
    }

    private async _getPathInfo(path: string): Promise<{
        isSymlink: boolean;
        realPath: string | null;
        isReadable: boolean;
        isWritable: boolean;
    }> {
        try {
            const file = Gio.File.new_for_path(this._normalizeWorkspacePath(path));
            const info = await new Promise<Gio.FileInfo>((resolve, reject) => {
                file.query_info_async(
                    'standard::*,access::*,unix::*',
                    Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (_file, result) => {
                        try {
                            resolve(file.query_info_finish(result));
                        } catch (error) {
                            reject(error);
                        }
                    }
                );
            });

            const realPath = await this._resolveRealPath(file);

            return {
                isSymlink: info.get_file_type() === Gio.FileType.SYMBOLIC_LINK,
                realPath,
                isReadable: info.get_attribute_boolean('access::can-read'),
                isWritable: info.get_attribute_boolean('access::can-write')
            };
        } catch (error) {
            this._log(`Error getting path info for ${path}: ${error}`);
            return {
                isSymlink: false,
                realPath: null,
                isReadable: false,
                isWritable: false
            };
        }
    }

    private _workspaceStates: Map<string, {
        lastAccessed: number;
        lastValidated: number;
        errors: number;
        recoveryAttempts: number;
    }> = new Map();

    private _updateWorkspaceState(uri: string, update: Partial<{
        lastAccessed: number;
        lastValidated: number;
        errors: number;
        recoveryAttempts: number;
    }>) {
        const current = this._workspaceStates.get(uri) || {
            lastAccessed: 0,
            lastValidated: 0,
            errors: 0,
            recoveryAttempts: 0
        };

        this._workspaceStates.set(uri, { ...current, ...update });
    }

    private _shouldAttemptRecovery(uri: string): boolean {
        const state = this._workspaceStates.get(uri);
        if (!state) return true;

        // Allow up to 3 recovery attempts per workspace
        if (state.recoveryAttempts >= 3) {
            return false;
        }

        // Only attempt recovery if last attempt was more than 1 hour ago
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        return state.lastValidated < oneHourAgo;
    }

    private async _attemptWorkspaceRecovery(workspace: Workspace): Promise<boolean> {
        if (!workspace.storeDir || !workspace.uri) return false;

        const state = this._workspaceStates.get(workspace.uri);
        if (!state) return false;

        try {
            // Try to repair workspace.json if needed
            const workspaceJsonPath = GLib.build_filenamev([workspace.storeDir.get_path()!, 'workspace.json']);
            const workspaceFile = Gio.File.new_for_path(workspaceJsonPath);

            if (!workspaceFile.query_exists(null)) {
                // Try to recreate workspace.json
                const contents = JSON.stringify({
                    folder: workspace.uri,
                    timestamp: Date.now()
                });

                const [success] = await this._safeFileOperation(
                    () => new Promise<[boolean, string]>((resolve, reject) => {
                        workspaceFile.replace_contents_async(
                            new TextEncoder().encode(contents),
                            null,
                            false,
                            Gio.FileCreateFlags.NONE,
                            null,
                            (_file, result) => {
                                try {
                                    resolve(workspaceFile.replace_contents_finish(result));
                                } catch (error) {
                                    reject(error);
                                }
                            }
                        );
                    }),
                    'Error recreating workspace.json'
                ) || [false, ''];

                if (!success) {
                    return false;
                }
            }

            // Validate the workspace after recovery attempt
            const isValid = await this._validateWorkspace(workspace);

            this._updateWorkspaceState(workspace.uri, {
                lastValidated: Date.now(),
                recoveryAttempts: state.recoveryAttempts + 1,
                errors: isValid ? 0 : state.errors + 1
            });

            return isValid;
        } catch (error) {
            this._log(`Recovery failed for workspace ${workspace.uri}: ${error}`);
            return false;
        }
    }

    private async _cleanupWorkspaces() {
        const now = Date.now();
        const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000);
        const orphanedWorkspaces = new Set<Workspace>();

        for (const workspace of this._workspaces) {
            const state = this._workspaceStates.get(workspace.uri);
            if (!state) continue;

            // Check for workspaces that haven't been accessed in a week and have errors
            if (state.lastAccessed < oneWeekAgo && state.errors > 0) {
                if (this._shouldAttemptRecovery(workspace.uri)) {
                    const recovered = await this._attemptWorkspaceRecovery(workspace);
                    if (!recovered) {
                        orphanedWorkspaces.add(workspace);
                    }
                } else {
                    orphanedWorkspaces.add(workspace);
                }
            }
        }

        // Clean up orphaned workspaces
        for (const workspace of orphanedWorkspaces) {
            this._log(`Cleaning up orphaned workspace: ${workspace.uri}`);
            this._workspaces.delete(workspace);
            this._workspaceStates.delete(workspace.uri);

            if (workspace.storeDir) {
                try {
                    const backupDir = Gio.File.new_for_path(
                        GLib.build_filenamev([GLib.get_home_dir(), '.vscode-workspaces-backup'])
                    );

                    // Create backup directory if it doesn't exist
                    if (!backupDir.query_exists(null)) {
                        backupDir.make_directory_with_parents(null);
                    }

                    // Move to backup instead of deleting
                    const timestamp = new Date().toISOString().replace(/:/g, '-');
                    const backupPath = GLib.build_filenamev([
                        backupDir.get_path()!,
                        `workspace-${timestamp}`
                    ]);

                    await this._safeFileOperation(
                        () => new Promise<boolean>((resolve, reject) => {
                            workspace.storeDir!.move(
                                Gio.File.new_for_path(backupPath),
                                Gio.FileCopyFlags.NONE,
                                null,
                                (_file, result) => {
                                    try {
                                        resolve(true);
                                    } catch (error) {
                                        reject(error);
                                    }
                                }
                            );
                        }),
                        `Failed to backup workspace ${workspace.uri}`
                    );
                } catch (error) {
                    this._log(`Failed to clean up workspace ${workspace.uri}: ${error}`);
                }
            }
        }

        if (orphanedWorkspaces.size > 0) {
            this._createMenu();
        }
    }

    private _workspaceStats: Map<string, {
        openCount: number;
        totalTimeOpen: number;
        lastOpenTime: number | null;
        firstSeen: number;
        lastSeen: number;
        mostCommonHour: number;
        hourlyStats: number[];
    }> = new Map();

    private _updateWorkspaceStats(uri: string, action: 'open' | 'close') {
        const now = Date.now();
        const currentStats = this._workspaceStats.get(uri) || {
            openCount: 0,
            totalTimeOpen: 0,
            lastOpenTime: null,
            firstSeen: now,
            lastSeen: now,
            mostCommonHour: 0,
            hourlyStats: new Array(24).fill(0)
        };

        const currentHour = new Date().getHours();

        if (action === 'open') {
            currentStats.openCount++;
            currentStats.lastOpenTime = now;
            currentStats.hourlyStats[currentHour]++;

            // Update most common hour
            const maxCount = Math.max(...currentStats.hourlyStats);
            currentStats.mostCommonHour = currentStats.hourlyStats.indexOf(maxCount);
        } else if (action === 'close' && currentStats.lastOpenTime) {
            currentStats.totalTimeOpen += now - currentStats.lastOpenTime;
            currentStats.lastOpenTime = null;
        }

        currentStats.lastSeen = now;
        this._workspaceStats.set(uri, currentStats);

        // Save stats periodically
        this._saveWorkspaceStats();
    }

    private async _saveWorkspaceStats() {
        try {
            const statsDir = Gio.File.new_for_path(
                GLib.build_filenamev([GLib.get_home_dir(), '.vscode-workspaces-stats'])
            );

            if (!statsDir.query_exists(null)) {
                statsDir.make_directory_with_parents(null);
            }

            const statsFile = Gio.File.new_for_path(
                GLib.build_filenamev([statsDir.get_path()!, 'workspace-stats.json'])
            );

            const stats = Object.fromEntries(this._workspaceStats.entries());
            await this._safeFileOperation(
                () => new Promise<[boolean, string]>((resolve, reject) => {
                    statsFile.replace_contents_async(
                        new TextEncoder().encode(JSON.stringify(stats, null, 2)),
                        null,
                        false,
                        Gio.FileCreateFlags.NONE,
                        null,
                        (_file, result) => {
                            try {
                                resolve(statsFile.replace_contents_finish(result));
                            } catch (error) {
                                reject(error);
                            }
                        }
                    );
                }),
                'Error saving workspace stats'
            );
        } catch (error) {
            this._log(`Failed to save workspace stats: ${error}`);
        }
    }

    private async _loadWorkspaceStats() {
        try {
            const statsFile = Gio.File.new_for_path(
                GLib.build_filenamev([GLib.get_home_dir(), '.vscode-workspaces-stats', 'workspace-stats.json'])
            );

            if (!statsFile.query_exists(null)) return;

            const [success, contents] = await this._safeFileOperation(
                () => new Promise<[boolean, Uint8Array, string]>((resolve, reject) => {
                    statsFile.load_contents_async(null, (_file, result) => {
                        try {
                            resolve(statsFile.load_contents_finish(result));
                        } catch (error) {
                            reject(error);
                        }
                    });
                }),
                'Error loading workspace stats'
            ) || [false, new Uint8Array()];

            if (success) {
                const stats = JSON.parse(new TextDecoder().decode(contents));
                this._workspaceStats = new Map(Object.entries(stats));
            }
        } catch (error) {
            this._log(`Failed to load workspace stats: ${error}`);
        }
    }

    private _formatDuration(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d`;
        if (hours > 0) return `${hours}h`;
        if (minutes > 0) return `${minutes}m`;
        return `${seconds}s`;
    }

    private async _saveWorkspaceMetadata() {
        try {
            const metadataDir = Gio.File.new_for_path(
                GLib.build_filenamev([GLib.get_home_dir(), '.vscode-workspaces-metadata'])
            );

            if (!metadataDir.query_exists(null)) {
                metadataDir.make_directory_with_parents(null);
            }

            const metadata = {
                tags: Object.fromEntries(
                    Array.from(this._workspaceTags.entries())
                        .map(([uri, tags]) => [uri, Array.from(tags)])
                ),
                favorites: Array.from(this._favoriteWorkspaces)
            };

            const metadataFile = Gio.File.new_for_path(
                GLib.build_filenamev([metadataDir.get_path()!, 'workspace-metadata.json'])
            );

            await this._safeFileOperation(
                () => new Promise<[boolean, string]>((resolve, reject) => {
                    metadataFile.replace_contents_async(
                        new TextEncoder().encode(JSON.stringify(metadata, null, 2)),
                        null,
                        false,
                        Gio.FileCreateFlags.NONE,
                        null,
                        (_file, result) => {
                            try {
                                resolve(metadataFile.replace_contents_finish(result));
                            } catch (error) {
                                reject(error);
                            }
                        }
                    );
                }),
                'Error saving workspace metadata'
            );
        } catch (error) {
            this._log(`Failed to save workspace metadata: ${error}`);
        }
    }

    private async _loadWorkspaceMetadata() {
        try {
            const metadataFile = Gio.File.new_for_path(
                GLib.build_filenamev([GLib.get_home_dir(), '.vscode-workspaces-metadata', 'workspace-metadata.json'])
            );

            if (!metadataFile.query_exists(null)) return;

            const [success, contents] = await this._safeFileOperation(
                () => new Promise<[boolean, Uint8Array, string]>((resolve, reject) => {
                    metadataFile.load_contents_async(null, (_file, result) => {
                        try {
                            resolve(metadataFile.load_contents_finish(result));
                        } catch (error) {
                            reject(error);
                        }
                    });
                }),
                'Error loading workspace metadata'
            ) || [false, new Uint8Array()];

            if (success) {
                const metadata = JSON.parse(new TextDecoder().decode(contents));

                // Load tags
                this._workspaceTags = new Map(
                    Object.entries(metadata.tags)
                        .map(([uri, tags]) => [uri, new Set(tags as string[])])
                );

                // Load favorites
                this._favoriteWorkspaces = new Set(metadata.favorites);
            }
        } catch (error) {
            this._log(`Failed to load workspace metadata: ${error}`);
        }
    }

    private async _saveWorkspaceGroups() {
        try {
            const metadataDir = Gio.File.new_for_path(
                GLib.build_filenamev([GLib.get_home_dir(), '.vscode-workspaces-metadata'])
            );

            if (!metadataDir.query_exists(null)) {
                metadataDir.make_directory_with_parents(null);
            }

            const groups = Object.fromEntries(
                Array.from(this._workspaceGroups.entries())
                    .map(([id, group]) => [id, {
                        ...group,
                        workspaces: Array.from(group.workspaces)
                    }])
            );

            const groupsFile = Gio.File.new_for_path(
                GLib.build_filenamev([metadataDir.get_path()!, 'workspace-groups.json'])
            );

            await this._safeFileOperation(
                () => new Promise<[boolean, string]>((resolve, reject) => {
                    groupsFile.replace_contents_async(
                        new TextEncoder().encode(JSON.stringify(groups, null, 2)),
                        null,
                        false,
                        Gio.FileCreateFlags.NONE,
                        null,
                        (_file, result) => {
                            try {
                                resolve(groupsFile.replace_contents_finish(result));
                            } catch (error) {
                                reject(error);
                            }
                        }
                    );
                }),
                'Error saving workspace groups'
            );
        } catch (error) {
            this._log(`Failed to save workspace groups: ${error}`);
        }
    }

    private async _loadWorkspaceGroups() {
        try {
            const groupsFile = Gio.File.new_for_path(
                GLib.build_filenamev([GLib.get_home_dir(), '.vscode-workspaces-metadata', 'workspace-groups.json'])
            );

            if (!groupsFile.query_exists(null)) return;

            const [success, contents] = await this._safeFileOperation(
                () => new Promise<[boolean, Uint8Array, string]>((resolve, reject) => {
                    groupsFile.load_contents_async(null, (_file, result) => {
                        try {
                            resolve(groupsFile.load_contents_finish(result));
                        } catch (error) {
                            reject(error);
                        }
                    });
                }),
                'Error loading workspace groups'
            ) || [false, new Uint8Array()];

            if (success) {
                const groups = JSON.parse(new TextDecoder().decode(contents));
                this._workspaceGroups = new Map(
                    Object.entries(groups)
                        .map(([id, group]: [string, any]) => [id, {
                            ...group,
                            workspaces: new Set(group.workspaces)
                        }])
                );
            }
        } catch (error) {
            this._log(`Failed to load workspace groups: ${error}`);
        }
    }

    private _toggleFavorite(uri: string) {
        if (this._favoriteWorkspaces.has(uri)) {
            this._favoriteWorkspaces.delete(uri);
        } else {
            this._favoriteWorkspaces.add(uri);
        }
        this._saveWorkspaceMetadata();
        this._createMenu();
    }

    private _addTag(uri: string, tag: string) {
        const tags = this._workspaceTags.get(uri) || new Set();
        tags.add(tag.toLowerCase());
        this._workspaceTags.set(uri, tags);
        this._saveWorkspaceMetadata();
        this._createMenu();
    }

    private _removeTag(uri: string, tag: string) {
        const tags = this._workspaceTags.get(uri);
        if (tags) {
            tags.delete(tag.toLowerCase());
            if (tags.size === 0) {
                this._workspaceTags.delete(uri);
            }
            this._saveWorkspaceMetadata();
            this._createMenu();
        }
    }

    private _createWorkspaceGroup(name: string, icon?: string, color?: string): string {
        const id = `group-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        this._workspaceGroups.set(id, {
            name,
            icon,
            color,
            workspaces: new Set(),
            expanded: true
        });
        this._saveWorkspaceGroups();
        return id;
    }

    private _addToGroup(groupId: string, workspaceUri: string) {
        const group = this._workspaceGroups.get(groupId);
        if (group) {
            // Remove from other groups first
            for (const [otherId, otherGroup] of this._workspaceGroups.entries()) {
                if (otherId !== groupId) {
                    otherGroup.workspaces.delete(workspaceUri);
                }
            }
            group.workspaces.add(workspaceUri);
            this._saveWorkspaceGroups();
            this._createMenu();
        }
    }

    private _removeFromGroup(groupId: string, workspaceUri: string) {
        const group = this._workspaceGroups.get(groupId);
        if (group) {
            group.workspaces.delete(workspaceUri);
            this._saveWorkspaceGroups();
            this._createMenu();
        }
    }

    private _toggleGroupExpanded(groupId: string) {
        const group = this._workspaceGroups.get(groupId);
        if (group) {
            group.expanded = !group.expanded;
            this._saveWorkspaceGroups();
            this._createMenu();
        }
    }

    /**
     * _getSystemMemoryInfo() -> Object|null
     *
     * Runs "free -b" _synchronously_ and returns an object with memory info.
     * The returned object includes properties like total, used, free, and a computed memoryPressure.
     *
     * Example return value:
     * {
     *   total: 16777216000,
     *   used: 5899341312,
     *   free: 4294967296,
     *   shared: 1073741824,
     *   buffcache: 6553600000,
     *   available: 10000000000,
     *   memoryPressure: 0.35  // (used / total)
     * }
     *
     * Returns null on error.
     */
    private _getSystemMemoryInfo(): MemoryInfo | null {
        try {
            // Execute "free -b" synchronously
            const result = GLib.spawn_command_line_sync('free -b');
            if (!result) {
                logError(new Error('Failed to run free command'), '_getSystemMemoryInfo');
                return null;
            }
            const stdout = result[1].toString();
            const lines = stdout.trim().split('\n');
            if (lines.length < 2) {
                logError(new Error('Unexpected output from free command'), '_getSystemMemoryInfo');
                return null;
            }
            // The first line contains headers; the second line (starting with "Mem:") contains memory values.
            const headers = lines[0].trim().split(/\s+/);
            let values = lines[1].trim().split(/\s+/);
            // Remove the "Mem:" prefix
            values.shift();

            // Use a dictionary to temporarily store numeric values keyed by normalized header names.
            const memDict: { [key: string]: number } = {};
            headers.forEach((header, index) => {
                // Normalize header names (e.g. "buff/cache" becomes "buffcache")
                const key = header.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                memDict[key] = parseInt(values[index], 10);
            });

            const total = memDict['total'];
            const used = memDict['used'];
            if (!total || isNaN(total) || !used || isNaN(used)) {
                return null;
            }
            // Compute memory pressure as used/total
            const memoryPressure = used / total;

            // Construct the MemoryInfo object
            const memInfo: MemoryInfo = {
                total: total,
                used: used,
                free: memDict['free'] || 0,
                shared: memDict['shared'] || 0,
                buffcache: memDict['buffcache'] || 0,
                available: memDict['available'] || 0,
                memoryPressure: memoryPressure,
            };

            return memInfo;
        } catch (e) {
            logError(e as object, '_getSystemMemoryInfo failed');
            return null;
        }
    }
}
