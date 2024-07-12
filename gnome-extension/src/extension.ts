import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
//import Mtk from 'gi://Mtk';
//import Shell from 'gi://Shell';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
// https://gjs.guide/extensions/topics/notifications.html
//import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// TODO: Support remote files and folders and docker containers

// TODO: Implement support for codium, insiders, snap, and flatpak installations

// TODO: Implement support for custom cmd args

interface Workspace {
    uri: string;
    storeDir: Gio.File | null;
}

interface RecentWorkspace {
    name: string;
    path: string;
    softRemove: () => void;
    removeWorkspaceItem: () => void;
}

export default class VSCodeWorkspacesExtension extends Extension {
    gsettings?: Gio.Settings;
    _indicator?: PanelMenu.Button;

    _refreshInterval: number = 300;
    _refreshTimeout: any = null;
    _newWindow: boolean = false;
    _vscodeLocation: string = '';
    _preferCodeWorkspaceFile: boolean = false;
    _debug: boolean = false;

    _recentWorkspacesPath: string = GLib.build_filenamev([
        GLib.get_home_dir(),
        '.config/Code/User/workspaceStorage',
    ]);
    _workspaces: Set<Workspace> = new Set();
    _recentWorkspaces: Set<RecentWorkspace> = new Set();

    // TODO: Implement notifications
    //_messageTray: MessageTray.MessageTray | null = null;
    //_notificationSource: MessageTray.Source | null = null;
    //_notification: MessageTray.Notification | null = null;

    enable() {
        this.gsettings = this.getSettings();

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        // check if the vscode icon exists, or the code icon exists
        // if it doesn't, use the default
        let iconName: string = 'vscode';

        if (!this._iconExists('vscode')) {
            iconName = 'code';
        } else if (!this._iconExists('code')) {
            iconName = 'vscode';
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
    }

    disable() {
        if (this._refreshTimeout) {
            GLib.source_remove(this._refreshTimeout);
            this._refreshTimeout = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = undefined;
        }
        this.gsettings = undefined;
        //this._recentWorkspaces = null;
        //this._workspaces = null;

        // clean up the cache
        this._workspaces.clear();
        this._recentWorkspaces.clear();

        this._log(`VSCode Workspaces Extension disabled`);
    }

    _setSettings() {
        this._newWindow = this.gsettings!.get_value('new-window').deepUnpack() ?? false;
        this._vscodeLocation = this.gsettings!.get_value('vscode-location').deepUnpack() ?? 'code';
        this._refreshInterval = this.gsettings!.get_value('refresh-interval').deepUnpack() ?? 300;
        this._preferCodeWorkspaceFile = this.gsettings!.get_value('prefer-workspace-file').deepUnpack() ?? false;
        this._debug = this.gsettings!.get_value('debug').deepUnpack() ?? false;

        this._log(`VSCode Workspaces Extension enabled`);
        this._log(`New Window: ${this._newWindow}`);
        this._log(`VSCode Location: ${this._vscodeLocation}`);
        this._log(`Refresh Interval: ${this._refreshInterval}`);
        this._log(`Prefer Code Workspace File: ${this._preferCodeWorkspaceFile}`);
        this._log(`Debug: ${this._debug}`);
    }

    _iconExists(iconName: string): boolean {
        const theme = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });
        const iconThemeName = theme.get_string('icon-theme');
        const iconTheme = new Gio.ThemedIcon({ name: iconThemeName });

        try {
            const iconInfo = iconTheme.get_names().filter(icon => icon === iconName);
            return iconInfo !== null;
        } catch (error) {
            logError(error as object, 'Failed to check if icon exists');
            return false;
        }
    }


    _createMenu() {
        if (!this._indicator) return;

        (this._indicator.menu as PopupMenu.PopupMenu).removeAll();

        this._loadRecentWorkspaces();

        const itemSettings = new PopupMenu.PopupSubMenuMenuItem('Settings');
        const itemClearWorkspaces = new PopupMenu.PopupMenuItem('Clear Workspaces');
        itemClearWorkspaces.connect('activate', () => {
            this._clearRecentWorkspaces();
        });

        const itemRefresh = new PopupMenu.PopupMenuItem('Refresh');
        itemRefresh.connect('activate', () => {
            this._createMenu();
        });

        itemSettings.menu.addMenuItem(itemClearWorkspaces);
        itemSettings.menu.addMenuItem(itemRefresh);

        (this._indicator.menu as PopupMenu.PopupMenu).addMenuItem(itemSettings);

        const itemQuit = new PopupMenu.PopupMenuItem('Quit');
        itemQuit.connect('activate', () => {
            this._quit();
        });
        (this._indicator.menu as PopupMenu.PopupMenu).addMenuItem(itemQuit);
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
            const item = new PopupMenu.PopupMenuItem(workspace.name);

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

    _iterateWorkspaceDir(dir: Gio.File, callback: (workspace: Workspace) => void) {
        try {
            // compare the file path with the child paths in the recent workspaces directory
            const enumerator = dir.enumerate_children(
                'standard::*,unix::uid',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let info: Gio.FileInfo | null;

            while ((info = enumerator.next_file(null)) !== null) {
                try {
                    const workspaceStoreDir = enumerator.get_child(info);

                    this._log(`Checking ${workspaceStoreDir.get_path()}`);

                    const workspaceFile = Gio.File.new_for_path(
                        GLib.build_filenamev([workspaceStoreDir.get_path()!, 'workspace.json'])
                    );

                    if (!workspaceFile.query_exists(null)) {
                        this._log(`No workspace.json found in ${workspaceStoreDir.get_path()}`);
                        continue;
                    }

                    // load the contents of the workspace.json file and parse it
                    const [, contents] = workspaceFile.load_contents(null);

                    const decoder = new TextDecoder();

                    const json = JSON.parse(decoder.decode(contents));

                    // Check if the json file has a `folder` property or a `workspace` property - check if the previous item in `workspaceFiles` is the same as the current item
                    // we want to grab the contents either folder or workspace property and check if it's the same as the previous item in `workspaceFiles`
                    // if it is, we want to skip this item
                    // if it isn't, we want to add it to `workspaceFiles`

                    const workspaceURI = (json.folder || json.workspace) as string | undefined;
                    if (!workspaceURI) {
                        this._log('No folder or workspace property found in workspace.json');
                        continue;
                    }

                    this._log(
                        `Found workspace.json in ${workspaceStoreDir.get_path()} with ${workspaceURI}`
                    );

                    const newWorkspace = {
                        uri: workspaceURI,
                        storeDir: workspaceStoreDir,
                    };

                    const pathToWorkspace = Gio.File.new_for_uri(newWorkspace.uri);

                    // check if the file exists and remove it from the list if it doesn't
                    if (!pathToWorkspace.query_exists(null)) {
                        this._log(
                            `Workspace does not exist and will be removed from the list: ${pathToWorkspace.get_path()}`
                        );
                        const deleteRes = this._workspaces.delete(newWorkspace);
                        if (!deleteRes) {
                            this._log(`Failed to remove workspace: ${newWorkspace.uri} from cache - not in cache or cache is empty`);
                        }

                        // Try to delete the workspace directory itself
                        // now remove the workspaceStore directory
                        const trashRes = newWorkspace.storeDir.trash(null);
                        const workspaceName = GLib.path_get_basename(newWorkspace.uri);

                        if (!trashRes) {
                            this._log(`Failed to move ${workspaceName} to trash`);
                            return;
                        }

                        this._log(`Workspace Trashed: ${workspaceName}`);

                        continue;
                    }

                    callback(newWorkspace);
                    // Check if a workspace with the same uri exists
                    const workspaceExists = Array.from(this._workspaces).some(workspace => {
                        return workspace.uri === workspaceURI;
                    });

                    if (workspaceExists) {
                        this._log(`Workspace already exists in recent workspaces: ${workspaceURI}`);
                        continue;
                    }

                    // use a cache to avoid reprocessing the same directory/file
                    if (this._workspaces.has(newWorkspace)) {
                        this._log(`Workspace already exists: ${newWorkspace}`);
                        continue;
                    }

                    this._workspaces.add(newWorkspace);
                } catch (error) {
                    logError(error as object, 'Failed to parse workspace.json');
                    continue;
                }
            }

            const enumCloseRes = enumerator.close(null);

            if (!enumCloseRes) {
                throw new Error('Failed to close enumerator');
            }
        } catch (error) {
            logError(error as object, 'Failed to iterate workspace directory');
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
            const dir = Gio.File.new_for_path(this._recentWorkspacesPath);

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

                recentWorkspaceObject?.softRemove();

                this._recentWorkspaces = new Set(
                    Array.from(this._recentWorkspaces).filter(
                        recentWorkspace => recentWorkspace.path !== workspace.uri
                    )
                );
            });

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
    }

    _clearRecentWorkspaces() {
        this._log('Clearing recent workspaces');

        try {
            if (
                !GLib.file_test(
                    this._recentWorkspacesPath,
                    GLib.FileTest.EXISTS | GLib.FileTest.IS_DIR
                )
            ) {
                throw new Error('Recent workspaces directory does not exist');
            }
            // Create a backup of the directory before deleting it
            const backupPath = `${this._recentWorkspacesPath}.bak`;
            const backupDir = Gio.File.new_for_path(backupPath);
            const recentWorkspacesDir = Gio.File.new_for_path(this._recentWorkspacesPath);

            if (backupDir.query_exists(null)) {
                throw new Error('Backup directory already exists');
            }

            this._log(`Creating backup of ${this._recentWorkspacesPath} to ${backupPath}`);

            const res = recentWorkspacesDir.copy(
                backupDir,
                Gio.FileCopyFlags.OVERWRITE,
                null,
                null
            );

            if (res === null) {
                throw new Error('Failed to create backup');
            }

            this._log('Backup created successfully');

            // Delete the children of the directory
            recentWorkspacesDir.enumerate_children_async(
                'standard::*,unix::uid',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                null,
                (recentWorkspace, recentWorkspaceRes) => {
                    const iter = recentWorkspacesDir.enumerate_children_finish(recentWorkspaceRes);

                    try {
                        let info: Gio.FileInfo | null;

                        while ((info = iter.next_file(null)) !== null) {
                            const file = iter.get_child(info);
                            if (
                                file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !==
                                Gio.FileType.DIRECTORY
                            ) {
                                continue;
                            }

                            this._log(`Deleting ${file.get_path()}`);
                            file.delete(null);
                        }

                        iter.close_async(GLib.PRIORITY_DEFAULT, null, (_iter, _res) => {
                            try {
                                _iter?.close_finish(_res);
                            } catch (error) {
                                logError(error as object, 'Failed to close iterator');
                            }
                        });
                    } catch (error) {
                        logError(error as object, 'Failed to delete recent workspaces');
                    }
                }
            );

            // Purge the cache
            this._workspaces.clear();
            this._recentWorkspaces?.clear();

            // Refresh the menu to reflect the changes

            this._createMenu();
        } catch (e) {
            logError(`Failed to clear recent workspaces: ${e}`);
        }
    }

    _quit() {
        if (this._indicator) {
            this._indicator.destroy();
        }
    }

    _startRefresh() {
        if (this._refreshTimeout) {
            GLib.source_remove(this._refreshTimeout);
            this._refreshTimeout = null;
        }
        this._refreshTimeout = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._refreshInterval,
            () => {
                this._createMenu();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }
}
